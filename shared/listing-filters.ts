import type { BuyingOption, Evaluation, ListingSummary } from "./types.ts";
import { observedCardKind } from "./photo-evidence.ts";
import { searchPhotosFitDetails } from "./listing-evidence.ts";

export const AUTOMATIC_PRICE_CEILING = 200_000;
export const AUTOMATIC_AUCTION_WINDOW_HOURS = 12;

export interface ListingFilters {
    typeFilter?: BuyingOption | "all";
    kindFilter?: "raw" | "graded" | "all";
    minPrice?: number;
    maxPrice?: number;
}

// Admission uses metadata; downstream callers can supply matching saved photo
// evidence. A predicted raw grade never makes a card a certified slab, and a
// low auction opening bid is not a Buy It Now price.
export function matchesListingFilters(listing: ListingSummary, filters: ListingFilters = {}, evaluation?: Evaluation | null, requestedGraded?: boolean | null): boolean {
    if (filters.typeFilter && filters.typeFilter !== "all" && listing.buyingOption !== filters.typeFilter) return false;
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
        const actual = observed ?? (listing.isGraded ? "graded" : "raw");
        if (wantedKinds.some(kind => actual !== kind)) return false;
    }
    if (listing.currentPrice !== null && listing.currentPrice > (filters.maxPrice ?? Infinity)) return false;
    return listing.buyingOption !== "FIXED_PRICE" || (listing.currentPrice ?? 0) >= (filters.minPrice ?? 0);
}

export function withinAutomaticAuctionWindow(listing: Pick<ListingSummary, "buyingOption" | "endTime">, now = Date.now()): boolean {
    if (listing.buyingOption !== "AUCTION") return true;
    const end = Date.parse(listing.endTime ?? "");
    return Number.isFinite(end) && end > now && end - now <= AUTOMATIC_AUCTION_WINDOW_HOURS * 3600000;
}

export function worthScreening(listing: ListingSummary, filters: ListingFilters = {}, asOf = Date.now()): boolean {
    return withinAutomaticAuctionWindow(listing, asOf) &&
        (listing.buyingOption !== "AUCTION" || Date.parse(listing.endTime ?? "") > Date.now()) &&
        (listing.currentPrice ?? 0) <= AUTOMATIC_PRICE_CEILING && matchesListingFilters(listing, filters);
}
