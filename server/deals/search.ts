import { findDeals, type SearchSummary } from "./find-deals.ts";
import { digDeeper } from "./dig.ts";
import { recoverSearchPricing } from "./recover-pricing.ts";
import type { ListingSummary } from "../../shared/types.ts";
import type { PricingRecoveryProgress } from "../../shared/pricing-retries.ts";

export interface DiscoveryProgress {
    status: "checking" | "done" | "error";
    checked: number;
    total: number;
    note?: string;
}

// Normal results stream first. Extra discovery is part of the same cancellable
// search, shares its criteria, and never checks the same listing twice.
export async function searchWithDiscovery(
    search: string,
    options: NonNullable<Parameters<typeof findDeals>[1]> & { onDiscovery?: (progress: DiscoveryProgress) => void; onPricing?: (progress: PricingRecoveryProgress) => void;
        onPricingListing?: (listing: ListingSummary, snapshotKey: string) => void } = {},
    steps: { find: typeof findDeals; discover: typeof digDeeper; recover?: typeof recoverSearchPricing } = { find: findDeals, discover: digDeeper, recover: recoverSearchPricing }
): Promise<void> {
    let summary: SearchSummary | undefined;
    const snapshots = new Map<string, ListingSummary>();
    const emit = (listing: ListingSummary) => { snapshots.set(listing.id, listing); options.onListing?.(listing); };
    const listings = await steps.find(search, {
        ...options,
        onListing: emit,
        onStart: (value) => { summary = value; options.onStart?.(value); },
    });
    for (const listing of listings) if (!snapshots.has(listing.id)) snapshots.set(listing.id, listing);
    if (options.signal?.aborted) return;
    let checked = 0;
    let total = 0;
    options.onDiscovery?.({ status: "checking", checked, total });
    try {
        await steps.discover(search, {
            ...options,
            onListing: emit,
            intent: summary?.intent,
            excludeIds: listings.map((listing) => listing.id),
            primaryListings: listings,
            onStart: (value) => {
                total = value.total;
                options.onDiscovery?.({ status: "checking", checked, total });
            },
            onProgress: (done, count) => {
                checked = done;
                total = count;
                options.onDiscovery?.({ status: "checking", checked, total });
            },
        });
        if (!options.signal?.aborted) options.onDiscovery?.({ status: "done", checked, total });
    } catch (error) {
        // Extra coverage failing must not discard the normal search's results.
        if (!options.signal?.aborted) options.onDiscovery?.({
            status: "error", checked, total,
            note: error instanceof Error ? error.message : "Extra discovery couldn't finish.",
        });
    }
    if (!options.signal?.aborted) await steps.recover?.([...snapshots.values()], {
        signal: options.signal, targets: options.targets, includeOffers: options.includeOffers,
        onListing: (listing, snapshotKey) => { snapshots.set(listing.id, listing);
            if (options.onPricingListing) options.onPricingListing(listing, snapshotKey); else options.onListing?.(listing); }, onProgress: options.onPricing,
    });
}
