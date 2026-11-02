import type { BuyingOption, ListingSummary } from "./types.ts";

export const AUTOMATIC_PRICE_CEILING = 200_000;
export const AUTOMATIC_AUCTION_WINDOW_HOURS = 12;

export interface ListingFilters {
    typeFilter?: BuyingOption | "all";
    kindFilter?: "raw" | "graded" | "all";
    minPrice?: number;
    maxPrice?: number;
}

// Only facts already available in a search result belong here. A potential
// raw grade still needs photos; a low auction opening bid is not a BIN price.
export function matchesListingFilters(listing: ListingSummary, filters: ListingFilters = {}): boolean {
    if (filters.typeFilter && filters.typeFilter !== "all" && listing.buyingOption !== filters.typeFilter) return false;
    if (filters.kindFilter && filters.kindFilter !== "all" && listing.isGraded !== (filters.kindFilter === "graded")) return false;
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
