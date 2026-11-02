import type { ListingFilters } from "../../shared/listing-filters.ts";

export function readListingFilters(query: Record<string, unknown>): ListingFilters {
    const price = (value: unknown) => typeof value === "string" && value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined;
    return {
        typeFilter: query.type === "AUCTION" || query.type === "FIXED_PRICE" ? query.type : "all",
        kindFilter: query.kind === "raw" || query.kind === "graded" ? query.kind : "all",
        maxPrice: price(query.ceiling),
        minPrice: price(query.min),
    };
}
