import { researchAuctionSellers } from "./auction-seller-research.ts";
import { freshListingTime } from "../../shared/grading-watch.ts";
import { addBinMarketComparisons, cheapestComparableFirst, sampleRawAsks } from "../../shared/bin-market-comparison.ts";
import { searchListings } from "../ebay/listings.ts";
import { isSportsTradingCardListing } from "../ebay/filters.ts";
import { readSearchWithAi } from "../search/query-assistance.ts";
import { cardMismatch, gradingMatches, titleMatches, setMatches } from "../search/relevance.ts";
import { readTitleByRules, readTitleWithoutAi, readTitlesWithoutAi } from "../ai/title-reader.ts";
import type { ListingSummary, SearchIntent, Targets } from "../../shared/types.ts";
import { criteriaMismatch, marketplaceQuery, rawBuyItNowQuery, searchAttributes } from "../../shared/search-criteria.ts";
import { screenListingWithoutAi } from "./screen-listing.ts";
import { screeningBlock, type DiscoveryOrder, type ListingFilters, type MarketplaceOrder } from "../../shared/listing-filters.ts";
import { cardLanguageStatus, EnglishOnlyError } from "../../shared/card-language.ts";
import { sameCardNumber } from "../identity/card-identity.ts";
import { sameCatalogName } from "../identity/catalog-name.ts";
import { DEVELOPMENT_SEARCH_LIMIT, SEARCH_SOURCE_PAGE_LIMIT } from "../../shared/research-policy.ts";
import { createPriceFirstSession, type SoldScreeningFactory } from "./price-first.ts";
import { analysisPriority, compareAnalysisPriority } from "../../shared/analysis-priority.ts";
import { buyerReviewBlock } from "../../shared/wait-skip-review.ts";
import { FIRST_REVIEW_COUNT, type SearchReviewSelection } from "../../shared/search-review-selection.ts";
import { chooseReviewSelection, ruleSelection } from "./search-review-selection.ts";
import { prioritizeListingText } from "./listing-text-priority.ts";
import { createScreeningPriceSource } from "../pricing/pkmnprices.ts";
import { autoAnalysisBlockReason } from "../../shared/analysis.ts";
import type { ScreenedOverflowRow, SearchCompetition, SourceDispositionRow, SourceRejectionReason } from "../../shared/search-diagnostic.ts";
import { EbayBudgetError } from "../ebay/usage.ts";
import { EbayError } from "../ebay/api.ts";
import { ProviderError } from "../lib/http.ts";
import { cents, MAX_OFFER_DISCOUNT_PERCENT } from "../../shared/money/cents.ts";
import { findBinCompetition } from "./bin-competition.ts";
import type { CollectorStrategyEvidence } from "../analysis/collector-strategy-evidence.ts";
import { cachedSetYears } from "../search/set-catalog.ts";
import { outsideSearchYears } from "../../shared/search-years.ts";
import type { SearchContinuation } from "../../shared/search-continuation.ts";
import { discoveryContinuations, type DiscoveryBacklog, type DiscoverySourceCursor, type DiscoveryBatchReceipt } from "./search-continuation.ts";
import { getAiUsageContext, getBudgetContext, withAiUsageContext } from "../ai/usage-context.ts";
import { browsePressure } from "../lib/provider-usage.ts";
import { orderBroadDiscovery } from "./discovery-order.ts";

const MIN_NEWEST_CANDIDATES = 3;
const REFILL_BATCH_SIZE = 4;

function literalTitleBlock(listing: ListingSummary, intent: SearchIntent): SourceRejectionReason | null {
    const reading = readTitleByRules(listing.title, intent.sets);
    if (reading.kind && reading.kind !== "SINGLE_CARD") return "JUNK";
    if (!setMatches(reading.set, intent, reading.cardNumber)) return "OTHER_SET";
    if (outsideSearchYears(intent, reading.set, listing.title)) return "OTHER_SET";
    if (intent.cardNumber && reading.cardNumber && !sameCardNumber(intent.cardNumber, reading.cardNumber)) return "OTHER_CARD";
    return null;
}

function disputedHolder(row: ListingSummary, kind: ListingFilters["kindFilter"]) {
    const attrs = searchAttributes(row.title);
    if (kind === "graded" && !row.isGraded && attrs.grader !== null && attrs.grade !== null &&
        !/\b(?:raw|ungraded|unslabbed|candidate|contender|potential|possible|worthy|ready|would grade|regrade|not graded)\b/i.test(row.title)) return kind;
    if (kind === "raw" && row.isGraded && /\b(?:raw|ungraded|unslabbed)\b/i.test(row.title) && !attrs.grader) return kind;
    return undefined;
}

interface FindSteps {
    browsePressure?: typeof browsePressure;
    readIntent: typeof readSearchWithAi;
    search: typeof searchListings;
    readTitle: typeof readTitleWithoutAi;
    readTitles?: typeof readTitlesWithoutAi;
    releaseYears?: typeof cachedSetYears;
    soldScreening?: SoldScreeningFactory;
    priceSource?: typeof createScreeningPriceSource;
    prioritizeText?: typeof prioritizeListingText;
    selectReviews?: typeof chooseReviewSelection;
    researchAuctionSellers?: typeof researchAuctionSellers;
    competition?: typeof findBinCompetition;
}

