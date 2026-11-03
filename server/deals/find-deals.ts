import { detailRequestCount, searchListings } from "../ebay/listings.ts";
import { mapLimit } from "../lib/concurrency.ts";
import { readSearch, readSearchWithoutAi } from "../search/intent.ts";
import { cardMismatch, gradingMatches, titleMatches, setMatches } from "../search/relevance.ts";
import { readTitle, readTitleByRules, readTitleWithoutAi } from "../ai/title-reader.ts";
import type { ListingSummary, SearchIntent, Targets } from "../../shared/types.ts";
import { criteriaMismatch, marketplaceQuery, searchAttributes } from "../../shared/search-criteria.ts";
import { AI_CONCURRENCY } from "../../shared/work-limits.ts";
import { screeningSteps, screenListing, screenListingWithoutAi } from "./screen-listing.ts";
import { AUTOMATIC_AUCTION_WINDOW_HOURS, worthScreening, type ListingFilters } from "../../shared/listing-filters.ts";
import { cardLanguageStatus, EnglishOnlyError } from "../../shared/card-language.ts";
import { sameCardNumber } from "../identity/card-identity.ts";
import { DEVELOPMENT_SEARCH_LIMIT } from "../../shared/research-policy.ts";
import { priceFirstListings, type SoldScreeningFactory } from "./price-first.ts";

// Preserve the existing public screening imports for scripts and tests.
export { screeningSteps, screenListing, shippingCouldChange, REAL_STEPS } from "./screen-listing.ts";
export type { ScreenSteps } from "./screen-listing.ts";

// The current bounded search filters metadata locally, completes reusable
// sold-market research, then emits ranked candidates for budgeted photo work.
// The legacy diagnostic path below still supports AI title/detail screening.

// eBay returns 200 a page in best-match order; later pages are mostly loose
// matches, so 400 by default, and up to 1,000 when asked.
const DEFAULT_RESULTS = 400;
const MOST_RESULTS = 1000;
const PARALLEL_LISTINGS = AI_CONCURRENCY;

function literalTitleFits(listing: ListingSummary, intent: SearchIntent): boolean {
    const reading = readTitleByRules(listing.title);
    return (!reading.kind || reading.kind === "SINGLE_CARD") && setMatches(reading.set, intent) &&
        (!intent.cardNumber || !reading.cardNumber || sameCardNumber(intent.cardNumber, reading.cardNumber));
}

interface FindSteps {
    readIntent: typeof readSearch;
    search: typeof searchListings;
    readTitle: typeof readTitle;
    screening: typeof screeningSteps;
    readIntentWithoutAi?: typeof readSearchWithoutAi;
    readTitleWithoutAi?: typeof readTitleWithoutAi;
    soldScreening?: SoldScreeningFactory;
}

export interface SearchSummary {
    mode?: "new" | "development";
    deferred?: number;
    previouslySeen?: number;
    // eBay's count for the search, and how many were fetched and kept.
    total: number;
    found: number;
    // The ones whose title names the card searched for.
    count: number;
    // Junk the free rules dropped before anything was spent.
    skipped: number;
    intent: SearchIntent;
}

