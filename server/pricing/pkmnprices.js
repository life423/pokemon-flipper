import { readCache, writeCache } from "./cache.js";
import {
    finishOfVariant,
    mapVariantPrintings,
    normalizeSetName,
    normalizeWords,
    sameCardNumber,
    sameSetFamily,
    setSearchTerm,
} from "../identity/card-identity.js";
import { conditionOf } from "./raw-prices.js";

// pkmnprices.com: TCGplayer prices by printing and condition, and
// individual eBay sold comps (sourced from PriceCharting). Every call
// costs a credit per item returned, so responses are saved for a day.
const BASE = "https://api.pkmnprices.com/v1";
const DAY = 24;

// pkmnprices limits requests per minute: two at a time here, and a
// rate-limit 429 waits and retries. A credit-limit 429 doesn't reset
// until the next day, so it fails right away.
const MAX_IN_FLIGHT = 2;
const RETRY_WAITS_MS = [5_000, 15_000, 30_000, 60_000];

let inFlight = 0;
const waiting = [];

async function takeSlot() {
    if (inFlight < MAX_IN_FLIGHT) {
        inFlight += 1;
        return;
    }

    // release() hands its slot straight to the next in line.
    await new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
    const next = waiting.shift();

    if (next) next();
    else inFlight -= 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function apiGet(path, maxAgeHours = DAY) {
    const cached = await readCache(`pkmnprices:${path}`, maxAgeHours);

    if (cached) return cached;

    const apiKey = process.env.PKMNPRICES_API_KEY;

    if (!apiKey) {
        throw new Error("PKMNPRICES_API_KEY is not set");
    }

    for (let attempt = 0; ; attempt += 1) {
        await takeSlot();

        let response;
        let body;

        try {
            response = await fetch(`${BASE}${path}`, { headers: { "x-api-key": apiKey } });
            body = await response.json().catch(() => ({}));
        } finally {
            releaseSlot();
        }

        const creditLimit = /credit/i.test(`${body.error?.code ?? ""} ${body.error?.message ?? ""}`);

        if (response.status === 429 && !creditLimit && attempt < RETRY_WAITS_MS.length) {
            // Retry-After, in seconds, when pkmnprices sends one.
            const retryAfter = Number(response.headers.get("retry-after"));
            await sleep(retryAfter > 0 ? retryAfter * 1000 : RETRY_WAITS_MS[attempt]);
            continue;
        }

        return finish(path, response, body);
    }
}

async function finish(path, response, body) {
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