const defaultSteps: FindSteps = {
    browsePressure, readIntent: readSearchWithAi, search: searchListings, readTitle: readTitleWithoutAi, readTitles: readTitlesWithoutAi, releaseYears: cachedSetYears,
    priceSource: createScreeningPriceSource, prioritizeText: prioritizeListingText, researchAuctionSellers, selectReviews: chooseReviewSelection, competition: findBinCompetition,
};

export interface SearchSummary {
    continuation?: SearchContinuation;
    sourceLimitReached?: boolean;
    mode: "development";
    reviewSelection?: SearchReviewSelection;
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
    marketplaceOrder?: DiscoveryOrder;
    pricePass?: { status: "COMPLETE" | "UNAVAILABLE"; newListings: number; candidates: number };
}

export interface SearchOptions {
    continuation?: string;
    onProgress?: (progress: { found: number; screened: number }) => void;
    onStart?: (summary: SearchSummary) => void;
    onListing?: (listing: ListingSummary) => void;
    // Internal observation for new-ID discovery history; not an emitted result
    // or a lasting rejection of this listing under other terms or targets.
    onPriceExcluded?: (listing: ListingSummary) => void;
    onScreenedOverflow?: (row: ScreenedOverflowRow) => void;
    onSourceDisposition?: (row: SourceDispositionRow) => void;
    onCompetition?: (reference: SearchCompetition) => void;
    onCollectorEvidence?: (evidence: CollectorStrategyEvidence) => Promise<void>;
    minPrice?: number;
    signal?: AbortSignal;
    targets?: Targets;
    includeOffers?: boolean;
    automaticPhotos?: boolean;
    marketplaceOrder?: MarketplaceOrder;
    newOnly?: { excludeIds: readonly string[]; gradingWatch?: boolean };
    filters?: ListingFilters;
    asOf?: number;
}

interface InventoryScan {
    diagnostic?: ReturnType<typeof import("../analysis/flip-diagnostic.ts").flipDiagnostic>;
    excludeIds: ReadonlySet<string>;
    previouslyChecked?: (row: ListingSummary) => boolean;
    freshGrading: boolean;
    freshListings?: true;
    recoverTitles?: boolean;
    firstPhotoBatch?: boolean;
    offset?: number;
    onNextPage?: (offset: number | undefined) => void;
    onProgress?: SearchOptions["onProgress"];
    onStage?: (stage: "discovering" | "pricing") => void;
    /** Keep unreached copies and source cursors with the owning hunt. */
    onBacklog?: (backlog: DiscoveryBacklog | undefined) => void;
    resumeBacklog?: DiscoveryBacklog;
}

