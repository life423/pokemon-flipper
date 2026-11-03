import { findDeals, type SearchOptions } from "./find-deals.ts";

// Capture the search clock once so provider/cache latency cannot widen the
// auction window. Search and newest-inventory scans share the same pipeline.
export async function searchDeals(search: string, options: SearchOptions = {}, find = findDeals): Promise<void> {
    await find(search, { ...options, asOf: options.asOf ?? Date.now() });
}
