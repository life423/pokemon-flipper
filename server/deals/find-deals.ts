import { searchListings } from "../ebay/listings.ts";
import { readSearchWithAi } from "../search/query-assistance.ts";
import { cardMismatch, gradingMatches, titleMatches, setMatches } from "../search/relevance.ts";
import { readTitleByRules, readTitleWithoutAi } from "../ai/title-reader.ts";
import type { ListingSummary, SearchIntent, Targets } from "../../shared/types.ts";
import { criteriaMismatch, marketplaceQuery, searchAttributes } from "../../shared/search-criteria.ts";
import { screenListingWithoutAi } from "./screen-listing.ts";
import { AUTOMATIC_AUCTION_WINDOW_HOURS, worthScreening, type ListingFilters } from "../../shared/listing-filters.ts";
import { cardLanguageStatus, EnglishOnlyError } from "../../shared/card-language.ts";
import { sameCardNumber } from "../identity/card-identity.ts";
import { DEVELOPMENT_SEARCH_LIMIT } from "../../shared/research-policy.ts";
import { createPriceFirstSession, type SoldScreeningFactory } from "./price-first.ts";
import { analysisPriority, compareAnalysisPriority } from "../../shared/analysis-priority.ts";
import { prioritizeListingText } from "./listing-text-priority.ts";
import { createScreeningPriceSource } from "../pricing/pkmnprices.ts";
import { canAutoAnalyze } from "../../shared/analysis.ts";
import { EbayBudgetError } from "../ebay/usage.ts";
import { EbayError } from "../ebay/api.ts";
import { ProviderError } from "../lib/http.ts";

const SOURCE_PAGE_LIMIT = 200;
const MIN_NEWEST_CANDIDATES = 3;

function literalTitleFits(listing: ListingSummary, intent: SearchIntent): boolean {
    const reading = readTitleByRules(listing.title, intent.sets);
    return (!reading.kind || reading.kind === "SINGLE_CARD") && setMatches(reading.set, intent) &&
        (!intent.cardNumber || !reading.cardNumber || sameCardNumber(intent.cardNumber, reading.cardNumber));
}

interface FindSteps {
    readIntent: typeof readSearchWithAi;
    search: typeof searchListings;
    readTitle: typeof readTitleWithoutAi;
    soldScreening?: SoldScreeningFactory;
    priceSource?: typeof createScreeningPriceSource;
    prioritizeText?: typeof prioritizeListingText;
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
    pricePass?: { status: "COMPLETE" | "UNAVAILABLE"; newListings: number; candidates: number };
}

export interface SearchOptions {
    onStart?: (summary: SearchSummary) => void;
    onListing?: (listing: ListingSummary) => void;
    // Internal observation for new-ID discovery history; not an emitted result
    // or a lasting rejection of this listing under other terms or targets.
    onPriceExcluded?: (listing: ListingSummary) => void;
    minPrice?: number;
    signal?: AbortSignal;
    targets?: Targets;
    includeOffers?: boolean;
    automaticPhotos?: boolean;
    newOnly?: { excludeIds: readonly string[] };
    filters?: ListingFilters;
    asOf?: number;
}