// Screen one page in the requested marketplace order. When the newest BIN page
// yields few candidates, a second pass can check cheaper inventory.
async function findDealsBatch(search: string, {
    onProgress = () => {}, onStart = () => {}, onListing = () => {}, onPriceExcluded = () => {}, onScreenedOverflow = () => {}, onSourceDisposition = () => {}, onCompetition, onCollectorEvidence, minPrice = 0, signal, targets,
    includeOffers = false, automaticPhotos = false, marketplaceOrder, newOnly, filters, asOf = Date.now(), continuation: continuationToken,
}: SearchOptions = {}, dependencies = defaultSteps, resume?: DiscoveryBacklog, inventoryScan?: InventoryScan): Promise<ListingSummary[]> {
    if (signal?.aborted) return [];
    if (cardLanguageStatus(search) === "OTHER") throw new EnglishOnlyError();
    let intent = await dependencies.readIntent(search, signal);
    const broadSearch = !intent.cardName;
    // Offsets from older all-category searches must stay in that source stream.
    const ccgInventory = Boolean(inventoryScan || (resume ? resume.ccgInventory : broadSearch && !intent.cardNumber &&
        (intent.sets.length || intent.minYear !== undefined || intent.maxYear !== undefined)));
    if (signal?.aborted) return [];
    if (intent.minYear !== undefined || intent.maxYear !== undefined) {
        const releaseYears = await dependencies.releaseYears?.();
        if (releaseYears) intent = { ...intent, releaseYears };
        if (signal?.aborted) return [];
    }
    const requestedFullNumber = intent.cardNumber?.includes('/') === true;
    function researchNumber(claims: ReturnType<typeof readTitleByRules>) {
        if (!claims.cardNumber || !sameCardNumber(claims.cardNumber, intent.cardNumber)) return false;
        if (claims.cardNumber.includes("/")) return true;
        // A slab title may omit "ex" and the denominator. Keep it for photos only
        // when the release, printed number and Pokémon name independently agree.
        return requestedFullNumber && intent.sets.length === 1 && !!claims.set && setMatches(claims.set, intent, claims.cardNumber) &&
            !!intent.cardName && sameCatalogName(claims.cardName, intent.cardName.replace(/\s+ex$/i, ""));
    }
    const typedCollectorNumber = intent.cardNumber?.split("/", 1)[0];
    const screenPrices = createPriceFirstSession(intent, { signal, targets, includeOffers, now: asOf, sourceFactory: dependencies.priceSource,
        onScreened: () => { screenedCount++; reportProgress(); } }, dependencies.soldScreening);
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
    const keywords = marketplaceQuery(search, intent);
    const exactRawBin = filters?.typeFilter === "FIXED_PRICE" && filters.kindFilter !== "graded" && intent.graded !== true &&
        Boolean(intent.cardName && intent.cardNumber && intent.sets.length === 1);
    const query = marketCeiling !== null ? [intent.cardName, typedCollectorNumber ?? intent.sets[0], intent.grader, intent.minGrade].join(" ")
        : exactRawBin ? rawBuyItNowQuery(keywords, intent) : keywords;
    const sourceOptions = {
        maxResults: SEARCH_SOURCE_PAGE_LIMIT, signal, filters: firstFilters,
        ...(ccgInventory ? { ccgInventory: true } : { anyCategory: true }),
        ...(inventoryScan?.freshListings || inventoryScan?.previouslyChecked ? { cacheMode: "refresh" as const, offset: inventoryScan.offset } : {}),
    };
    // Browse can ignore itemEndDate ranges. Bring soon-ending auctions into
    // the bounded page, then validate their actual end dates against the search start.
    const sourceOrder = newOnly ? "newest" : filters?.typeFilter === "AUCTION" ? "ending" : marketplaceOrder ?? "newest";
    const sourceSort = { lowest: "price", newest: "newlyListed", ending: "endingSoonest" } as const;
    const sources = [...(resume?.sources ?? [])];
    const cursor = resume && !resume.pending.length ? sources.shift() : undefined;
    let sourceBlocked = false;
    let firstPage: Awaited<ReturnType<typeof searchListings>>;
    if (resume?.pending.length) firstPage = { listings: resume.pending.slice(0, SEARCH_SOURCE_PAGE_LIMIT), total: resume.total, skipped: 0, rejections: [] };
    else if (resume && !cursor || marketCeiling === 0 || firstFilters.maxPrice !== undefined && firstFilters.minPrice > firstFilters.maxPrice)
        firstPage = { listings: [], total: resume?.total ?? 0, skipped: 0, rejections: [] };
    else {
        inventoryScan?.onStage?.("discovering");
        try { firstPage = await dependencies.search(cursor?.query ?? query, {
            ...sourceOptions, sort: cursor?.sort ?? sourceSort[sourceOrder], ...(cursor && { offset: cursor.offset, filters: cursor.filters }),
            ...(newOnly || resume || inventoryScan ? { keepReserve: true } : {}),
        }); }
        catch (error) {
            signal?.throwIfAborted();
            if (!resume || !cursor || !(error instanceof EbayBudgetError && error.reason === "QUOTA")) throw error;
            sources.unshift(cursor); sourceBlocked = true;
            firstPage = { listings: [], total: resume.total, skipped: 0, rejections: [] };
        }
    }
    inventoryScan?.onNextPage?.(firstPage.nextOffset);
    let sourceLimitReached = resume?.sourceLimitReached === true || firstPage.sourceLimitReached === true;
    function retainCursor(page: typeof firstPage, sourceQuery: string, sourceFilters: ListingFilters, sort: DiscoverySourceCursor["sort"]) {
        sourceLimitReached ||= page.sourceLimitReached === true;
        if (page.nextOffset === undefined) return;
        const next = { query: sourceQuery, filters: sourceFilters, sort, offset: page.nextOffset, total: page.total };
        const key = (row: DiscoverySourceCursor) => JSON.stringify([row.query, row.filters, row.sort, row.offset]);
        if (!sources.some(row => key(row) === key(next))) sources.push(next);
    }
    if (!resume?.pending.length && !sourceBlocked) retainCursor(firstPage, cursor?.query ?? query, cursor?.filters ?? firstFilters, cursor?.sort ?? sourceSort[sourceOrder]);
    if (signal?.aborted) return [];
    const now = Date.now();
    const loaded = new Map<string, ListingSummary>();
    const considered = new Set<string>();
    const deferred = new Set<string>();
    const excluded = new Set([...(newOnly?.excludeIds ?? []), ...(resume?.seenIds ?? []), ...(inventoryScan?.excludeIds ?? [])]);
    const rejections = new Map<string, SourceRejectionReason>();
    const excludedByPrice: ListingSummary[] = [];
    let completeCoverage = true;
    let previouslySeen = 0, screenedCount = 0, priceExcluded = 0, unresolvedOverflow = 0;
    let total = firstPage.total, skipped = firstPage.skipped, started = false;
    const reportProgress = () => onProgress({ found: loaded.size, screened: screenedCount });
    let pricePass: SearchSummary["pricePass"];
    let continuation: SearchContinuation | undefined;
    const summary = (count: number): SearchSummary => ({ total, found: loaded.size, count, skipped, intent, mode: "development",
        deferred: deferred.size, screened: screenedCount, priceExcluded, sourceCoverage: completeCoverage ? "COMPLETE" : "PARTIAL",
        ...(unresolvedOverflow ? { unresolvedOverflow } : {}),
        ...(newOnly ? { previouslySeen } : {}), ...(pricePass ? { pricePass } : {}),
        ...(soldPurchaseCeiling === undefined ? {} : { soldPurchaseCeiling }),
        marketplaceOrder: sourceOrder, ...(continuation && { continuation }), ...(sourceLimitReached && { sourceLimitReached: true }),
    });

    const canAssess = (listing: ListingSummary) => buyerReviewBlock(listing, asOf) === null;
    const admissionPriority = (listing: ListingSummary) => !canAssess(listing) ? 0
        : analysisPriority(listing, targets, asOf).band > 0 ? 2 : 1;

    function preliminaryBlock(listing: ListingSummary, pageFilters: ListingFilters): SourceRejectionReason | null {
        if (ccgInventory && isSportsTradingCardListing(listing)) return "OTHER_CARD";
        if ((newOnly?.gradingWatch || inventoryScan?.freshGrading) && freshListingTime(listing, asOf) === null) return "OUTSIDE_GRADING_WATCH";
        if (marketCeiling !== null && !listing.bestOffer && listing.currentPrice !== null && listing.currentPrice > marketCeiling) return "ABOVE_SOLD_CEILING";
        const filtered = screeningBlock(listing, pageFilters, asOf);
        if (filtered) return filtered;
        if (cardLanguageStatus(listing.title) === "OTHER") return "OTHER_LANGUAGE";
        if (!listing.researchIdentity && !titleMatches(listing.title, intent)) return "OTHER_CARD";
        if (!gradingMatches(listing.researchKind ? listing.researchKind === "graded" : listing.isGraded, intent)) return "CARD_TYPE";
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
            const disputed = inventoryScan?.freshListings && !row.researchKind ? disputedHolder(row, pageFilters.kindFilter) : undefined;
            const claims = inventoryScan?.freshListings && intent.cardName && requestedFullNumber && intent.sets.length === 1 &&
                row.images.some(Boolean) && !titleMatches(row.title, intent) ? readTitleByRules(row.title, intent.sets) : null;
            const corroboratedNumber = claims?.set && researchNumber(claims) &&
                setMatches(claims.set, intent, claims.cardNumber);
            const listing = corroboratedNumber ? { ...row, researchIdentity: true as const, ...(disputed && { researchKind: disputed }) } : disputed ? { ...row, researchKind: disputed } : row.researchKind || row.researchIdentity ? row : loaded.get(row.id) ?? row;
            if (!loaded.has(row.id)) {
                loaded.set(row.id, listing);
                if (excluded.has(row.id)) previouslySeen++;
            }
            if (considered.has(row.id) || eligible.has(row.id)) continue;
            const reason = excluded.has(row.id) || inventoryScan?.previouslyChecked?.(listing) ? "ALREADY_SEEN" : preliminaryBlock(listing, pageFilters);
            if (reason) {
                if (!deferred.has(row.id)) rejections.set(row.id, reason);
                continue;
            }
            rejections.delete(row.id);
            // Overflow must keep the clues that made this copy eligible on the alternate query.
            loaded.set(row.id, listing);
            eligible.set(row.id, listing);
            deferred.add(row.id);
        }
        reportProgress();
        const titleReadings = dependencies.readTitles ? await dependencies.readTitles([...eligible.values()].map(listing => listing.title), signal) : null;
        signal?.throwIfAborted();
        const matching: ListingSummary[] = [];
        let promising = 0;
        let batch: ListingSummary[] = [];
        async function priceBatch() {
            if (!started) { onStart(summary(batch.length)); started = true; }
            signal?.throwIfAborted();
            inventoryScan?.onStage?.("pricing");
            // A disputed holder has no safe preliminary raw/slab market. Photos decide it.
            const undisputed = batch.filter(row => !row.researchKind && !row.researchIdentity);
            const priced = undisputed.length ? await screenPrices(undisputed) : [];
            priced.push(...batch.filter(row => row.researchKind || row.researchIdentity));
            // Confident price exclusions do not consume display slots.
            for (const listing of priced) {
                signal?.throwIfAborted();
                if (listing.screen?.status === "DROPPED") {
                    priceExcluded++;
                    excludedByPrice.push(listing);
                    rejections.set(listing.id, "SOLD_PRICE_EXCLUDED");
                    onPriceExcluded(listing);
                } else {
                    matching.push(listing);
                    if (admissionPriority(listing) === 2) promising++;
                }
            }
            batch = [];
        }
        const prepared: ListingSummary[] = [];
        for (const listing of eligible.values()) {
            signal?.throwIfAborted();
            const screened = await screenListingWithoutAi(listing, intent, signal,
                titleReadings ? async title => titleReadings.get(title)! : dependencies.readTitle);
            const mismatch = screened.match ?? cardMismatch(screened.screen, intent);
            const reason = mismatch && mismatch !== "UNCONFIRMED_CRITERIA" ? mismatch : screeningBlock(screened, pageFilters, asOf);
            if (reason) {
                considered.add(listing.id); deferred.delete(listing.id);
                rejections.set(listing.id, reason);
            } else prepared.push(mismatch ? { ...screened, match: mismatch } : screened);
        }
        let ordered = broadSearch ? orderBroadDiscovery(prepared, targets, asOf) : prepared;
        if (inventoryScan?.freshListings && !inventoryScan.freshGrading) {
            const { samples, groups } = sampleRawAsks(prepared, Date.now());
            await inventoryScan.diagnostic?.("inventory", { query, groups: [...groups].map(([market, copies]) =>
                ({ market, ids: [...copies.values()].map(row => row.id) })), observedAt: new Date().toISOString() });
            ordered = cheapestComparableFirst(ordered, groups).map(row => {
                const sample = samples.get(row.id);
                return sample ? { ...row, askingSample: sample } : row;
            });
        }
        // Return the first promising group promptly. The rest of this already fetched
        // page stays in the saved backlog under the original account.
        const photoBatch = inventoryScan?.firstPhotoBatch && inventoryScan.onBacklog && !resume ? 6 : undefined;
        for (const listing of ordered) {
            if (photoBatch && matching.length >= photoBatch) break;
            // Broad inventory should reach photo review after one useful batch,
            // rather than exhaust pricing on hundreds of weak or repeated rows.
            // The remainder stays server-owned and is screened in later batches.
            if (broadSearch && matching.length >= DEVELOPMENT_SEARCH_LIMIT) break;
            if (matching.length >= DEVELOPMENT_SEARCH_LIMIT && promising >= minPromising) {
                // Other raw copies of this exact card share the market lookup.
                // Compare them before filling the display with the first 50.
                if (!exactRawBin || newOnly) break;
                if (listing.isGraded) continue;
            }
            signal?.throwIfAborted();
            considered.add(listing.id);
            deferred.delete(listing.id);
            batch.push(listing);
            // Once display is full, keep looking in the already-fetched page
            // for supported candidates. Price work still shares one allowance.
            const remainingSlots = (photoBatch ?? DEVELOPMENT_SEARCH_LIMIT) - matching.length;
            if (batch.length >= (remainingSlots > 0 ? remainingSlots : REFILL_BATCH_SIZE)) await priceBatch();
        }
        if (batch.length) await priceBatch();
        return { matching, promising };
    }

    let matching: ListingSummary[];
    try {
        const first = await screenPage(firstPage, firstFilters, MIN_NEWEST_CANDIDATES);
        matching = first.matching;
        const kind = listingFilters.kindFilter;
        const numbered = !!intent.cardNumber?.includes("/");
        const exactSet = numbered && intent.sets.length === 1;
        if (inventoryScan?.freshListings && marketCeiling !== 0 && !resume && !inventoryScan.offset &&
            (intent.cardName || intent.sets.length === 1) && (kind === "raw" || kind === "graded" || exactSet && inventoryScan.recoverTitles) &&
            matching.length < MIN_NEWEST_CANDIDATES && !await dependencies.browsePressure?.()) {
            // Sellers can omit the name or file the card outside the singles category.
            // Use one bounded alternate query and verify the original buyer constraints on photos.
            const exactQuery = exactSet ? [intent.sets[0], intent.cardNumber].join(" ") :
                [intent.cardName ?? intent.sets[0], intent.cardNumber].filter(Boolean).join(" ");
            const recovery = await dependencies.search(exactQuery, { maxResults: 12, signal, anyCategory: true, keepReserve: true,
                filters: { ...listingFilters, kindFilter: "all" }, sort: "newlyListed" }).catch(error => {
                signal?.throwIfAborted();
                if (!(error instanceof EbayBudgetError && error.reason === "QUOTA" || error instanceof ProviderError || error instanceof EbayError)) throw error;
                completeCoverage = false;
                return { listings: [], total: 0, skipped: 0, rejections: [] };
            });
            const copies: ListingSummary[] = [];
            for (const row of recovery.listings) {
                if (matching.some(copy => copy.id === row.id)) continue;
                const title = readTitleByRules(row.title, intent.sets);
                const sameNumber = numbered && researchNumber(title);
                const named = intent.cardName ? sameCatalogName(title.cardName, intent.cardName) : true;
                const numberedSet = requestedFullNumber && exactSet && sameNumber && !!title.set && setMatches(title.set, intent, title.cardNumber);
                const disputed = disputedHolder(row, kind);
                const correctKind = kind !== "raw" && kind !== "graded" || row.isGraded === (kind === "graded");
                if ((!named && !numberedSet) || numbered && !sameNumber || !intent.cardName && !title.set) {
                    if (!loaded.has(row.id)) rejections.set(row.id, "OTHER_CARD");
                } else if (disputed || correctKind && numberedSet) {
                    copies.push({ ...row, ...(disputed && { researchKind: disputed }), ...(!named && { researchIdentity: true as const }) });
                } else if (!loaded.has(row.id)) rejections.set(row.id, "CARD_TYPE");
            }
            const recovered = await screenPage({ ...recovery, listings: copies }, listingFilters, 0);
            matching.push(...recovered.matching);
        }
        const promising = first.promising;
        const moreDirectListings = !newOnly && sourceOrder !== "lowest" && (total > SEARCH_SOURCE_PAGE_LIMIT || deferred.size > 0);
        const widenForOffers = !moreDirectListings && soldPurchaseCeiling !== undefined && offerCeiling !== null &&
            offerCeiling > soldPurchaseCeiling && offerCeiling >= firstFilters.minPrice;
        let cheaper: { matching: ListingSummary[]; newListings: number } | undefined;
        const compareOlderAsks = inventoryScan?.freshListings && !inventoryScan.offset && exactRawBin && moreDirectListings;
        const drainFirst = deferred.size > 0 || matching.length >= FIRST_REVIEW_COUNT;
        if (!resume && compareOlderAsks && drainFirst && firstPage.nextOffset !== undefined) {
            // Drain the page we already paid for. Before fetching deeper newest listings,
            // sample the cheapest active copies, including older listings, in the same search.
            sources.unshift({ query, filters: firstFilters, sort: "price", offset: 0, total: firstPage.total });
        }
        if (!resume && !inventoryScan?.freshGrading && (!inventoryScan?.freshListings || compareOlderAsks && !drainFirst) && filters?.typeFilter === "FIXED_PRICE" && (widenForOffers || moreDirectListings) && promising < MIN_NEWEST_CANDIDATES && !await dependencies.browsePressure?.()) {
            const nextFilters = widenForOffers ? {
                ...firstFilters, minPrice: Math.max(firstFilters.minPrice, (cents(soldPurchaseCeiling) + 1) / 100), maxPrice: offerCeiling,
            } : firstFilters;
            let cheaperPage: typeof firstPage | undefined;
            inventoryScan?.onStage?.("discovering");
            try { cheaperPage = await dependencies.search(query, { ...sourceOptions, offset: 0, filters: nextFilters, sort: newOnly ? "newlyListed" : "price", keepReserve: true }); }
            catch (error) {
                signal?.throwIfAborted();
                if (!(error instanceof EbayBudgetError || error instanceof EbayError || error instanceof ProviderError)) throw error;
                pricePass = { status: "UNAVAILABLE", newListings: 0, candidates: 0 };
            }
            if (cheaperPage) {
                retainCursor(cheaperPage, query, nextFilters, "price");
                signal?.throwIfAborted();
                const before = loaded.size;
                total = Math.max(total, cheaperPage.total);
                skipped += cheaperPage.skipped;
                const screened = await screenPage(cheaperPage, nextFilters, MIN_NEWEST_CANDIDATES - promising);
                cheaper = { matching: screened.matching, newListings: loaded.size - before };
                matching = [...matching, ...cheaper.matching];
            }
        }
        matching = addBinMarketComparisons(matching, excludedByPrice, asOf);
        const pending: ListingSummary[] = [...(resume?.pending.slice(SEARCH_SOURCE_PAGE_LIMIT) ?? [])];
        if (matching.length > DEVELOPMENT_SEARCH_LIMIT) {
            // Prefer candidates with supported upside, then other assessment
            // candidates. Equal ranks preserve the first page's order.
            const ranked = matching.map(listing => ({ listing, priority: admissionPriority(listing) }));
            ranked.sort((a, b) => b.priority - a.priority || compareAnalysisPriority(a.listing, b.listing, targets, asOf));
            for (const { listing } of ranked.slice(DEVELOPMENT_SEARCH_LIMIT)) {
                pending.push(listing);
                if (!getBudgetContext().searchId) {
                    if (autoAnalysisBlockReason(listing, asOf) !== null) unresolvedOverflow++;
                    onScreenedOverflow({ id: listing.id, reason: autoAnalysisBlockReason(listing, asOf) ?? "DISPLAY_LIMIT" });
                }
            }
            matching = ranked.slice(0, DEVELOPMENT_SEARCH_LIMIT).map(({ listing }) => listing);
        }
        for (const id of deferred) { const listing = loaded.get(id); if (listing) pending.push(listing); }
        const rootSearchId = resume?.rootSearchId ?? getBudgetContext().searchId;
        if (inventoryScan && (pending.length || sources.length || sourceLimitReached)) completeCoverage = false;
        if (inventoryScan) inventoryScan.onBacklog?.(pending.length || sources.length ? {
            rootSearchId: rootSearchId ?? "", request: { search, minPrice, filters, targets, includeOffers, automaticPhotos, marketplaceOrder, asOf, newOnly },
            pending: [...new Map(pending.map(row => [row.id, row])).values()],
            seenIds: [...new Set([...(resume?.seenIds ?? []), ...considered, ...rejections.keys()])]
                .filter(id => !pending.some(row => row.id === id)),
            sources, total, ...(sourceLimitReached && { sourceLimitReached: true }),
        } : undefined);
        if (!inventoryScan && (pending.length || sources.length || sourceLimitReached) && rootSearchId && /^[0-9a-f-]{36}$/i.test(rootSearchId)) {
            completeCoverage = false;
            if (sourceBlocked && continuationToken) continuation = { token: continuationToken, searchId: getAiUsageContext().searchId!,
                pending: pending.length, moreSource: sources.length > 0, blocked: "QUOTA" };
            else if (pending.length || sources.length) {
                const pendingIds = new Set(pending.map(row => row.id));
                continuation = await discoveryContinuations.create({ rootSearchId,
                    request: { search, minPrice, filters, targets, includeOffers, automaticPhotos, marketplaceOrder, asOf, newOnly },
                    pending: [...new Map(pending.map(row => [row.id, row])).values()],
                    seenIds: [...new Set([...(resume?.seenIds ?? []), ...considered, ...rejections.keys()])].filter(id => !pendingIds.has(id)),
                    sources, total, ...(ccgInventory && { ccgInventory: true }), ...(sourceLimitReached && { sourceLimitReached: true }) });
            }
        }
        if (cheaper) {
            const admitted = new Set(matching.map(listing => listing.id));
            pricePass = { status: "COMPLETE", newListings: cheaper.newListings,
                candidates: cheaper.matching.filter(listing => admitted.has(listing.id) && canAssess(listing)).length };
        }
    } catch (error) { if (signal?.aborted) return []; throw error; }
    if (signal?.aborted) return [];
    let results: ListingSummary[] = [];
    for (const listing of matching) {
        if (signal?.aborted) return [];
        const reason = screeningBlock(listing, listingFilters, asOf);
        if (reason) {
            rejections.set(listing.id, reason);
            continue;
        }
        const mismatch = listing.match ?? cardMismatch(listing.screen, intent);
        results.push(mismatch ? { ...listing, match: mismatch } : listing);
    }
    results.sort((a, b) => compareAnalysisPriority(a, b, targets, asOf));
    let reviewSelection: SearchReviewSelection | undefined;
    if (automaticPhotos) {
        const eligibleForReview = (listing: ListingSummary) => buyerReviewBlock(listing, asOf) === null;
        if (dependencies.researchAuctionSellers) results = await dependencies.researchAuctionSellers(results, asOf, signal);
        let eligible = results.filter(eligibleForReview);
        if (eligible.length <= FIRST_REVIEW_COUNT && dependencies.prioritizeText) {
            results = await dependencies.prioritizeText(results, targets, signal);
            eligible = results.filter(eligibleForReview);
        }
        if (signal?.aborted) return [];
        try {
            reviewSelection = eligible.length > FIRST_REVIEW_COUNT && dependencies.selectReviews
                ? await dependencies.selectReviews(eligible, targets, signal, asOf) : ruleSelection(eligible, asOf);
        } catch (error) {
            if (signal?.aborted) return [];
            throw error;
        }
        if (signal?.aborted) return [];
        // Auctions may close while the buyer's ranking request is in flight.
        results = results.filter(listing => {
            if (listing.buyingOption !== "AUCTION" || Date.parse(listing.endTime ?? "") > Date.now()) return true;
            rejections.set(listing.id, "OUTSIDE_AUCTION_WINDOW");
            return false;
        });
        const retained = new Set(results.map(listing => listing.id));
        if (reviewSelection.listingIds.some(id => !retained.has(id))) {
            reviewSelection = ruleSelection(eligible.filter(listing => retained.has(listing.id)), asOf);
        }
        const positions = new Map(reviewSelection.listingIds.map((id, index) => [id, index]));
        results.sort((a, b) => (positions.get(a.id) ?? FIRST_REVIEW_COUNT) - (positions.get(b.id) ?? FIRST_REVIEW_COUNT));
    }
    onStart({ ...summary(results.length), ...(reviewSelection && { reviewSelection }) });
    for (const listing of results) {
        if (signal?.aborted) return [];
        onListing(listing);
    }
    for (const [id, reason] of rejections) onSourceDisposition({ id, outcome: "REJECTED", reason });
    for (const id of deferred) onSourceDisposition({ id, outcome: "NOT_REACHED", reason: "ENOUGH_CANDIDATES" });
    if (onCompetition && dependencies.competition && !newOnly && market) {
        // A useful buying comparison can exist even when the retained rows
        // need research or every current ask exceeds the profitable ceiling.
        // This bounded lookup shares the search account and uses the user's
        // price bounds. It never enters the paid queue or sets resale value.
        const timeout = AbortSignal.timeout(15_000);
        const competitionSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const reference = await dependencies.competition(query, market.reference, market.expectedNet, targets,
            listingFilters.maxPrice, competitionSignal, { minPrice: listingFilters.minPrice }).catch(error => {
                if (competitionSignal.aborted && error === competitionSignal.reason ||
                    error instanceof EbayBudgetError && error.reason === "QUOTA" || error instanceof EbayError || error instanceof ProviderError) return undefined;
                throw error;
            });
        if (reference && !competitionSignal.aborted) {
            onCompetition(reference);
            const { checkedAt, pricing } = reference;
            const { grader, grade } = market.reference;
            if (onCollectorEvidence && checkedAt && pricing && grader && grade) {
                await onCollectorEvidence({ query: search, asOf: checkedAt, listing: { ...reference, checkedAt, pricing },
                    reference: market.reference, ...(reference.identity !== "LISTING" && {
                        label: { grader, grade, source: "Matched slab label in the seller's photo" },
                    }) });
            }
        }
    }
    return results;
}

