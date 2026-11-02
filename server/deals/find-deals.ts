import { detailRequestCount, searchListings } from "../ebay/listings.ts";
import { mapLimit } from "../lib/concurrency.ts";
import { readSearch } from "../search/intent.ts";
import { cardMismatch, gradingMatches, titleMatches } from "../search/relevance.ts";
import { readTitle } from "../ai/title-reader.ts";
import type { ListingSummary, SearchIntent, Targets } from "../../shared/types.ts";
import { criteriaMismatch, marketplaceQuery, searchAttributes } from "../../shared/search-criteria.ts";
import { AI_CONCURRENCY } from "../../shared/work-limits.ts";
import { screeningSteps, screenListing } from "./screen-listing.ts";

// Preserve the existing public screening imports for scripts and tests.
export { screeningSteps, screenListing, shippingCouldChange, REAL_STEPS } from "./screen-listing.ts";
export type { ScreenSteps } from "./screen-listing.ts";

// A search, the way eBay matches it, narrowed to the card searched for,
// with every listing screened using cached rules, prices and AI title reads. eBay limits listing-detail
// requests per day, so the first check runs on the search result alone,
// with its title read by the AI. Only listings that pass, or whose title
// left something out, get their full eBay details and a second check.
// Preliminary estimates rank full AI work rather than prohibit it.

// eBay returns 200 a page in best-match order; later pages are mostly loose
// matches, so 400 by default, and up to 1,000 when asked.
const DEFAULT_RESULTS = 400;
const MOST_RESULTS = 1000;
const PARALLEL_LISTINGS = AI_CONCURRENCY;

export interface SearchSummary {
    mode?: "new";
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
    }: {
        onStart?: (summary: SearchSummary) => void;
        onListing?: (listing: ListingSummary) => void;
        maxResults?: number;
        // Buy It Now listings under this are skipped; auctions aren't affected.
        minPrice?: number;
        // A stopped search: the listings not yet checked are skipped, so no
        // more eBay requests or AI calls go out.
        signal?: AbortSignal;
        targets?: Targets;
        includeOffers?: boolean;
        newOnly?: { excludeIds: readonly string[]; limit: number };
    } = {}
): Promise<ListingSummary[]> {
    if (signal?.aborted) return [];
    const intent = await readSearch(search, signal);
    if (signal?.aborted) return [];
    const limit = Math.min(MOST_RESULTS, Math.max(200, Math.round(maxResults / 200) * 200));
    const { listings, total, skipped } = await searchListings(marketplaceQuery(search, intent), { maxResults: newOnly ? 200 : limit, signal, ...(newOnly ? { sort: "newlyListed" as const, keepReserve: true } : {}) });
    if (signal?.aborted) return [];
    const now = Date.now();
    const requestsBefore = detailRequestCount();

    const live = listings.filter((listing) => !listing.endTime || Date.parse(listing.endTime) > now);
    const excluded = new Set(newOnly?.excludeIds ?? []);
    const unseen = live.filter((listing) => !excluded.has(listing.id));
    const eligible = unseen.filter(
        (listing) =>
            titleMatches(listing.title, intent) &&
            gradingMatches(listing.isGraded, intent) &&
            !criteriaMismatch(searchAttributes(listing.title), intent, false) &&
            !(listing.buyingOption === "FIXED_PRICE" && (listing.currentPrice ?? 0) < minPrice)
    );

    const matching = newOnly ? eligible.slice(0, newOnly.limit) : eligible;
    onStart({ total, found: live.length, count: matching.length, skipped, intent,
        ...(newOnly ? { mode: "new", deferred: Math.max(0, eligible.length - matching.length), previouslySeen: live.length - unseen.length } : {}) });

    // Every title queued for reading at once, so the AI gets full batches
    // of 25, but not waited on: each listing is checked as soon as its own
    // title comes back, so results start arriving within seconds.
    if (signal?.aborted) return [];
    for (const listing of matching) void readTitle(listing.title, signal);

    const steps = screeningSteps(targets, includeOffers, signal);

    const results = await mapLimit(matching, PARALLEL_LISTINGS, async (listing) => {
        if (signal?.aborted) return null;

        let screened: ListingSummary;
        try {
            screened = await screenListing(listing, steps, intent, signal);
        } catch (error) {
            if (signal?.aborted) return null;
            throw error;
        }
        if (signal?.aborted) return null;
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
