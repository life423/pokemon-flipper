import type { HuntMarketPreferences } from "../../shared/deal-hunt.ts";
import type { ListingFilters } from "../../shared/listing-filters.ts";
import { yearOf, setKey } from "../../shared/sets.ts";
import { sameCardNumber } from "../../shared/card-number.ts";
import { setYears } from "../pricing/price-tracker.ts";
import { searchWebCatalog } from "../ai/web-catalog-research.ts";
import { ProviderError } from "../lib/http.ts";
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
    activeDays?: number;
}

interface GuidanceSources {
    years?: typeof setYears;
    observedSet?: () => string | null;
    chooseWeb?: (releases: string[]) => Promise<boolean>;
    web?: typeof searchWebCatalog;
    report?: (note: string) => void;
}

export async function webInventoryTargets(seed: string, permitted: string[], kind: ListingFilters["kindFilter"],
    now: number, signal: AbortSignal, acceptsSet: (set: string) => boolean, report?: (note: string) => void,
    catalog = catalogSample, rank = rankCatalogMarkets, web = searchWebCatalog): Promise<InventoryTarget[]> {
    signal.throwIfAborted();
    try {
        const hints = await web(seed, permitted, signal);
        const pool = new Map<number, CatalogCard>();
        for (const hint of hints) {
            if (!hint.number.includes("/") || !acceptsSet(hint.set) ||
                permitted.length && !permitted.some(set => setKey(set) === setKey(hint.set))) continue;
            signal.throwIfAborted();
            const result = await catalog(new URLSearchParams({ name: hint.name, number: hint.number.split("/")[0], language: "English", per_page: "20" }));
            for (const card of (result.data ?? []) as CatalogCard[]) {
                if (!Number.isSafeInteger(card?.id) || card.id <= 0 || !card.set?.name || !card.number || !card.total_set_number ||
                    !sameSetFamily(card.set.name, hint.set) || !acceptsSet(card.set.name) || !sameCatalogName(card.name, hint.name) ||
                    !sameCardNumber(card.number + "/" + card.total_set_number, hint.number) || pool.has(card.id)) continue;
                pool.set(card.id, card);
                report?.(`The catalog confirmed ${card.name} ${hint.number} in ${card.set.name}. Source ${hint.url}`);
            }
        }
        if (!pool.size) {
            report?.("The web search supplied no catalog-confirmed cards within your filters.");
            return [];
        }
        const ranked = await rank(pool.values(), kind, now, signal);
        const measured = new Set(ranked.map(card => card.id));
        const unmeasured = [...pool.values()].filter(card => !measured.has(card.id)).map(card => ({
            name: card.name, number: card.number + "/" + card.total_set_number, set: card.set!.name!,
        }));
        return [...ranked, ...unmeasured].map(target => ({ ...target, stage: "Catalog-checked web lead" }));
    } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof ProviderError) || error instanceof PricingProviderError && error.kind !== "TEMPORARY") throw error;
        report?.("The optional web or catalog lookup was temporarily unavailable.");
        return [];
    }
}

export async function* guidedInventoryTargets(seed: NonNullable<HuntMarketPreferences["seed"]>, sets: string[],
    kind: ListingFilters["kindFilter"], now: number, signal: AbortSignal, acceptsSet: (set: string) => boolean,
    catalog = catalogSample, rank = rankCatalogMarkets, sources: GuidanceSources = {}): AsyncGenerator<InventoryTarget> {
    for (const set of sets.length ? sets : [null]) {
        signal.throwIfAborted();
        yield { name: seed.name, number: seed.number, set, stage: "Your starting card" };
    }
    if (!seed.expand || seed.number || !seed.name) return;
    try {
        let sameSets = sets.filter(acceptsSet);
        let nearby: string[] = [];
        let yieldedObservedSet = false;
        if (!sets.length) {
            const observed = sources.observedSet?.();
            if (observed && !acceptsSet(observed)) return;
            // A confirmed listing can lead straight to the same set, even while the catalog is slow.
            if (observed) {
                yieldedObservedSet = true;
                yield { name: null, number: null, set: observed, stage: "Widening to the same set" };
            }
            let releases: string[] = [];
            try {
                const lookup = await catalog(new URLSearchParams({ name: seed.name, language: "English", per_page: "50" }));
                if (!observed && (lookup.data?.length >= 50 || lookup.pagination?.has_more || lookup.pagination?.total_pages > 1)) {
                    sources.report?.("The catalog returned only part of the named card’s printings. A confirmed release is needed for related cards.");
                    return;
                }
                const matching: CatalogCard[] = (lookup.data ?? []).filter((card: CatalogCard) => card.set?.name && acceptsSet(card.set.name) &&
                    sameCatalogName(card.name?.replace(/\s*\([A-Z]*\d+\)$/i, ""), seed.name!));
                releases = [...new Set(matching.map(card => card.set!.name!))];
            } catch (error) {
                signal.throwIfAborted();
                if (!observed || !(error instanceof PricingProviderError && error.kind === "TEMPORARY")) throw error;
            }
            sameSets = observed ? [observed] : releases;
            if (!sameSets.length) return;
            const years = await (sources.years ?? setYears)();
            const anchorYears = sameSets.map(set => yearOf(years, set));
            const dated = anchorYears.filter((y): y is number => y !== null);
            // A name used decades apart cannot identify the buyer's intended release.
            if (sameSets.length > 1 && (dated.length !== sameSets.length || Math.max(...dated) - Math.min(...dated) > 2)) {
                sources.report?.("The named card appears in multiple eras. Related-card searches need a specific release.");
                return;
            }
            nearby = Object.keys(years).filter(set => acceptsSet(set) && !sameSets.some(anchor => sameSetFamily(set, anchor)) &&
                dated.some(year => years[set] <= year))
                .sort((a, b) => Math.min(...dated.map(y => Math.abs(y - years[a]))) - Math.min(...dated.map(y => Math.abs(y - years[b]))) || a.localeCompare(b));
            // Keep known related printings within the resolved release years.
            for (const set of releases.filter(set => nearby.some(s => sameSetFamily(set, s)))) {
                yield { name: seed.name, number: null, set, stage: "Same Pokémon from a nearby release" };
            }
        }
        for (const set of yieldedObservedSet ? [] : sameSets) {
            signal.throwIfAborted();
            yield { name: null, number: null, set, stage: "Widening to the same set" };
        }
        const permitted = [...sameSets, ...nearby];
        if (permitted.length && await sources.chooseWeb?.(permitted)) {
            yield* await webInventoryTargets(seed.name, permitted, kind, now, signal, acceptsSet, sources.report, catalog, rank, sources.web);
        }
        for (const set of nearby) {
            signal.throwIfAborted();
            yield { set, number: null, name: null, stage: "Cards from the same year or an older release" };
        }
    } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof PricingProviderError && error.kind === "TEMPORARY")) throw error;
        sources.report?.("The catalog could not establish another eligible release for this card.");
    }
}