// onStart runs once the search is read and eBay has answered, and
// onListing as each listing is screened, so a slow first search can show
// progress. A listing that turns out to be another set, card, printing,
// or language is still sent, marked with why it doesn't match.
export async function findDeals(
    search: string,
    {
        onStart = () => {},
        onListing = () => {},
        maxResults = DEFAULT_RESULTS,
        minPrice = 0,
        signal,
        targets,
        includeOffers = false,
        newOnly,
        filters,
        screenLimit,
        asOf = Date.now(),
        bounded = false,
    }: {
        onStart?: (summary: SearchSummary) => void;
        onListing?: (listing: ListingSummary) => void;
        maxResults?: number;
        // Buy It Now listings under this are skipped; auctions aren't affected.
        minPrice?: number;
        filters?: ListingFilters;
        // Explicit development scope: cap work before title/photo screening.
        screenLimit?: number;
        asOf?: number;
        // Server-selected workflow; preliminary sold research cannot buy AI stages.
        bounded?: boolean;
        // A stopped search: the listings not yet checked are skipped, so no
        // more eBay requests or AI calls go out.
        signal?: AbortSignal;
        targets?: Targets;
        includeOffers?: boolean;
        newOnly?: { excludeIds: readonly string[]; limit: number };
    } = {},
    dependencies: FindSteps = { readIntent: readSearch, search: searchListings, readTitle, screening: screeningSteps }
): Promise<ListingSummary[]> {
    if (signal?.aborted) return [];
    if (cardLanguageStatus(search) === "OTHER") throw new EnglishOnlyError();
    const intent = await (bounded ? dependencies.readIntentWithoutAi ?? readSearchWithoutAi : dependencies.readIntent)(search, signal);
    if (signal?.aborted) return [];
    const requestedLimit = screenLimit !== undefined && Number.isFinite(screenLimit) ? Math.max(0, Math.floor(screenLimit)) : undefined;
    const limited = bounded ? Math.min(requestedLimit ?? DEVELOPMENT_SEARCH_LIMIT, DEVELOPMENT_SEARCH_LIMIT) : requestedLimit;
    const limit = limited === undefined ? Math.min(MOST_RESULTS, Math.max(200, Math.round(maxResults / 200) * 200)) : 200;
    const { listings, total, skipped } = await dependencies.search(marketplaceQuery(search, intent), { maxResults: limited === undefined && newOnly ? 200 : limit, signal, filters, asOf, auctionEndsWithinHours: AUTOMATIC_AUCTION_WINDOW_HOURS,
        ...(newOnly || bounded && filters?.typeFilter !== "AUCTION" ? { sort: "newlyListed" as const } : {}), ...(newOnly ? { keepReserve: true } : {}) });
    if (signal?.aborted) return [];
    const now = Date.now();
    const requestsBefore = detailRequestCount();

    const live = listings.filter((listing) => !listing.endTime || Date.parse(listing.endTime) > now);
    const excluded = new Set(newOnly?.excludeIds ?? []);
    const unseen = live.filter((listing) => !excluded.has(listing.id));
    const listingFilters = { ...filters, minPrice: filters?.minPrice ?? minPrice };
    const eligible = unseen.filter(
        (listing) =>
            worthScreening(listing, listingFilters, asOf) && titleMatches(listing.title, intent) &&
            gradingMatches(listing.isGraded, intent) &&
            !criteriaMismatch(searchAttributes(listing.title), intent, false) &&
            (!bounded || literalTitleFits(listing, intent))
    );

    const selected = newOnly && !bounded ? eligible.slice(0, newOnly.limit) : eligible;
    let metadataExcluded = 0;
    let matching = limited === undefined ? selected : selected.slice(0, limited);
    if (bounded) {
        // A saved title reading can identify junk or a known mismatch that the
        // literal title could not settle. Exclude it before filling the result
        // batch, then continue within this same source page. These reads cannot
        // buy title/photo AI, price lookups or listing-detail requests.
        const candidateLimit = Math.min(limited!, newOnly?.limit ?? Infinity);
        matching = [];
        for (const listing of selected) {
            if (matching.length >= candidateLimit) break;
            if (signal?.aborted) return [];
            let screened: ListingSummary;
            try { screened = await screenListingWithoutAi(listing, intent, signal, dependencies.readTitleWithoutAi ?? readTitleWithoutAi); }
            catch (error) { if (signal?.aborted) return []; throw error; }
            if (signal?.aborted) return [];
            const mismatch = screened.match ?? cardMismatch(screened.screen, intent);
            if ((mismatch && mismatch !== "UNCONFIRMED_CRITERIA") || !worthScreening(screened, listingFilters, asOf)) {
                metadataExcluded++;
                continue;
            }
            matching.push(mismatch ? { ...screened, match: mismatch } : screened);
        }
    }
    onStart({ total, found: live.length, count: matching.length, skipped, intent,
        ...(newOnly || limited !== undefined ? { mode: limited === undefined ? "new" : "development", deferred: Math.max(0, eligible.length - matching.length - metadataExcluded),
            ...(newOnly ? { previouslySeen: live.length - unseen.length } : {}) } : {}) });

    // Legacy screening batches title reads. Bounded admission cannot enqueue
    // that paid work, even when the caller asks for a larger result count.
    if (signal?.aborted) return [];
    if (bounded) {
        try { matching = await priceFirstListings(matching, intent, { signal, targets, includeOffers, now: asOf }, dependencies.soldScreening); }
        catch (error) { if (signal?.aborted) return []; throw error; }
        if (signal?.aborted) return [];
    }
    if (!bounded) for (const listing of matching) if (worthScreening(listing, listingFilters, asOf)) void dependencies.readTitle(listing.title, signal);

    const steps = bounded ? null : dependencies.screening(targets, includeOffers, signal);

    const results = await mapLimit(matching, PARALLEL_LISTINGS, async (listing) => {
        if (signal?.aborted || !worthScreening(listing, listingFilters, asOf)) return null;

        let screened: ListingSummary;
        try {
            screened = bounded ? listing
                : await screenListing(listing, steps!, intent, signal);
        } catch (error) {
            if (signal?.aborted) return null;
            throw error;
        }
        if (signal?.aborted || !worthScreening(screened, listingFilters, asOf)) return null;
        const mismatch = screened.match ?? cardMismatch(screened.screen, intent);
        const result = mismatch ? { ...screened, match: mismatch } : screened;

        onListing(result);

        return result;
    });

    console.log(
        `Search ${JSON.stringify(search)}: ${matching.length} listings checked with ${detailRequestCount() - requestsBefore} eBay detail requests`
    );

    return results.filter((result): result is ListingSummary => result !== null);
}
