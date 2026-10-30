import { findDeals } from "./find-deals.ts";
import { searchHistory } from "../search/history.ts";
import { ebayUsage, EbayBudgetError } from "../ebay/usage.ts";
import { normalizeText } from "../ebay/filters.ts";
import { recoverSearchPricing } from "./recover-pricing.ts";
import type { ListingSummary } from "../../shared/types.ts";
import type { PricingRecoveryProgress } from "../../shared/pricing-retries.ts";

export const NEW_SCREEN_LIMIT = 20;
export function createNewListingDiscovery({ find = findDeals, history = searchHistory, usage = ebayUsage, recover = recoverSearchPricing } = {}) {
    const running = new Set<string>();
    return async (query: string, options: NonNullable<Parameters<typeof findDeals>[1]> & { onPricing?: (progress: PricingRecoveryProgress) => void;
        onPricingListing?: (listing: ListingSummary, snapshotKey: string) => void }, knownIds: readonly string[] = []) => {
        const key = JSON.stringify([normalizeText(query).trim().replace(/\s+/g, " "), options.minPrice ?? 0]);
        if (running.has(key)) throw new Error("New-listing discovery for this search is already running. Wait for it to finish.");
        running.add(key);
        const seen = new Set<string>();
        const snapshots = new Map<string, ListingSummary>();
        try {
            options.signal?.throwIfAborted();
            if ((await usage())?.braking) throw new EbayBudgetError("New-listing discovery is paused to preserve the rest of today's eBay allowance.");
            const previous = await history.seen(query, options.minPrice ?? 0);
            await find(query, { ...options, newOnly: { excludeIds: [...new Set([...previous, ...knownIds])], limit: NEW_SCREEN_LIMIT },
                onListing: (listing) => { seen.add(listing.id); snapshots.set(listing.id, listing); options.onListing?.(listing); } });
            await recover([...snapshots.values()], { signal: options.signal, targets: options.targets, includeOffers: options.includeOffers,
                onListing: (listing, key) => { if (options.onPricingListing) options.onPricingListing(listing, key); else options.onListing?.(listing); }, onProgress: options.onPricing });
        } finally {
            try { if (seen.size) await history.remember(query, options.minPrice ?? 0, [...seen]); }
            finally { running.delete(key); }
        }
    };
}
export const discoverNewListings = createNewListingDiscovery();
