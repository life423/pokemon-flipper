import { readCache, writeCache } from "../lib/cache.ts";
import { setKey } from "../../shared/sets.ts";
import { fetchJson } from "../lib/http.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { createSingleFlight } from "../lib/single-flight.ts";
const limit = createLimiter(2);
const share = createSingleFlight();

const BASE = "https://www.pokemonpricetracker.com/api/v2";

// A PokemonPriceTracker request, with a failure turned into a message.
async function trackerGet(path: string): Promise<{ data?: unknown; metadata?: { hasMore?: boolean } }> {
    const apiKey = process.env.POKEMON_PRICE_TRACKER_API_KEY;

    if (!apiKey) {
        throw new Error("POKEMON_PRICE_TRACKER_API_KEY is not set");
    }

    const { response, body } = await limit(async () => {
        const { assertSqlStorageReady } = await import("../storage/index.ts");
        await assertSqlStorageReady();
        return fetchJson(`${BASE}${path}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        }, { service: "PokemonPriceTracker" });
    });

    if (!response.ok) {
        throw new Error(
            `PokemonPriceTracker request failed (${response.status}): ${body.error ?? body.message ?? "unknown error"}`
        );
    }

    return body;
}

const YEARS_KEY = "pokemonpricetracker:set-years";
const MONTH_HOURS = 24 * 30;
const SETS_PAGE = 100;
const MOST_SET_PAGES = 20;

// Each English set's release year, by set key (shared/sets.ts), for every
// set PokemonPriceTracker knows. Saved for a month: sets don't change.
export async function setYears(): Promise<Record<string, number>> {
    return share(YEARS_KEY, async () => {
    const cached = await readCache<Record<string, number>>(YEARS_KEY, MONTH_HOURS);

    if (cached) return cached;

    const years: Record<string, number> = {};

    for (let page = 0; page < MOST_SET_PAGES; page += 1) {
        const body = await trackerGet(`/sets?limit=${SETS_PAGE}&offset=${page * SETS_PAGE}`);
        const sets = Array.isArray(body.data)
            ? (body.data as { name: string; releaseDate?: string | null; language?: string }[])
            : [];

        for (const set of sets) {
            if (set.language && !/english/i.test(set.language)) continue;

            const year = set.releaseDate ? new Date(set.releaseDate).getUTCFullYear() : Number.NaN;
            if (Number.isFinite(year)) years[setKey(set.name)] ??= year;
        }

        if (!body.metadata?.hasMore || sets.length === 0) break;
    }

    await writeCache(YEARS_KEY, years);
    return years;
    });
}
