import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "../lib/paths.ts";
import { jsonStore } from "../lib/json-store.ts";
import { normalizeText } from "../ebay/filters.ts";
import type { ListingFilters } from "../../shared/listing-filters.ts";

export function searchHistoryKey(query: string, minimum: number, filters: ListingFilters = {}): string {
    const scope = [filters.typeFilter ?? "all", filters.kindFilter ?? "all", filters.maxPrice ?? null];
    const parts: unknown[] = [normalizeText(query).trim().replace(/\s+/g, " "), Math.max(0, filters.minPrice ?? minimum)];
    // Keep existing unfiltered history readable, while a different search scope
    // cannot hide listings that have never been screened with those filters.
    if (scope[0] !== "all" || scope[1] !== "all" || scope[2] !== null) parts.push(scope);
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

interface History { version: 1; searches: Record<string, { at: number; ids: string[] }> }
export function createSearchHistory(file = path.join(DATA_DIR, "search-history.json")) {
    const data = jsonStore<History>(file, () => ({ version: 1, searches: {} }), (value): value is History => {
        const history = value as History | null;
        return history?.version === 1 && Boolean(history.searches) && typeof history.searches === "object" && Object.values(history.searches).every((entry) => Array.isArray(entry.ids) && entry.ids.every((id) => typeof id === "string") && typeof entry.at === "number");
    });
    return {
        seen: async (query: string, minimum: number, filters?: ListingFilters) => (await data.read()).searches[searchHistoryKey(query, minimum, filters)]?.ids ?? [],
        remember: (query: string, minimum: number, ids: readonly string[], filters?: ListingFilters) => data.change((history) => {
            const name = searchHistoryKey(query, minimum, filters);
            history.searches[name] = { at: Date.now(), ids: [...new Set([...(history.searches[name]?.ids ?? []), ...ids])].slice(-20_000) };
            for (const [old] of Object.entries(history.searches).sort(([, a], [, b]) => b.at - a.at).slice(50)) delete history.searches[old];
        }),
    };
}
export const searchHistory = createSearchHistory();
