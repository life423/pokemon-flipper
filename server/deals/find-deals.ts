import { searchListings } from "../ebay/listings.ts";
import { readSearchWithAi } from "../search/query-assistance.ts";
import { cardMismatch, gradingMatches, titleMatches, setMatches } from "../search/relevance.ts";
import { readTitleByRules, readTitleWithoutAi } from "../ai/title-reader.ts";
import type { ListingSummary, SearchIntent, Targets } from "../../shared/types.ts";
import { criteriaMismatch, marketplaceQuery, searchAttributes } from "../../shared/search-criteria.ts";
import { screenListingWithoutAi } from "./screen-listing.ts";
import { AUTOMATIC_AUCTION_WINDOW_HOURS, screeningBlock, type ListingFilters, type MarketplaceOrder } from "../../shared/listing-filters.ts";
import { cardLanguageStatus, EnglishOnlyError } from "../../shared/card-language.ts";
import { sameCardNumber } from "../identity/card-identity.ts";
import { DEVELOPMENT_SEARCH_LIMIT, SEARCH_SOURCE_PAGE_LIMIT } from "../../shared/research-policy.ts";
import { createPriceFirstSession, type SoldScreeningFactory } from "./price-first.ts";
import { analysisPriority, compareAnalysisPriority } from "../../shared/analysis-priority.ts";
import { prioritizeListingText } from "./listing-text-priority.ts";
import { createScreeningPriceSource } from "../pricing/pkmnprices.ts";
import { autoAnalysisBlockReason } from "../../shared/analysis.ts";
import type { ScreenedOverflowRow, SearchCompetition, SourceDispositionRow, SourceRejectionReason } from "../../shared/search-diagnostic.ts";
import { EbayBudgetError } from "../ebay/usage.ts";
import { EbayError } from "../ebay/api.ts";
import { ProviderError } from "../lib/http.ts";
import { cents, MAX_OFFER_DISCOUNT_PERCENT } from "../../shared/money/cents.ts";
import { findBinCompetition } from "./bin-competition.ts";

const MIN_NEWEST_CANDIDATES = 3;
const REFILL_BATCH_SIZE = 4;

function literalTitleBlock(listing: ListingSummary, intent: SearchIntent): SourceRejectionReason | null {
    const reading = readTitleByRules(listing.title, intent.sets);
    if (reading.kind && reading.kind !== "SINGLE_CARD") return "JUNK";
    if (!setMatches(reading.set, intent)) return "OTHER_SET";
    if (intent.cardNumber && reading.cardNumber && !sameCardNumber(intent.cardNumber, reading.cardNumber)) return "OTHER_CARD";
    return null;
}

interface FindSteps {
    readIntent: typeof readSearchWithAi;
    search: typeof searchListings;
    readTitle: typeof readTitleWithoutAi;
    soldScreening?: SoldScreeningFactory;
    priceSource?: typeof createScreeningPriceSource;
    prioritizeText?: typeof prioritizeListingText;
    competition?: typeof findBinCompetition;
}

export interface SearchSummary {
    mode: "development";
    deferred: number;
    previouslySeen?: number;
    total: number;
    found: number;
    count: number;
    skipped: number;
    intent: SearchIntent;
    screened?: number;
    priceExcluded?: number;
    unresolvedOverflow?: number;
    sourceCoverage?: "COMPLETE" | "PARTIAL";
    soldPurchaseCeiling?: number;
    marketplaceOrder?: MarketplaceOrder;
    pricePass?: { status: "COMPLETE" | "UNAVAILABLE"; newListings: number; candidates: number };
}

export interface SearchOptions {
    onStart?: (summary: SearchSummary) => void;
    onListing?: (listing: ListingSummary) => void;
    // Internal observation for new-ID discovery history; not an emitted result
    // or a lasting rejection of this listing under other terms or targets.
    onPriceExcluded?: (listing: ListingSummary) => void;
    onScreenedOverflow?: (row: ScreenedOverflowRow) => void;
    onSourceDisposition?: (row: SourceDispositionRow) => void;
    onCompetition?: (reference: SearchCompetition) => void;
    minPrice?: number;
    signal?: AbortSignal;
    targets?: Targets;
    includeOffers?: boolean;
    automaticPhotos?: boolean;
    marketplaceOrder?: MarketplaceOrder;
    newOnly?: { excludeIds: readonly string[] };
    filters?: ListingFilters;
    asOf?: number;
}

