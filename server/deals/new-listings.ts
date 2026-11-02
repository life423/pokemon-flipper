import { findDeals } from "./find-deals.ts";
import { searchHistory, searchHistoryKey } from "../search/history.ts";
import { ebayUsage, EbayBudgetError } from "../ebay/usage.ts";
import { recoverSearchPricing } from "./recover-pricing.ts";
import type { ListingSummary } from "../../shared/types.ts";
import type { PricingRecoveryProgress } from "../../shared/pricing-retries.ts";
import { worthScreening } from "../../shared/listing-filters.ts";

export const NEW_SCREEN_LIMIT = 200;
export function createNewListingDiscovery({ find = findDeals, history = searchHistory, usage = ebayUsage, recover = recoverSearchPricing } = {}) {
    const running = new Set<string>();
    return async (query: string, options: NonNullable<Parameters<typeof findDeals>[1]> & { developmentLimit?: number; onPricing?: (progress: PricingRecoveryProgress) => void;
        onPricingListing?: (listing: ListingSummary, snapshotKey: string) => void }, knownIds: readonly string[] = []) => {
        options = { ...options, asOf: options.asOf ?? Date.now() };
        const minimum = options.filters?.minPrice ?? options.minPrice ?? 0;
        const filters = { ...options.filters, minPrice: minimum };
        const key = searchHistoryKey(query, minimum, filters);
        if (running.has(key)) throw new Error("New-listing discovery for this search is already running. Wait for it to finish.");
        running.add(key);
        const seen = new Set<string>();
        const snapshots = new Map<string, ListingSummary>();
        try {
            options.signal?.throwIfAborted();
            if ((await usage())?.braking) throw new EbayBudgetError("New-listing discovery is paused to preserve the rest of today's eBay allowance.");
            const previous = await history.seen(query, minimum, filters);
            await find(query, { ...options, ...(options.developmentLimit !== undefined ? { screenLimit: options.developmentLimit, maxResults: 200 } : {}),
                newOnly: { excludeIds: [...new Set([...previous, ...knownIds])], limit: options.developmentLimit ?? NEW_SCREEN_LIMIT },
                onListing: (listing) => { if (!worthScreening(listing, filters, options.asOf)) return; seen.add(listing.id); snapshots.set(listing.id, listing); options.onListing?.(listing); } });
            if (options.developmentLimit === undefined) await recover([...snapshots.values()], { signal: options.signal, targets: options.targets, includeOffers: options.includeOffers,
                onListing: (listing, key) => { if (options.onPricingListing) options.onPricingListing(listing, key); else options.onListing?.(listing); }, onProgress: options.onPricing });
        } finally {
            try { if (seen.size) await history.remember(query, minimum, [...seen], filters); }
            finally { running.delete(key); }
        }
    };
}
export const discoverNewListings = createNewListingDiscovery();
