import { findDeals, type SearchSummary } from "./find-deals.ts";
import { digDeeper } from "./dig.ts";

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
    options: NonNullable<Parameters<typeof findDeals>[1]> & { onDiscovery?: (progress: DiscoveryProgress) => void } = {},
    steps = { find: findDeals, discover: digDeeper }
): Promise<void> {
    let summary: SearchSummary | undefined;
    const listings = await steps.find(search, {
        ...options,
        onStart: (value) => { summary = value; options.onStart?.(value); },
    });
    if (options.signal?.aborted) return;
    let checked = 0;
    let total = 0;
    options.onDiscovery?.({ status: "checking", checked, total });
    try {
        await steps.discover(search, {
            ...options,
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
}