// Screen one page in the requested marketplace order. When the newest BIN page
// yields few candidates, a second pass can check cheaper inventory.
export async function findDeals(search: string, {
    onStart = () => {}, onListing = () => {}, onPriceExcluded = () => {}, onScreenedOverflow = () => {}, onSourceDisposition = () => {}, onCompetition, minPrice = 0, signal, targets,
    includeOffers = false, automaticPhotos = false, marketplaceOrder, newOnly, filters, asOf = Date.now(),
}: SearchOptions = {}, dependencies: FindSteps = {
    readIntent: readSearchWithAi, search: searchListings, readTitle: readTitleWithoutAi,
    priceSource: createScreeningPriceSource, prioritizeText: prioritizeListingText, competition: findBinCompetition,
}): Promise<ListingSummary[]> {
    if (signal?.aborted) return [];
    if (cardLanguageStatus(search) === "OTHER") throw new EnglishOnlyError();
    let intent = await dependencies.readIntent(search, signal);
    if (signal?.aborted) return [];
    const typedCollectorNumber = intent.cardNumber?.split("/", 1)[0];
    const screenPrices = createPriceFirstSession(intent, { signal, targets, includeOffers, now: asOf, sourceFactory: dependencies.priceSource }, dependencies.soldScreening);
    let market: Awaited<ReturnType<typeof screenPrices.slabPurchaseMarket>> = null;
    try {
        intent = await screenPrices.resolveIntent();
        if (filters?.typeFilter === "FIXED_PRICE" && filters.kindFilter !== "raw") market = await screenPrices.slabPurchaseMarket(search);
    }
    catch (error) { if (signal?.aborted) return []; throw error; }
    if (signal?.aborted) return [];
    const marketCeiling = market?.ceiling ?? null;
    const listingFilters = { ...filters, minPrice: filters?.minPrice ?? minPrice };
    const soldPurchaseCeiling = marketCeiling === null ? undefined : Math.min(marketCeiling, listingFilters.maxPrice ?? Infinity);
    const firstFilters = soldPurchaseCeiling === undefined ? listingFilters : {
        ...listingFilters, kindFilter: "graded" as const, maxPrice: soldPurchaseCeiling,
    };
    // Preserve the Best Offer path with one bounded pass when the direct-buy
    // page is thin. Asking prices beyond the allowed discount stay outside it.
    const offerCeiling = marketCeiling !== null && includeOffers
        ? Math.min(Math.floor(cents(marketCeiling) * 100 / (100 - MAX_OFFER_DISCOUNT_PERCENT)) / 100, listingFilters.maxPrice ?? Infinity)
        : null;
    // Seller titles may use #194 in place of 194/203 or omit finish and edition.
    // Keep the full intent for verification and avoid requiring a catalog-inferred number.
    const query = marketCeiling === null ? marketplaceQuery(search, intent)
        : [intent.cardName, typedCollectorNumber ?? intent.sets[0], intent.grader, intent.minGrade].join(" ");
    const sourceOptions = {
        maxResults: SEARCH_SOURCE_PAGE_LIMIT, signal, filters: firstFilters, asOf, auctionEndsWithinHours: AUTOMATIC_AUCTION_WINDOW_HOURS,
    };
    const sourceOrder = newOnly ? "newest" : filters?.typeFilter === "AUCTION" ? undefined : marketplaceOrder ?? "newest";
    const sourceSort = sourceOrder === "lowest" ? "price" : sourceOrder === "newest" ? "newlyListed" : undefined;
    const firstPage: Awaited<ReturnType<typeof searchListings>> = marketCeiling === 0 || firstFilters.maxPrice !== undefined && firstFilters.minPrice > firstFilters.maxPrice
        ? { listings: [], total: 0, skipped: 0, rejections: [] } : await dependencies.search(query, {
        ...sourceOptions, sort: sourceSort,
        ...(newOnly ? { keepReserve: true } : {}),
    });
    if (signal?.aborted) return [];
    const now = Date.now();
    const loaded = new Map<string, ListingSummary>();
    const considered = new Set<string>();
    const deferred = new Set<string>();
    const excluded = new Set(newOnly?.excludeIds ?? []);
    const rejections = new Map<string, SourceRejectionReason>();
    let completeCoverage = true;
    let previouslySeen = 0, screenedCount = 0, priceExcluded = 0, unresolvedOverflow = 0;
    let total = firstPage.total, skipped = firstPage.skipped, started = false;
    let pricePass: SearchSummary["pricePass"];
    const summary = (count: number): SearchSummary => ({ total, found: loaded.size, count, skipped, intent, mode: "development",
        deferred: deferred.size, screened: screenedCount, priceExcluded, sourceCoverage: completeCoverage ? "COMPLETE" : "PARTIAL",
        ...(unresolvedOverflow ? { unresolvedOverflow } : {}),
        ...(newOnly ? { previouslySeen } : {}), ...(pricePass ? { pricePass } : {}),
        ...(soldPurchaseCeiling === undefined ? {} : { soldPurchaseCeiling }),
        ...(sourceOrder ? { marketplaceOrder: sourceOrder } : {}),
    });

    const canAssess = (listing: ListingSummary) => autoAnalysisBlockReason(listing, asOf) === null;
    const admissionPriority = (listing: ListingSummary) => !canAssess(listing) ? 0
        : analysisPriority(listing, targets).band > 0 ? 2 : 1;

    function preliminaryBlock(listing: ListingSummary, pageFilters: ListingFilters): SourceRejectionReason | null {
        if (marketCeiling !== null && !listing.bestOffer && listing.currentPrice !== null && listing.currentPrice > marketCeiling) return "ABOVE_SOLD_CEILING";
        const filtered = screeningBlock(listing, pageFilters, asOf);
        if (filtered) return filtered;
        if (!titleMatches(listing.title, intent)) return cardLanguageStatus(listing.title) === "OTHER" ? "OTHER_LANGUAGE" : "OTHER_CARD";
        if (!gradingMatches(listing.isGraded, intent)) return "CARD_TYPE";
        const mismatch = criteriaMismatch(searchAttributes(listing.title), intent, false);
        if (mismatch && mismatch !== "UNCONFIRMED_CRITERIA") return mismatch;
        return literalTitleBlock(listing, intent);
    }

    async function screenPage(page: typeof firstPage, pageFilters: ListingFilters, minPromising: number) {
        const { listings, rejections: sourceRejections } = page;
        if (!sourceRejections || page.unidentifiable || listings.length + sourceRejections.length > SEARCH_SOURCE_PAGE_LIMIT) completeCoverage = false;
        const boundedListings = listings.slice(0, SEARCH_SOURCE_PAGE_LIMIT);
        const remainingSlots = SEARCH_SOURCE_PAGE_LIMIT - boundedListings.length;
        for (const { id, reason } of sourceRejections?.slice(0, remainingSlots) ?? []) {
            if (!loaded.has(id) && !rejections.has(id)) rejections.set(id, reason);
        }
        const eligible = new Map<string, ListingSummary>();
        for (const row of boundedListings) {
            if (row.endTime && !(Date.parse(row.endTime) > now)) {
                if (!loaded.has(row.id)) rejections.set(row.id, "UNAVAILABLE");
                continue;
            }
            const listing = loaded.get(row.id) ?? row;
            if (!loaded.has(row.id)) {
                loaded.set(row.id, row);
                if (excluded.has(row.id)) previouslySeen++;
            }
            if (considered.has(row.id) || eligible.has(row.id)) continue;
            const reason = excluded.has(row.id) ? "ALREADY_SEEN" : preliminaryBlock(listing, pageFilters);
            if (reason) {
                if (!deferred.has(row.id)) rejections.set(row.id, reason);
                continue;
            }
            rejections.delete(row.id);
            eligible.set(row.id, listing);
            deferred.add(row.id);
        }
        const matching: ListingSummary[] = [];
        let promising = 0;
        let batch: ListingSummary[] = [];
        async function priceBatch() {
            if (!started) { onStart(summary(batch.length)); started = true; }
            signal?.throwIfAborted();
            const priced = await screenPrices(batch);
            screenedCount += batch.length;
            // Confident price exclusions do not consume display slots.
            for (const listing of priced) {
                signal?.throwIfAborted();
                if (listing.screen?.status === "DROPPED") {
                    priceExcluded++;
                    rejections.set(listing.id, "SOLD_PRICE_EXCLUDED");
                    onPriceExcluded(listing);
                } else {
                    matching.push(listing);
                    if (admissionPriority(listing) === 2) promising++;
                }
            }
            batch = [];
        }
        for (const listing of eligible.values()) {
            if (matching.length >= DEVELOPMENT_SEARCH_LIMIT && promising >= minPromising) break;
            signal?.throwIfAborted();
            considered.add(listing.id);
            deferred.delete(listing.id);
            const screened = await screenListingWithoutAi(listing, intent, signal, dependencies.readTitle);
            const mismatch = screened.match ?? cardMismatch(screened.screen, intent);
            const reason = mismatch && mismatch !== "UNCONFIRMED_CRITERIA" ? mismatch : screeningBlock(screened, pageFilters, asOf);
            if (reason) {
                rejections.set(listing.id, reason);
                continue;
            }
            batch.push(mismatch ? { ...screened, match: mismatch } : screened);
            // Once display is full, keep looking in the already-fetched page
            // for supported candidates. Price work still shares one allowance.
            const remainingSlots = DEVELOPMENT_SEARCH_LIMIT - matching.length;
            if (batch.length >= (remainingSlots > 0 ? remainingSlots : REFILL_BATCH_SIZE)) await priceBatch();
        }
        if (batch.length) await priceBatch();
        return { matching, promising };
    }

    let matching: ListingSummary[];
    try {
        const first = await screenPage(firstPage, firstFilters, MIN_NEWEST_CANDIDATES);
        matching = first.matching;
        const promising = first.promising;
        const moreDirectListings = !newOnly && sourceOrder !== "lowest" && (total > SEARCH_SOURCE_PAGE_LIMIT || deferred.size > 0);
        const widenForOffers = !moreDirectListings && soldPurchaseCeiling !== undefined && offerCeiling !== null &&
            offerCeiling > soldPurchaseCeiling && offerCeiling >= firstFilters.minPrice;
        let cheaper: { matching: ListingSummary[]; newListings: number } | undefined;
        if (filters?.typeFilter === "FIXED_PRICE" && (widenForOffers || moreDirectListings) && promising < MIN_NEWEST_CANDIDATES) {
            const nextFilters = widenForOffers ? {
                ...firstFilters, minPrice: Math.max(firstFilters.minPrice, (cents(soldPurchaseCeiling) + 1) / 100), maxPrice: offerCeiling,
            } : firstFilters;
            let cheaperPage: typeof firstPage | undefined;
            try { cheaperPage = await dependencies.search(query, { ...sourceOptions, filters: nextFilters, sort: newOnly ? "newlyListed" : "price", keepReserve: true }); }
            catch (error) {
                signal?.throwIfAborted();
                if (!(error instanceof EbayBudgetError || error instanceof EbayError || error instanceof ProviderError)) throw error;
                pricePass = { status: "UNAVAILABLE", newListings: 0, candidates: 0 };
            }
            if (cheaperPage) {
                signal?.throwIfAborted();
                const before = loaded.size;
                total = Math.max(total, cheaperPage.total);
                skipped += cheaperPage.skipped;
                const screened = await screenPage(cheaperPage, nextFilters, MIN_NEWEST_CANDIDATES - promising);
                cheaper = { matching: screened.matching, newListings: loaded.size - before };
                matching = [...matching, ...cheaper.matching];
            }
        }
        if (matching.length > DEVELOPMENT_SEARCH_LIMIT) {
            // Prefer candidates with supported upside, then other assessment
            // candidates. Equal ranks preserve the first page's order.
            const ranked = matching.map(listing => ({ listing, priority: admissionPriority(listing) }));
            ranked.sort((a, b) => b.priority - a.priority);
            for (const { listing, priority } of ranked.slice(DEVELOPMENT_SEARCH_LIMIT)) {
                if (priority === 0) unresolvedOverflow++;
                onScreenedOverflow({ id: listing.id, reason: autoAnalysisBlockReason(listing, asOf) ?? "DISPLAY_LIMIT" });
            }
            matching = ranked.slice(0, DEVELOPMENT_SEARCH_LIMIT).map(({ listing }) => listing);
        }
        if (cheaper) {
            const admitted = new Set(matching.map(listing => listing.id));
            pricePass = { status: "COMPLETE", newListings: cheaper.newListings,
                candidates: cheaper.matching.filter(listing => admitted.has(listing.id) && canAssess(listing)).length };
        }
    } catch (error) { if (signal?.aborted) return []; throw error; }
    if (signal?.aborted) return [];
    onStart(summary(matching.length));
    let ordered = matching.sort((a, b) => compareAnalysisPriority(a, b, targets));
    if (automaticPhotos && dependencies.prioritizeText) ordered = await dependencies.prioritizeText(ordered, targets, signal);
    const results: ListingSummary[] = [];
    for (const listing of ordered) {
        if (signal?.aborted) return [];
        const reason = screeningBlock(listing, listingFilters, asOf);
        if (reason) {
            rejections.set(listing.id, reason);
            continue;
        }
        const mismatch = listing.match ?? cardMismatch(listing.screen, intent);
        const result = mismatch ? { ...listing, match: mismatch } : listing;
        onListing(result);
        results.push(result);
    }
    for (const [id, reason] of rejections) onSourceDisposition({ id, outcome: "REJECTED", reason });
    for (const id of deferred) onSourceDisposition({ id, outcome: "NOT_REACHED", reason: "ENOUGH_CANDIDATES" });
    if (onCompetition && dependencies.competition && !newOnly && !results.length && market &&
        soldPurchaseCeiling !== undefined && soldPurchaseCeiling > 0 && listingFilters.minPrice <= soldPurchaseCeiling) {
        // Optional context under the same request account. Never alter the
        // completed discovery or treat a competing asking price as sold evidence.
        const timeout = AbortSignal.timeout(15_000);
        const competitionSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const reference = await dependencies.competition(query, market.reference, market.expectedNet, targets,
            listingFilters.maxPrice, competitionSignal).catch(() => undefined);
        if (reference && !competitionSignal.aborted) onCompetition(reference);
    }
    return results;
}
