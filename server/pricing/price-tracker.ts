import { readCache, writeCache } from "../lib/cache.ts";
import { conditionOf } from "./raw-prices.ts";
import { cardVariants } from "./records.ts";
import type { CardRecord } from "./types.ts";
import { setKey } from "../../shared/sets.ts";

// PokemonPriceTracker. Kept as a cross-check: its raw prices are split
// by printing, but its graded sales mix printings.

const BASE = "https://www.pokemonpricetracker.com/api/v2";
const SEARCH_LIMIT = 5;

interface TrackerPrice {
    price?: number;
    lastUpdated?: string;
}

interface TrackerCard {
    tcgPlayerId: number;
    name: string;
    setName: string;
    cardNumber: string;
    prices?: { variants?: Record<string, Record<string, TrackerPrice>> };
}

// A PokemonPriceTracker card in the shape identity and pricing expect.
export function fromPokemonPriceTracker(record: TrackerCard): CardRecord {
    const variants = record.prices?.variants ?? {};

    return {
        source: "pokemonPriceTracker",
        id: record.tcgPlayerId,
        name: record.name,
        setName: record.setName,
        cardNumber: record.cardNumber,
        tcgPlayerId: record.tcgPlayerId,
        variants: cardVariants(Object.keys(variants), record.setName, (label) =>
            Object.entries(variants[label])
                .filter(([, entry]) => typeof entry?.price === "number")
                .map(([condition, entry]) => ({
                    condition: conditionOf(condition),
                    price: entry.price as number,
                    updatedAt: entry.lastUpdated ?? null,
                }))
        ),
    };
}

// A PokemonPriceTracker request, with a failure turned into a message.
async function trackerGet(path: string): Promise<{ data?: unknown; metadata?: { hasMore?: boolean } }> {
    const apiKey = process.env.POKEMON_PRICE_TRACKER_API_KEY;

    if (!apiKey) {
        throw new Error("POKEMON_PRICE_TRACKER_API_KEY is not set");
    }

    const response = await fetch(`${BASE}${path}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(
            `PokemonPriceTracker request failed (${response.status}): ${body.error ?? body.message ?? "unknown error"}`
        );
    }

    return body;
}

export async function lookupCards({ set, name }: { set: string; name: string }): Promise<CardRecord[]> {
    const params = new URLSearchParams({ set, search: name, limit: String(SEARCH_LIMIT) });
    const key = `pokemonpricetracker:cards?${params}`;
    const cached = await readCache<TrackerCard[]>(key, 24);

    if (cached) return cached.map(fromPokemonPriceTracker);

    const body = await trackerGet(`/cards?${params}`);
    const cards: TrackerCard[] = Array.isArray(body.data) ? body.data : body.data ? [body.data as TrackerCard] : [];

    await writeCache(key, cards);
    return cards.map(fromPokemonPriceTracker);
}

const YEARS_KEY = "pokemonpricetracker:set-years";
const MONTH_HOURS = 24 * 30;
const SETS_PAGE = 100;
const MOST_SET_PAGES = 20;

// Each English set's release year, by set key (shared/sets.ts), for every
// set PokemonPriceTracker knows. Saved for a month: sets don't change.
export async function setYears(): Promise<Record<string, number>> {
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
}
