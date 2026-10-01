import { readCache, writeCache } from "./api-cache.js";
import {
    finishOfVariant,
    mapVariantPrintings,
    normalizeSetName,
    normalizeWords,
    sameCardNumber,
    sameSetFamily,
    setSearchTerm,
} from "./card-identity.js";
import { conditionOf } from "./pricing.js";

// pkmnprices.com: TCGplayer prices by printing and condition, and
// individual eBay sold comps (sourced from PriceCharting). Every call
// costs a credit per item returned, so responses are saved for a day.
const BASE = "https://api.pkmnprices.com/v1";
const DAY = 24;

async function apiGet(path, maxAgeHours = DAY) {
    const cached = await readCache(`pkmnprices:${path}`, maxAgeHours);

    if (cached) return cached;

    const apiKey = process.env.PKMNPRICES_API_KEY;

    if (!apiKey) {
        throw new Error("PKMNPRICES_API_KEY is not set");
    }

    const response = await fetch(`${BASE}${path}`, { headers: { "x-api-key": apiKey } });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(
            `pkmnprices request failed (${response.status}): ${body.error?.message ?? "unknown error"}`
        );
    }

    await writeCache(`pkmnprices:${path}`, body);

    return body;
}

// A pkmnprices card in the shape identity and pricing expect.
export function toCardRecord(detail) {
    const usd = (detail.prices ?? []).filter((price) => (price.currency ?? "USD") === "USD");
    const names = [...new Set(usd.map((price) => price.variant))];
    const printings = mapVariantPrintings(names, detail.set?.name);

    return {
        source: "pkmnprices",
        id: detail.id,
        name: detail.name,
        setName: detail.set?.name ?? null,
        cardNumber: detail.total_set_number
            ? `${detail.number}/${detail.total_set_number}`
            : detail.number,
        tcgPlayerId: detail.tcg_player_id ?? null,
        variants: names.map((name) => ({
            name,
            printing: printings[name],
            finish: finishOfVariant(name),
            prices: usd
                .filter((price) => price.variant === name)
                .map((price) => ({
                    condition: conditionOf(price.condition),
                    price: price.market_price,
                    updatedAt: price.created_at ?? null,
                })),
        })),
    };
}

// Candidate cards for a listing: every set in the listing's set family,
// narrowed by name and number before the per-card price lookups.
export async function lookupCards({ set, name, cardNumber }) {

    const sets = await apiGet(
        `/sets?${new URLSearchParams({ name: setSearchTerm(set), language: "English", per_page: "50" })}`,
        DAY * 7
    );

    const familySets = (sets.data ?? []).filter((s) => sameSetFamily(s.name, set));
    const nameTerm = normalizeWords(name).replace(/\bholo\b/g, "").trim();
    const cards = [];

    for (const familySet of familySets) {
        const list = await apiGet(
            `/cards?${new URLSearchParams({ set_id: String(familySet.id), name: nameTerm, per_page: "20" })}`
        );

        for (const item of list.data ?? []) {
            const number = item.total_set_number
                ? `${item.number}/${item.total_set_number}`
                : item.number;

            if (!sameCardNumber(number, cardNumber)) continue;

            const detail = await apiGet(`/cards/${item.id}?currency=usd`);
            cards.push(toCardRecord(detail));
        }
    }

    return cards;
}

// One page of recent graded eBay sales for a card record and printing.
export async function fetchComps(recordId, { grader, grade, variant }) {
    const params = new URLSearchParams({
        graded: "true",
        grader,
        grade: String(grade),
        limit: "20",
        sort: "date_desc",
    });

    if (variant) params.set("variant", variant);

    const body = await apiGet(`/cards/${recordId}/listings/ebay?${params}`);

    return body.data ?? [];
}
