import { withinOpportunityWindow } from "./auction-window.ts";
import type { BuyingOption, Evaluation, ListingSummary } from "./types.ts";
import { observedCardKind } from "./photo-evidence.ts";
import { searchPhotosFitDetails } from "./listing-evidence.ts";

export const AUTOMATIC_PRICE_CEILING = 200_000;
export { AUCTION_OPPORTUNITY_HOURS as AUTOMATIC_AUCTION_WINDOW_HOURS } from "./auction-window.ts";

export type MarketplaceOrder = "newest" | "lowest";
export type DiscoveryOrder = MarketplaceOrder | "ending";

export interface ListingFilters {
    typeFilter?: BuyingOption | "all";
    kindFilter?: "raw" | "graded" | "all";
    minPrice?: number;
    maxPrice?: number;
}

// Admission uses metadata; downstream callers can supply matching saved photo
// evidence. A predicted raw grade never makes a card a certified slab, and a
// low auction opening bid is not a Buy It Now price.
export function listingFilterBlock(listing: ListingSummary, filters: ListingFilters, evaluation?: Evaluation | null, requestedGraded?: boolean | null) {
    if (filters.typeFilter && filters.typeFilter !== "all" && listing.buyingOption !== filters.typeFilter) return "LISTING_FORMAT";
    // Query words and the explicit control are independent constraints. A
    // contradictory selection does not silently discard either requirement.
    const wantedKinds = [filters.kindFilter, typeof requestedGraded === "boolean" ? requestedGraded ? "graded" : "raw" : null]
        .filter(kind => kind && kind !== "all");
    if (wantedKinds.length) {
        // A search thumbnail can be a subset/resolution of the assessed gallery.
        // Changed identity/photos cannot import a previous copy's holder reading.
        const sameEvidence = evaluation?.listing.id === listing.id && evaluation.listing.title.trim() === listing.title.trim() &&
            searchPhotosFitDetails(listing.images, evaluation.listing.photos ?? []);
        const observed = sameEvidence ? observedCardKind(evaluation) : null;
        const actual = observed ?? (listing.researchKind ? (evaluation ? null : listing.researchKind)
            : listing.isGraded ? "graded" : "raw");
        if (wantedKinds.some(kind => actual !== kind)) return "CARD_TYPE";
    }
    if (listing.currentPrice !== null && listing.currentPrice > (filters.maxPrice ?? Infinity)) return "ABOVE_MAX_PRICE";
    if (listing.buyingOption === "FIXED_PRICE" && !((listing.currentPrice ?? 0) >= (filters.minPrice ?? 0))) return "BELOW_MIN_PRICE";
    return null;
}

export function matchesListingFilters(listing: ListingSummary, filters: ListingFilters = {}, evaluation?: Evaluation | null, requestedGraded?: boolean | null): boolean {
    return listingFilterBlock(listing, filters, evaluation, requestedGraded) === null;
}

export function withinAutomaticAuctionWindow(listing: Pick<ListingSummary, "buyingOption" | "endTime">, now = Date.now()): boolean {
    return listing.buyingOption !== "AUCTION" || withinOpportunityWindow(listing.endTime, now);
}

export function screeningBlock(listing: ListingSummary, filters: ListingFilters = {}, asOf = Date.now()) {
    if (!withinAutomaticAuctionWindow(listing, asOf) ||
        listing.buyingOption === "AUCTION" && !(Date.parse(listing.endTime ?? "") > Date.now())) return "OUTSIDE_AUCTION_WINDOW";
    if (!((listing.currentPrice ?? 0) <= AUTOMATIC_PRICE_CEILING)) return "PRICE_ABOVE_CEILING";
    return listingFilterBlock(listing, filters);
}

export function worthScreening(listing: ListingSummary, filters: ListingFilters = {}, asOf = Date.now()): boolean {
    return screeningBlock(listing, filters, asOf) === null;
}
