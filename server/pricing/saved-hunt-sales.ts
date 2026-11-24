import { parseListingLink } from "../../shared/listing-link.ts";
import { readCache } from "../lib/cache.ts";
import { getSqlRepositories, storageBackend } from "../storage/index.ts";
import { CONFIRMED_SALE_TYPES, uniqueSoldComps } from "./sold-comps.ts";
import { soldMarketParams } from "./pkmnprices.ts";
import type { Comp } from "./types.ts";

interface SoldPage { data: Comp[]; pagination?: { has_more?: boolean; next_cursor?: string } }
const maxAge = 30 * 24;

export function confirmedHuntPage(record: number | string, variant: string, grader: string | null, grade: number | string | null) {
    const params = soldMarketParams(variant, grader, grade);
    params.set("sale_type", CONFIRMED_SALE_TYPES.join(","));
    return `pkmnprices:/cards/${record}/listings/ebay?${params}`;
}

async function readPages(keys: string[], now: number): Promise<Map<string, SoldPage>> {
    const pages = new Map<string, SoldPage>();
    if (storageBackend() === "file") {
        await Promise.all(keys.map(async key => {
            const page = await readCache<SoldPage>(key, maxAge);
            if (page && Array.isArray(page.data)) pages.set(key, page);
        }));
    } else {
        const rows = await (await getSqlRepositories()).readCacheEntries(keys);
        for (const row of rows) {
            const age = now - Date.parse(row.savedAt);
            const page = row.data as SoldPage | null;
            if (age >= 0 && age < maxAge * 3600_000 && page && Array.isArray(page.data)) pages.set(row.key, page);
        }
    }
    return pages;
}

// A legacy evaluation omitted sale type. Use the original provider rows only
// when the retained sale is present in the same market's confirmed USD stream.
export async function savedHuntSaleRows(roots: Map<string, Set<string>>, now: number, signal?: AbortSignal, read = readPages) {
    const groups = new Map<string, Comp[]>();
    let next = [...roots.keys()].map(root => ({ root, key: root }));
    const seen = new Set<string>();
    for (let depth = 0; next.length && depth < 4; depth++) {
        const following: typeof next = [];
        for (let i = 0; i < next.length; i += 24) {
            signal?.throwIfAborted();
            const batch = next.slice(i, i + 24);
            const pages = await read(batch.map(row => row.key), now);
            for (const { root, key } of batch) {
                seen.add(key);
                const page = pages.get(key);
                if (!page) continue;
                const sales = groups.get(root) ?? [];
                for (const sale of page.data) {
                    const link = parseListingLink(sale.listing_url);
                    if (link && roots.get(root)?.has(link.itemId)) sales.push(sale);
                }
                groups.set(root, sales);
                const cursor = page.pagination?.next_cursor;
                if (page.pagination?.has_more && cursor) {
                    const key = root + "&" + new URLSearchParams({ cursor });
                    if (!seen.has(key)) following.push({ root, key });
                }
            }
        }
        next = following;
    }
    signal?.throwIfAborted();
    return new Map([...groups].map(([root, rows]) => [root, new Map(uniqueSoldComps(rows).map(s =>
        [parseListingLink(s.listing_url)!.itemId, s]))]));
}
