import { tradedCards, type TradedCard } from "./traded-cards.ts";
import { recentPokePriceSeeds, recentSilphSeeds } from "./pokeprice-movers.ts";
import { recentMoverSeeds } from "./pricecharting-movers.ts";
import { sameCatalogName } from "../identity/catalog-name.ts";
import { sameSetFamily } from "../identity/card-identity.ts";
import { sameCardNumber } from "../../shared/card-number.ts";
import { catalogSample, recentVolume } from "./pkmnprices.ts";
import { PricingProviderError } from "./errors.ts";
import type { ListingFilters } from "../../shared/listing-filters.ts";

export interface Market { id: number; name: string; set: string; number: string; sales: number; windowDays?: number; activeDays?: number; stage?: string }
export type CatalogCard = { id: number; name: string; number: string; total_set_number: string; set?: { name?: string } };
type Volume = { date: string; sales: number; currency: string; graded: boolean; variant?: string | null };

// These are benchmark candidates. Only measured sales can put one on the shortlist.
const benchmarks = [["Charizard ex", "199", "165"], ["Umbreon VMAX", "215", "203"],
    ["Pikachu", "173", "165"], ["Gengar VMAX", "271", "264"], ["Mewtwo VSTAR", "GG44", "GG70"], ["Lugia V", "186", "195"]];

export function cachedLiquidMarkets(kind: ListingFilters["kindFilter"], now: number, signal: AbortSignal) {
    return liquidMarkets(kind, now, signal, async params => await catalogSample(params, true) ?? { data: [] },
        async (id, graded) => await recentVolume(id, graded, true) ?? { data: [] }, signal => discoverySeeds(signal, now, kind, true));
}

async function discoverySeeds(signal: AbortSignal, now: number, kind: ListingFilters["kindFilter"], cachedOnly = false): Promise<TradedCard[]> {
    const sources = await Promise.all([tradedCards(signal, cachedOnly), recentMoverSeeds(now),
        recentPokePriceSeeds(now, kind ?? "all"), recentSilphSeeds(now)]);
    const seeds: TradedCard[] = [];
    for (let i = 0; i < Math.max(...sources.map(source => source.length)); i++) {
        for (const source of sources) if (source[i]) seeds.push(source[i]);
    }
    return seeds;
}

export async function liquidMarkets(kind: ListingFilters["kindFilter"], now: number, signal: AbortSignal,
    catalog = catalogSample, volume = recentVolume, seeds = (active: AbortSignal) => discoverySeeds(active, now, kind)): Promise<Market[]> {
    const day = Math.floor(now / 86400000), pool = new Map<number, CatalogCard>();
    const add = (card: CatalogCard) => {
        if (Number.isSafeInteger(card?.id) && card.id > 0 && card.set?.name && card.name && card.number && card.total_set_number)
            pool.set(card.id, card);
    };
    // The public leaderboard pools all conditions and grades. Verify a rotating
    // subset against the English catalog and the provider's 30-day eBay totals.
    const suggestions = await seeds(signal);
    if (suggestions.length) {
        const movers = new Map<number, string>();
        const start = Math.floor(now / (6 * 3_600_000)) * 4 % suggestions.length;
        for (let i = 0; i < Math.min(4, suggestions.length); i++) {
            signal.throwIfAborted();
            const seed = suggestions[(start + i) % suggestions.length];
            const result = await catalog(new URLSearchParams({ language: "English", name: seed.name, number: seed.number, per_page: "10" }));
            for (const card of result?.data ?? []) if (sameCatalogName(card.name, seed.name) &&
                sameSetFamily(card.set?.name, seed.set) && sameCardNumber(card.number, seed.number)) {
                add(card);
                if (seed.mover) movers.set(card.id, seed.mover);
            }
        }
        const active = (await rankCatalogMarkets(pool.values(), kind, now, signal, volume)).filter(row => row.sales >= 30);
        if (active.length) return active.map(row => movers.has(row.id) ? { ...row, stage: movers.get(row.id) + " lead" } : row);
        pool.clear();
    }
    for (let i = 0; i < 3; i++) {
        signal.throwIfAborted();
        const [name, number, total] = benchmarks[(day + i) % benchmarks.length];
        const params = new URLSearchParams({ language: "English", name, number, total_set_number: total, per_page: "4" });
        const response = await catalog(params);
        for (const c of response.data ?? []) if (c.name?.toLowerCase() === name.toLowerCase() && c.number === number && c.total_set_number === total) add(c);
    }
    // Include catalog discoveries independent of previous searches and familiar names.
    const bands = [["20", "50"], ["50", "150"], ["150", "500"]];
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
    const earliest = new Date(now - 29 * 86400000).toISOString().slice(0, 10), today = new Date(now).toISOString().slice(0, 10);
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
                number: card.number + "/" + card.total_set_number, sales, activeDays, windowDays: 30 });
        } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof PricingProviderError && error.kind === "TEMPORARY")) throw error;
            break;
        }
    }
    return ranked.sort((a, b) => b.sales - a.sales || (b.activeDays ?? 0) - (a.activeDays ?? 0) ||
        a.name.localeCompare(b.name)).slice(0, 20);
}
