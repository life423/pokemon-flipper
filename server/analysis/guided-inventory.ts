import type { HuntMarketPreferences } from "../../shared/deal-hunt.ts";
import type { ListingFilters } from "../../shared/listing-filters.ts";
import { sameCatalogName } from "../identity/catalog-name.ts";
import { sameSetFamily } from "../identity/card-identity.ts";
import { catalogSample } from "../pricing/pkmnprices.ts";
import { rankCatalogMarkets, type CatalogCard } from "../pricing/liquid-markets.ts";
import { PricingProviderError } from "../pricing/errors.ts";

export interface InventoryTarget {
    name: string | null;
    number: string | null;
    set: string | null;
    stage?: string;
    sales?: number;
}

// Membership is checked against catalog rows, including when a denominator is shared by multiple releases.
const vintage = [
    ["Aquapolis", "147"], ["Fossil", "62"], ["Jungle", "64"], ["Team Rocket", "82"], ["Base Set", "102"],
] as const;

export async function* guidedInventoryTargets(seed: NonNullable<HuntMarketPreferences["seed"]>, sets: string[],
    kind: ListingFilters["kindFilter"], now: number, signal: AbortSignal, acceptsSet: (set: string) => boolean,
    catalog = catalogSample, rank = rankCatalogMarkets): AsyncGenerator<InventoryTarget> {
    for (const set of sets.length ? sets : [null]) {
        signal.throwIfAborted();
        yield { name: seed.name, number: seed.number, set, stage: "Your starting card" };
    }
    if (!seed.expand || seed.number || !seed.name) return;
    try {
        let related = sets;
        if (!sets.length) {
            signal.throwIfAborted();
            const params = new URLSearchParams({ name: seed.name, language: "English", per_page: "20" });
            // Try the e-reader release first, then sample other catalog-confirmed releases.
            const aquapolis = acceptsSet("Aquapolis") ? await catalog(new URLSearchParams([...params, ["total_set_number", "147"]])) : null;
            const matching = (cards: CatalogCard[]) => cards.filter(card => card.set?.name && acceptsSet(card.set.name) &&
                sameCatalogName(card.name?.replace(/\s*\([A-Z]*\d+\)$/i, ""), seed.name!));
            const preferred = matching(aquapolis?.data ?? []).find(card => sameSetFamily(card.set?.name, "Aquapolis"));
            const other = preferred ?? matching((await catalog(params)).data ?? [])[0];
            related = other?.set?.name ? [other.set.name] : [];
        }
        for (const set of related) {
            signal.throwIfAborted();
            if (acceptsSet(set)) yield { name: null, number: null, set, stage: "Widening to the same set" };
        }
        if (sets.length) return;
        const pool: CatalogCard[] = [];
        for (const [set, total] of vintage.filter(([set]) => acceptsSet(set) && !related.some(s => sameSetFamily(set, s))).slice(0, 3)) {
            signal.throwIfAborted();
            const page = await catalog(new URLSearchParams({ total_set_number: total, language: "English",
                currency: "usd", min_price: "10", sort: "price_desc", per_page: "3" }));
            pool.push(...(page.data ?? []).filter((c: CatalogCard) => c?.set?.name && sameSetFamily(c.set.name, set) &&
                c.number && c.total_set_number && c.name && !sameCatalogName(c.name, seed.name!)));
        }
        for (const target of await rank(pool, kind, now, signal)) yield { ...target, stage: "Widening to a vintage card with recent sales" };
    } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof PricingProviderError)) throw error;
        // Never invent a related release or volume when the provider cannot establish one.
    }
}
