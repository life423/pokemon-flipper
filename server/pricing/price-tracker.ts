import { readCache, writeCache } from "./cache.ts";
import { conditionOf } from "./raw-prices.ts";
import { cardVariants } from "./records.ts";
import type { CardRecord } from "./types.ts";

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

export async function lookupCards({ set, name }: { set: string; name: string }): Promise<CardRecord[]> {
    const params = new URLSearchParams({ set, search: name, limit: String(SEARCH_LIMIT) });
    const key = `pokemonpricetracker:cards?${params}`;
    const cached = await readCache<TrackerCard[]>(key, 24);

    if (cached) return cached.map(fromPokemonPriceTracker);

    const apiKey = process.env.POKEMON_PRICE_TRACKER_API_KEY;

    if (!apiKey) {
        throw new Error("POKEMON_PRICE_TRACKER_API_KEY is not set");
    }

    const response = await fetch(`${BASE}/cards?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(
            `PokemonPriceTracker request failed (${response.status}): ${body.error ?? body.message ?? "unknown error"}`
        );
    }

    const cards: TrackerCard[] = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
    await writeCache(key, cards);

    return cards.map(fromPokemonPriceTracker);
}
