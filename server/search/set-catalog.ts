import { readCache } from "../lib/cache.ts";
import { setKey } from "../../shared/sets.ts";

const MONTH_HOURS = 24 * 30;

// Reuse the catalog already loaded by the app. This helper never refreshes a
// provider: a missing catalog leaves the existing literal rules in place.
export function createCachedSetNames({
    load = () => readCache<Record<string, number>>("pokemonpricetracker:set-years", MONTH_HOURS),
    now = Date.now,
    ttlMs = 60_000,
} = {}) {
    let names: readonly string[] | undefined;
    let expires = 0;
    let pending: Promise<readonly string[]> | undefined;
    return (): Promise<readonly string[]> => {
        if (names && now() < expires) return Promise.resolve(names);
        return pending ??= Promise.resolve().then(load).then(years => {
            names = Object.freeze([...new Set(Object.entries(years ?? {})
                .filter(([, year]) => Number.isInteger(year) && year >= 1900 && year <= 2100)
                .map(([name]) => setKey(name)).filter(Boolean))]);
            expires = now() + ttlMs;
            return names;
        }).finally(() => { pending = undefined; });
    };
}

export const cachedSetNames = createCachedSetNames();
