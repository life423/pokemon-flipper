import type { ListingFilters, MarketplaceOrder } from "../../shared/listing-filters.ts";

export function readMarketplaceOrder(value: unknown): MarketplaceOrder | undefined {
    return value === "newest" || value === "lowest" ? value : undefined;
}

export function readListingFilters(query: Record<string, unknown>): ListingFilters {
    const price = (value: unknown) => typeof value === "string" && value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined;
    return {
        typeFilter: query.type === "AUCTION" || query.type === "FIXED_PRICE" ? query.type : "all",
        kindFilter: query.kind === "raw" || query.kind === "graded" ? query.kind : "all",
        maxPrice: price(query.ceiling ?? query.max),
        minPrice: price(query.min),
    };
}
