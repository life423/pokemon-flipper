import { searchListings } from "../ebay/listings.ts";
import { readSearchWithoutAi } from "../search/intent.ts";
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
import { compareAnalysisPriority } from "../../shared/analysis-priority.ts";

const SOURCE_PAGE_LIMIT = 200;

function literalTitleFits(listing: ListingSummary, intent: SearchIntent): boolean {
    const reading = readTitleByRules(listing.title);
    return (!reading.kind || reading.kind === "SINGLE_CARD") && setMatches(reading.set, intent) &&
        (!intent.cardNumber || !reading.cardNumber || sameCardNumber(intent.cardNumber, reading.cardNumber));
}

interface FindSteps {
    readIntent: typeof readSearchWithoutAi;
    search: typeof searchListings;
    readTitle: typeof readTitleWithoutAi;
    soldScreening?: SoldScreeningFactory;
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
    newOnly?: { excludeIds: readonly string[] };
    filters?: ListingFilters;
    asOf?: number;
}

// One live source page, local/saved metadata, then reusable sold-price research.
// Full photo assessments are a separate queue with their own persistent budget.
export async function findDeals(search: string, {
    onStart = () => {}, onListing = () => {}, onPriceExcluded = () => {}, minPrice = 0, signal, targets,
    includeOffers = false, newOnly, filters, asOf = Date.now(),
}: SearchOptions = {}, dependencies: FindSteps = {
    readIntent: readSearchWithoutAi, search: searchListings, readTitle: readTitleWithoutAi,
}): Promise<ListingSummary[]> {
    if (signal?.aborted) return [];
    if (cardLanguageStatus(search) === "OTHER") throw new EnglishOnlyError();
    const intent = await dependencies.readIntent(search, signal);
    if (signal?.aborted) return [];
    const { listings, total, skipped } = await dependencies.search(marketplaceQuery(search, intent), {
        maxResults: SOURCE_PAGE_LIMIT, signal, filters, asOf, auctionEndsWithinHours: AUTOMATIC_AUCTION_WINDOW_HOURS,
        ...(newOnly || filters?.typeFilter !== "AUCTION" ? { sort: "newlyListed" as const } : {}),
        ...(newOnly ? { keepReserve: true } : {}),
    });
    if (signal?.aborted) return [];
    const now = Date.now();
    // The transport normally deduplicates, but neither a repeated ID nor an
    // oversized saved/injected page may multiply research or fill result slots.
    const sourcePage = listings.slice(0, SOURCE_PAGE_LIMIT);
    const ids = new Set<string>();
    const live = sourcePage.filter(listing => {
        if (ids.has(listing.id)) return false;
        ids.add(listing.id);
        return !listing.endTime || Date.parse(listing.endTime) > now;
    });
    const excluded = new Set(newOnly?.excludeIds ?? []);
    const unseen = live.filter(listing => !excluded.has(listing.id));
    const listingFilters = { ...filters, minPrice: filters?.minPrice ?? minPrice };
    const eligible = unseen.filter(listing => worthScreening(listing, listingFilters, asOf) && titleMatches(listing.title, intent) &&
        gradingMatches(listing.isGraded, intent) && !criteriaMismatch(searchAttributes(listing.title), intent, false) && literalTitleFits(listing, intent));

    let cursor = 0, screenedCount = 0, priceExcluded = 0, started = false;
    const matching: ListingSummary[] = [];
    const screenPrices = createPriceFirstSession(intent, { signal, targets, includeOffers, now: asOf }, dependencies.soldScreening);
    const summary = (): SearchSummary => ({ total, found: live.length, count: matching.length, skipped, intent, mode: "development",
        deferred: eligible.length - cursor, screened: screenedCount, priceExcluded,
        ...(newOnly ? { previouslySeen: live.length - unseen.length } : {}),
    });
    while (cursor < eligible.length && matching.length < DEVELOPMENT_SEARCH_LIMIT) {
        const batch: ListingSummary[] = [];
        const remaining = DEVELOPMENT_SEARCH_LIMIT - matching.length;
        while (cursor < eligible.length && batch.length < remaining) {
            const listing = eligible[cursor++];
            if (signal?.aborted) return [];
            let screened: ListingSummary;
            try { screened = await screenListingWithoutAi(listing, intent, signal, dependencies.readTitle); }
            catch (error) { if (signal?.aborted) return []; throw error; }
            if (signal?.aborted) return [];
            const mismatch = screened.match ?? cardMismatch(screened.screen, intent);
            if ((mismatch && mismatch !== "UNCONFIRMED_CRITERIA") || !worthScreening(screened, listingFilters, asOf)) {
                continue;
            }
            batch.push(mismatch ? { ...screened, match: mismatch } : screened);
        }
        if (!batch.length) break;
        if (!started) { onStart({ ...summary(), count: batch.length }); started = true; }
        if (signal?.aborted) return [];
        let priced: ListingSummary[];
        try { priced = await screenPrices(batch); }
        catch (error) { if (signal?.aborted) return []; throw error; }
        screenedCount += batch.length;
        // Confident price exclusions do not consume display slots. Unknown or
        // deferred prices remain visible Sorting work, not discarded inventory.
        for (const listing of priced) {
            if (signal?.aborted) return [];
            if (listing.screen?.status === "DROPPED") {
                priceExcluded++;
                onPriceExcluded(listing);
            }
            else matching.push(listing);
        }
    }
    if (signal?.aborted) return [];
    onStart(summary());
    const results: ListingSummary[] = [];
    for (const listing of matching.sort((a, b) => compareAnalysisPriority(a, b, targets))) {
        if (signal?.aborted) return [];
        if (!worthScreening(listing, listingFilters, asOf)) continue;
        const mismatch = listing.match ?? cardMismatch(listing.screen, intent);
        const result = mismatch ? { ...listing, match: mismatch } : listing;
        onListing(result);
        results.push(result);
    }
    return results;
}
