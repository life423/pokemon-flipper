import { readCache, writeCache } from "./api-cache.js";
import { finishOfVariant, mapVariantPrintings } from "./card-identity.js";
import { conditionOf } from "./pricing.js";

// PokemonPriceTracker. Kept as a cross-check: its raw prices are split
// by printing, but its graded sales mix printings.
const BASE = "https://www.pokemonpricetracker.com/api/v2";
const SEARCH_LIMIT = 5;

// A PokemonPriceTracker card in the shape identity and pricing expect.
export function fromPokemonPriceTracker(record) {
    const variants = record.prices?.variants ?? {};
    const names = Object.keys(variants);
    const printings = mapVariantPrintings(names, record.setName);

    return {
        source: "pokemonPriceTracker",
        id: record.tcgPlayerId,
        name: record.name,
        setName: record.setName,
        cardNumber: record.cardNumber,
        tcgPlayerId: record.tcgPlayerId,
        variants: names.map((name) => ({
            name,
            printing: printings[name],
            finish: finishOfVariant(name),
            prices: Object.entries(variants[name])
                .filter(([, entry]) => typeof entry?.price === "number")
                .map(([label, entry]) => ({
                    condition: conditionOf(label),
                    price: entry.price,
                    updatedAt: entry.lastUpdated ?? null,
                })),
        })),
    };
}

export async function lookupCards({ set, name }) {
    const params = new URLSearchParams({ set, search: name, limit: String(SEARCH_LIMIT) });
    const key = `pokemonpricetracker:cards?${params}`;
    const cached = await readCache(key, 24);

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

    const cards = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
    await writeCache(key, cards);

    return cards.map(fromPokemonPriceTracker);
}
