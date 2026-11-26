import { catalogSample, recentVolume } from "./pkmnprices.ts";
import { PricingProviderError } from "./errors.ts";
import type { ListingFilters } from "../../shared/listing-filters.ts";

export interface Market { id: number; name: string; set: string; number: string; sales: number; activeDays?: number }
export type CatalogCard = { id: number; name: string; number: string; total_set_number: string; set?: { name?: string } };
type Volume = { date: string; sales: number; currency: string; graded: boolean; variant?: string | null };

// These are benchmark candidates. Only measured sales can put one on the shortlist.
const benchmarks = [["Charizard ex", "199", "165"], ["Umbreon VMAX", "215", "203"],
    ["Pikachu", "173", "165"], ["Gengar VMAX", "271", "264"], ["Mewtwo VSTAR", "GG44", "GG70"], ["Lugia V", "186", "195"]];

export async function liquidMarkets(kind: ListingFilters["kindFilter"], now: number, signal: AbortSignal,
    catalog = catalogSample, volume = recentVolume): Promise<Market[]> {
    const day = Math.floor(now / 86400000), pool = new Map<number, CatalogCard>();
    const add = (card: CatalogCard) => {
        if (Number.isSafeInteger(card?.id) && card.id > 0 && card.set?.name && card.name && card.number && card.total_set_number)
            pool.set(card.id, card);
    };
    for (let i = 0; i < 3; i++) {
        signal.throwIfAborted();
        const [name, number, total] = benchmarks[(day + i) % benchmarks.length];
        const params = new URLSearchParams({ language: "English", name, number, total_set_number: total, per_page: "4" });
        const response = await catalog(params);
        for (const c of response.data ?? []) if (c.name?.toLowerCase() === name.toLowerCase() && c.number === number && c.total_set_number === total) add(c);
    }
    // Include catalog discoveries independent of previous searches and familiar names.
    const bands = [["10", "35"], ["35", "100"], ["100", "300"]];
    for (const [low, high] of bands) {
        signal.throwIfAborted();
        const params = new URLSearchParams({ language: "English", min_price: low, max_price: high,
            currency: "usd", sort: "price_desc", per_page: "3", page: String(1 + day % 12) });
        for (const c of (await catalog(params)).data ?? []) add(c);
    }
    return rankCatalogMarkets(pool.values(), kind, now, signal, volume);
}

export async function rankCatalogMarkets(cards: Iterable<CatalogCard>, kind: ListingFilters["kindFilter"], now: number,
    signal: AbortSignal, volume = recentVolume): Promise<Market[]> {
    const ranked: Market[] = [];
    const earliest = new Date(now - 6 * 86400000).toISOString().slice(0, 10), today = new Date(now).toISOString().slice(0, 10);
    const graded = kind === "graded" ? true : kind === "raw" ? false : undefined;
    for (const card of cards) {
        signal.throwIfAborted();
        try {
            const result = await volume(card.id, graded);
            const buckets = new Map<string, number>();
            const days = new Set<string>();
            for (const r of (result.data ?? []) as Volume[]) {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || r.date < earliest || r.date > today || r.currency !== "USD" ||
                    typeof r.graded !== "boolean" || (graded !== undefined && r.graded !== graded) || !Number.isSafeInteger(r.sales) || r.sales <= 0) continue;
                days.add(r.date);
                buckets.set(JSON.stringify([r.date, r.graded, r.variant ?? null]), r.sales);
            }
            const sales = [...buckets.values()].reduce((a, b) => a + b, 0);
            const activeDays = days.size;
            if (sales) ranked.push({ id: card.id, name: card.name, set: card.set!.name!,
                number: card.number + "/" + card.total_set_number, sales, activeDays });
        } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof PricingProviderError && error.kind === "TEMPORARY")) throw error;
            break;
        }
    }
    const priority = (market: Market) => market.sales * (market.activeDays ?? 1);
    return ranked.sort((a, b) => priority(b) - priority(a) || b.sales - a.sales || a.name.localeCompare(b.name));
}
