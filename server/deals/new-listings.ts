import { findDeals } from "./find-deals.ts";
import { searchHistory, searchHistoryKey } from "../search/history.ts";
import { ebayUsage, EbayBudgetError } from "../ebay/usage.ts";
import { worthScreening } from "../../shared/listing-filters.ts";

export function createNewListingDiscovery({ find = findDeals, history = searchHistory, usage = ebayUsage } = {}) {
    const running = new Set<string>();
    return async (query: string, options: NonNullable<Parameters<typeof findDeals>[1]>, knownIds: readonly string[] = []) => {
        options = { ...options, asOf: options.asOf ?? Date.now() };
        const minimum = options.filters?.minPrice ?? options.minPrice ?? 0;
        const filters = { ...options.filters, minPrice: minimum };
        const key = searchHistoryKey(query, minimum, filters);
        if (running.has(key)) throw new Error("New-listing discovery for this search is already running. Wait for it to finish.");
        running.add(key);
        const seen = new Set<string>();
        try {
            options.signal?.throwIfAborted();
            if ((await usage())?.braking) throw new EbayBudgetError("New-listing discovery is paused to preserve the rest of today's eBay allowance.");
            const previous = await history.seen(query, minimum, filters);
            await find(query, { ...options,
                newOnly: { excludeIds: [...new Set([...previous, ...knownIds])] },
                onListing: listing => { if (!worthScreening(listing, filters, options.asOf)) return; seen.add(listing.id); options.onListing?.(listing); } });
        } finally {
            try { if (seen.size) await history.remember(query, minimum, [...seen], filters); }
            finally { running.delete(key); }
        }
    };
}
export const discoverNewListings = createNewListingDiscovery();