// The caller's validated hunt already supplies the intent and owns the budget.
// Independent release scans in that hunt share one price-screening allowance.
export function createHuntInventoryScanner(signal: AbortSignal, dependencies = defaultSteps) {
    const createSource = dependencies.priceSource;
    const stopped = new AbortController();
    const active = AbortSignal.any([signal, stopped.signal]);
    let source: ReturnType<typeof createScreeningPriceSource> | undefined;
    const remaining = new Map<string, DiscoveryBacklog>();
    const exhausted = new Set<string>();
    const observed = new Map<string, Set<string>>();
    return async (query: string, intent: SearchIntent, filters: ListingFilters, targets: Targets, asOf: number, scan: InventoryScan): Promise<{
        listings: ListingSummary[]; summary: SearchSummary; hasMore?: boolean; sourcePages?: number; activeSearchTotal?: number; backlog?: DiscoveryBacklog;
    }> => {
        active.throwIfAborted();
        const key = JSON.stringify([query, intent, filters, targets, asOf]);
        if (exhausted.has(key)) return { listings: [], hasMore: false, sourcePages: 0,
            summary: { intent, mode: "development", deferred: 0, total: 0, found: 0, count: 0, skipped: 0 } };
        if (!observed.has(key) && scan.resumeBacklog) remaining.set(key, scan.resumeBacklog);
        const seen = observed.get(key) ?? new Set<string>();
        observed.set(key, seen);
        const found = new Set<string>();
        const dispositions: SourceDispositionRow[] = [];
        const overflow: ScreenedOverflowRow[] = [];
        const excludedPrices: ListingSummary[] = [];
        let sourcePages = 0;
        let activeSearchTotal: number | undefined;
        let summary: SearchSummary | undefined;
        const listings = await findDealsBatch(query, { signal: active, filters, targets, asOf,
            onSourceDisposition: row => dispositions.push(row),
            onPriceExcluded: row => excludedPrices.push(row),
            onScreenedOverflow: row => overflow.push(row),
            onProgress: value => scan.onProgress?.({ ...value, found: found.size }),
            onStart: value => { summary = value; } }, {
            ...dependencies, readIntent: async () => intent, releaseYears: async () => intent.releaseYears ?? null,
            search: async (...args) => {
                const page = await dependencies.search(...args);
                if (sourcePages === 0 && filters.typeFilter === "FIXED_PRICE" && !args[1]?.anyCategory &&
                    Number.isSafeInteger(page.total) && page.total >= 0) activeSearchTotal = page.total;
                await scan.diagnostic?.("page", { query, providerQuery: args[0], providerFilters: args[1]?.filters, intent, filters, targets, asOf, offset: args[1]?.offset ?? 0,
                    sort: args[1]?.sort, page });
                sourcePages++;
                for (const row of page.listings) if (!seen.has(row.id)) { found.add(row.id); seen.add(row.id); }
                return page;
            },
            ...(createSource && { priceSource: () => source ??= createSource({ signal: active }) }),
        }, remaining.get(key), { ...scan, onBacklog: backlog => {
            if (backlog) remaining.set(key, backlog);
            else { remaining.delete(key); exhausted.add(key); }
        } }).catch(error => { stopped.abort(error); throw error; });
        active.throwIfAborted();
        if (!summary) throw new Error("The inventory scan stopped before the listing summary finished.");
        await scan.diagnostic?.("screened", { query, summary, dispositions, overflow, listings, excludedPrices,
            pending: remaining.get(key)?.pending.map(row => row.id) ?? [] });
        return { listings, summary: { ...summary, found: found.size }, hasMore: remaining.has(key), sourcePages, activeSearchTotal, backlog: remaining.get(key) };
    };
}