// Screen the newest page first. When it yields few candidates, a standard BIN
// search can sample one lower-priced page within the same search allowances.
export async function findDeals(search: string, {
    onStart = () => {}, onListing = () => {}, onPriceExcluded = () => {}, minPrice = 0, signal, targets,
    includeOffers = false, automaticPhotos = false, newOnly, filters, asOf = Date.now(),
}: SearchOptions = {}, dependencies: FindSteps = {
    readIntent: readSearchWithAi, search: searchListings, readTitle: readTitleWithoutAi,
    priceSource: createScreeningPriceSource, prioritizeText: prioritizeListingText,
}): Promise<ListingSummary[]> {
    if (signal?.aborted) return [];
    if (cardLanguageStatus(search) === "OTHER") throw new EnglishOnlyError();
    let intent = await dependencies.readIntent(search, signal);
    if (signal?.aborted) return [];
    const screenPrices = createPriceFirstSession(intent, { signal, targets, includeOffers, now: asOf, sourceFactory: dependencies.priceSource }, dependencies.soldScreening);
    try { intent = await screenPrices.resolveIntent(); }
    catch (error) { if (signal?.aborted) return []; throw error; }
    if (signal?.aborted) return [];
    const listingFilters = { ...filters, minPrice: filters?.minPrice ?? minPrice };
    const query = marketplaceQuery(search, intent);
    const sourceOptions = {
        maxResults: SOURCE_PAGE_LIMIT, signal, filters: listingFilters, asOf, auctionEndsWithinHours: AUTOMATIC_AUCTION_WINDOW_HOURS,
    };
    const firstPage = await dependencies.search(query, {
        ...sourceOptions,
        ...(newOnly || filters?.typeFilter !== "AUCTION" ? { sort: "newlyListed" as const } : {}),
        ...(newOnly ? { keepReserve: true } : {}),
    });
    if (signal?.aborted) return [];
    const now = Date.now();
    const loaded = new Map<string, ListingSummary>();
    const considered = new Set<string>();
    const deferred = new Set<string>();
    const excluded = new Set(newOnly?.excludeIds ?? []);
    let previouslySeen = 0, screenedCount = 0, priceExcluded = 0;
    let total = firstPage.total, skipped = firstPage.skipped, started = false;
    let pricePass: SearchSummary["pricePass"];
    const summary = (count: number): SearchSummary => ({ total, found: loaded.size, count, skipped, intent, mode: "development",
        deferred: deferred.size, screened: screenedCount, priceExcluded,
        ...(newOnly ? { previouslySeen } : {}), ...(pricePass ? { pricePass } : {}),
    });

    async function screenPage(listings: ListingSummary[]) {
        const eligible = new Map<string, ListingSummary>();
        for (const row of listings.slice(0, SOURCE_PAGE_LIMIT)) {
            if (row.endTime && !(Date.parse(row.endTime) > now)) continue;
            const listing = loaded.get(row.id) ?? row;
            if (!loaded.has(row.id)) {
                loaded.set(row.id, row);
                if (excluded.has(row.id)) previouslySeen++;
            }
            if (considered.has(row.id) || eligible.has(row.id) || excluded.has(row.id)) continue;
            if (worthScreening(listing, listingFilters, asOf) && titleMatches(listing.title, intent) &&
                gradingMatches(listing.isGraded, intent) && !criteriaMismatch(searchAttributes(listing.title), intent, false) && literalTitleFits(listing, intent)) {
                eligible.set(row.id, listing);
                deferred.add(row.id);
            }
        }
        const matching: ListingSummary[] = [];
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
                    onPriceExcluded(listing);
                } else matching.push(listing);
            }
            batch = [];
        }
        for (const listing of eligible.values()) {
            if (matching.length >= DEVELOPMENT_SEARCH_LIMIT) break;
            signal?.throwIfAborted();
            considered.add(listing.id);
            deferred.delete(listing.id);
            const screened = await screenListingWithoutAi(listing, intent, signal, dependencies.readTitle);
            const mismatch = screened.match ?? cardMismatch(screened.screen, intent);
            if ((mismatch && mismatch !== "UNCONFIRMED_CRITERIA") || !worthScreening(screened, listingFilters, asOf)) continue;
            batch.push(mismatch ? { ...screened, match: mismatch } : screened);
            if (matching.length + batch.length >= DEVELOPMENT_SEARCH_LIMIT) await priceBatch();
        }
        if (batch.length) await priceBatch();
        return matching;
    }

    let matching: ListingSummary[];
    try {
        matching = await screenPage(firstPage.listings);
        const newestCandidates = matching.filter(canAutoAnalyze);
        const hasPreliminaryMargin = (listing: ListingSummary) => analysisPriority(listing, targets).band > 0;
        const promising = newestCandidates.filter(hasPreliminaryMargin).length;
        const canWiden = total > SOURCE_PAGE_LIMIT || deferred.size > 0;
        if (!newOnly && filters?.typeFilter === "FIXED_PRICE" && canWiden && promising < MIN_NEWEST_CANDIDATES) {
            let cheaperPage: typeof firstPage | undefined;
            try { cheaperPage = await dependencies.search(query, { ...sourceOptions, sort: "price", keepReserve: true }); }
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
                const cheaper = await screenPage(cheaperPage.listings);
                const cheaperCandidates = cheaper.filter(canAutoAnalyze);
                const candidates = [...newestCandidates, ...cheaperCandidates]
                    .sort((a, b) => Number(hasPreliminaryMargin(b)) - Number(hasPreliminaryMargin(a)))
                    .slice(0, DEVELOPMENT_SEARCH_LIMIT);
                // A full page of near misses must still leave room for cheaper
                // candidates with a plausible margin. Equal bands keep newest first.
                const unresolved = [...matching, ...cheaper].filter(listing => !canAutoAnalyze(listing));
                matching = [...candidates, ...unresolved.slice(0, DEVELOPMENT_SEARCH_LIMIT - candidates.length)];
                const admitted = new Set(candidates.map(listing => listing.id));
                pricePass = { status: "COMPLETE", newListings: loaded.size - before,
                    candidates: cheaperCandidates.filter(listing => admitted.has(listing.id)).length };
            }
        }
    } catch (error) { if (signal?.aborted) return []; throw error; }
    if (signal?.aborted) return [];
    onStart(summary(matching.length));
    let ordered = matching.sort((a, b) => compareAnalysisPriority(a, b, targets));
    if (automaticPhotos && dependencies.prioritizeText) ordered = await dependencies.prioritizeText(ordered, targets, signal);
    const results: ListingSummary[] = [];
    for (const listing of ordered) {
        if (signal?.aborted) return [];
        if (!worthScreening(listing, listingFilters, asOf)) continue;
        const mismatch = listing.match ?? cardMismatch(listing.screen, intent);
        const result = mismatch ? { ...listing, match: mismatch } : listing;
        onListing(result);
        results.push(result);
    }
    return results;
}
