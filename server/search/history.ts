import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "../lib/paths.ts";
import { jsonStore } from "../lib/json-store.ts";
import { normalizeText } from "../ebay/filters.ts";

interface History { version: 1; searches: Record<string, { at: number; ids: string[] }> }
export function createSearchHistory(file = path.join(DATA_DIR, "search-history.json")) {
    const data = jsonStore<History>(file, () => ({ version: 1, searches: {} }), (value): value is History => {
        const history = value as History | null;
        return history?.version === 1 && Boolean(history.searches) && typeof history.searches === "object" && Object.values(history.searches).every((entry) => Array.isArray(entry.ids) && entry.ids.every((id) => typeof id === "string") && typeof entry.at === "number");
    });
    const key = (query: string, minimum: number) => createHash("sha256").update(JSON.stringify([normalizeText(query).trim().replace(/\s+/g, " "), Math.max(0, minimum)])).digest("hex");
    return {
        seen: async (query: string, minimum: number) => (await data.read()).searches[key(query, minimum)]?.ids ?? [],
        remember: (query: string, minimum: number, ids: readonly string[]) => data.change((history) => {
            const name = key(query, minimum);
            history.searches[name] = { at: Date.now(), ids: [...new Set([...(history.searches[name]?.ids ?? []), ...ids])].slice(-20_000) };
            for (const [old] of Object.entries(history.searches).sort(([, a], [, b]) => b.at - a.at).slice(50)) delete history.searches[old];
        }),
    };
}
export const searchHistory = createSearchHistory();