/** Continuations reuse their original request and allowance; caller-supplied filters cannot widen one. */
export async function findDeals(search: string, options: SearchOptions = {}, dependencies?: FindSteps): Promise<ListingSummary[]> {
    if (!options.continuation) return findDealsBatch(search, options, dependencies);
    const { receipt, reused } = await discoveryContinuations.run(options.continuation, getAiUsageContext().searchId, search, async (state, signal) => {
        let summary: SearchSummary | undefined;
        const dispositions: SourceDispositionRow[] = [], overflow: ScreenedOverflowRow[] = [];
        const listings = await withAiUsageContext({ watchBudgetId: state.rootSearchId }, () => findDealsBatch(state.request.search, {
            ...options, ...state.request, signal,
            onStart: value => { summary = value; options.onStart?.(value); },
            onSourceDisposition: row => { dispositions.push(row); options.onSourceDisposition?.(row); },
            onScreenedOverflow: row => { overflow.push(row); options.onScreenedOverflow?.(row); },
        }, dependencies, state));
        if (!summary) throw new Error("The continued search stopped before its batch could be saved.");
        return { summary, listings, dispositions, overflow } satisfies DiscoveryBatchReceipt;
    }, options.signal);
    if (reused) {
        options.onStart?.(receipt.summary);
        for (const listing of receipt.listings) options.onListing?.(listing);
        for (const row of receipt.dispositions) options.onSourceDisposition?.(row);
        for (const row of receipt.overflow) options.onScreenedOverflow?.(row);
    }
    return receipt.listings;
}
