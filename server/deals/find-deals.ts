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
import { priceFirstListings, type SoldScreeningFactory } from "./price-first.ts";

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
}

export interface SearchOptions {
    onStart?: (summary: SearchSummary) => void;
    onListing?: (listing: ListingSummary) => void;
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
    onStart = () => {}, onListing = () => {}, minPrice = 0, signal, targets,
    includeOffers = false, newOnly, filters, asOf = Date.now(),
}: SearchOptions = {}, dependencies: FindSteps = {
    readIntent: readSearchWithoutAi, search: searchListings, readTitle: readTitleWithoutAi,
}): Promise<ListingSummary[]> {
    if (signal?.aborted) return [];
    if (cardLanguageStatus(search) === "OTHER") throw new EnglishOnlyError();
    const intent = await dependencies.readIntent(search, signal);
    if (signal?.aborted) return [];
    const { listings, total, skipped } = await dependencies.search(marketplaceQuery(search, intent), {
        maxResults: 200, signal, filters, asOf, auctionEndsWithinHours: AUTOMATIC_AUCTION_WINDOW_HOURS,
        ...(newOnly || filters?.typeFilter !== "AUCTION" ? { sort: "newlyListed" as const } : {}),
        ...(newOnly ? { keepReserve: true } : {}),
    });
    if (signal?.aborted) return [];
    const now = Date.now();
    const live = listings.filter(listing => !listing.endTime || Date.parse(listing.endTime) > now);
    const excluded = new Set(newOnly?.excludeIds ?? []);
    const unseen = live.filter(listing => !excluded.has(listing.id));
    const listingFilters = { ...filters, minPrice: filters?.minPrice ?? minPrice };
    const eligible = unseen.filter(listing => worthScreening(listing, listingFilters, asOf) && titleMatches(listing.title, intent) &&
        gradingMatches(listing.isGraded, intent) && !criteriaMismatch(searchAttributes(listing.title), intent, false) && literalTitleFits(listing, intent));

    let metadataExcluded = 0;
    const matching: ListingSummary[] = [];
    for (const listing of eligible) {
        if (matching.length >= DEVELOPMENT_SEARCH_LIMIT) break;
        if (signal?.aborted) return [];
        let screened: ListingSummary;
        try { screened = await screenListingWithoutAi(listing, intent, signal, dependencies.readTitle); }
        catch (error) { if (signal?.aborted) return []; throw error; }
        if (signal?.aborted) return [];
        const mismatch = screened.match ?? cardMismatch(screened.screen, intent);
        if ((mismatch && mismatch !== "UNCONFIRMED_CRITERIA") || !worthScreening(screened, listingFilters, asOf)) {
            metadataExcluded++;
            continue;
        }
        matching.push(mismatch ? { ...screened, match: mismatch } : screened);
    }
    onStart({ total, found: live.length, count: matching.length, skipped, intent, mode: "development",
        deferred: Math.max(0, eligible.length - matching.length - metadataExcluded),
        ...(newOnly ? { previouslySeen: live.length - unseen.length } : {}),
    });
    if (signal?.aborted) return [];
    let priced: ListingSummary[];
    try { priced = await priceFirstListings(matching, intent, { signal, targets, includeOffers, now: asOf }, dependencies.soldScreening); }
    catch (error) { if (signal?.aborted) return []; throw error; }
    const results: ListingSummary[] = [];
    for (const listing of priced) {
        if (signal?.aborted) return [];
        if (!worthScreening(listing, listingFilters, asOf)) continue;
        const mismatch = listing.match ?? cardMismatch(listing.screen, intent);
        const result = mismatch ? { ...listing, match: mismatch } : listing;
        onListing(result);
        results.push(result);
    }
    return results;
}
