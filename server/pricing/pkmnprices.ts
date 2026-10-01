import { readCache, writeCache } from "./cache.ts";
import { normalizeWords, sameCardNumber, sameSetFamily, setSearchTerm } from "../identity/card-identity.ts";
import { conditionOf } from "./raw-prices.ts";
import { cardNumberOf, cardVariants } from "./records.ts";
import type { CardRecord, Comp, FetchComps, LookupCards } from "./types.ts";
import { createLimiter } from "../lib/concurrency.ts";

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

const limit = createLimiter(MAX_IN_FLIGHT);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// pkmnprices responses are read field by field where they're used.
type ApiBody = any;

async function apiGet(path: string, maxAgeHours = DAY): Promise<ApiBody> {
    const cached = await readCache(`pkmnprices:${path}`, maxAgeHours);

    if (cached) return cached;

    const apiKey = process.env.PKMNPRICES_API_KEY;

    if (!apiKey) {
        throw new Error("PKMNPRICES_API_KEY is not set");
    }

    for (let attempt = 0; ; attempt += 1) {
        const { response, body } = await limit(async () => {
            const response = await fetch(`${BASE}${path}`, { headers: { "x-api-key": apiKey } });
            return { response, body: await response.json().catch(() => ({})) };
        });

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

async function finish(path: string, response: Response, body: ApiBody): Promise<ApiBody> {
    if (!response.ok) {
        throw new Error(
            `pkmnprices request failed (${response.status}): ${body.error?.message ?? "unknown error"}`
        );
    }

    await writeCache(`pkmnprices:${path}`, body);

    return body;
}

interface PkmnPrice {
    currency?: string;
    variant: string;
    condition: string;
    market_price: number;
    created_at?: string;
}

interface PkmnCard {
    id: number;
    name: string;
    number: string;
    total_set_number?: string | null;
    tcg_player_id?: number | null;
    set?: { id: number; name: string };
    prices?: PkmnPrice[];
}

// A pkmnprices card in the shape identity and pricing expect.
export function toCardRecord(detail: PkmnCard): CardRecord {
    const usd = (detail.prices ?? []).filter((price) => (price.currency ?? "USD") === "USD");

    return {
        source: "pkmnprices",
        id: detail.id,
        name: detail.name,
        setName: detail.set?.name ?? null,
        cardNumber: cardNumberOf(detail),
        tcgPlayerId: detail.tcg_player_id ?? null,
        variants: cardVariants([...new Set(usd.map((price) => price.variant))], detail.set?.name, (label) =>
            usd
                .filter((price) => price.variant === label)
                .map((price) => ({
                    condition: conditionOf(price.condition),
                    price: price.market_price,
                    updatedAt: price.created_at ?? null,
                }))
        ),
    };
}

// Candidate cards for a listing: every set in the listing's set family,
// narrowed by name and number before the per-card price lookups.
export const lookupCards: LookupCards = async ({ set, name, cardNumber }) => {

    const sets = await apiGet(
        `/sets?${new URLSearchParams({ name: setSearchTerm(set), language: "English", per_page: "50" })}`,
        DAY * 7
    );

    const familySets: { id: number; name: string }[] = (sets.data ?? []).filter((s: { name: string }) =>
        sameSetFamily(s.name, set)
    );
    const nameTerm = normalizeWords(name).replace(/\bholo\b/g, "").trim();
    const cards: CardRecord[] = [];

    for (const familySet of familySets) {
        const list = await apiGet(
            `/cards?${new URLSearchParams({ set_id: String(familySet.id), name: nameTerm, per_page: "20" })}`
        );

        for (const item of list.data ?? []) {
            if (!sameCardNumber(cardNumberOf(item), cardNumber)) continue;

            const detail = await apiGet(`/cards/${item.id}?currency=usd`);
            cards.push(toCardRecord(detail));
        }
    }

    return cards;
};

// One page of recent graded eBay sales for a card record and printing.
export const fetchComps: FetchComps = async (recordId, { grader, grade, variant }) => {
    const params = new URLSearchParams({
        graded: "true",
        grader,
        grade: String(grade),
        limit: "20",
        sort: "date_desc",
    });

    if (variant) params.set("variant", variant);

    const body = await apiGet(`/cards/${recordId}/listings/ebay?${params}`);

    return (body.data ?? []) as Comp[];
};
