import { readCache, writeCache } from "../lib/cache.ts";
import { sameCardNumber, sameSetFamily, setSearchTerm } from "../identity/card-identity.ts";
import { pricingSearchName } from "./search-name.ts";
import { conditionOf } from "./raw-prices.ts";
import { cardNumberOf, cardVariants } from "./records.ts";
import type { CardRecord, Comp, FetchComps, LookupCards } from "./types.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { createSingleFlight } from "../lib/single-flight.ts";
import { fetchJson, ProviderError } from "../lib/http.ts";
import { PricingProviderError, retryAfterMs } from "./errors.ts";
import type { PricingIssue } from "../../shared/pricing-retries.ts";

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
const share = createSingleFlight();
let coolingUntil = 0;
let coolingKind: PricingIssue["kind"] = "RATE_LIMIT";
let lastRequestAt = 0;
export function pricingCooldown(): PricingIssue | null {
    return Date.now() < coolingUntil ? { kind: coolingKind, retryAt: new Date(coolingUntil).toISOString() } : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// pkmnprices responses are read field by field where they're used.
type ApiBody = any;

async function apiGet(path: string, maxAgeHours = DAY): Promise<ApiBody> {
    return share(`${path}:${maxAgeHours}`, () => load(path, maxAgeHours));
}

async function load(path: string, maxAgeHours: number): Promise<ApiBody> {
    let cached = await readCache(`pkmnprices:${path}`, maxAgeHours);
    // A successful but empty name search should not hide a newly available
    // record all day. Positive metadata and priced responses keep their TTLs.
    if (path.startsWith("/cards?") && Array.isArray(cached?.data) && cached.data.length === 0) {
        cached = await readCache(`pkmnprices:${path}`, Math.min(maxAgeHours, 5 / 60));
    }

    if (cached) return cached;

    const apiKey = process.env.PKMNPRICES_API_KEY;

    if (!apiKey) {
        throw new PricingProviderError("PKMNPRICES_API_KEY is not set", "CONFIG");
    }

    for (let attempt = 0; ; attempt += 1) {
        const { response, body } = await limit(async () => {
            if (Date.now() < coolingUntil) {
                throw new PricingProviderError(coolingKind === "CREDITS" ? "Price-service credits are unavailable. Check the provider account; cached prices still work." : "Price service is cooling down. Cached prices still work; retry missing prices after the cooldown.", coolingKind, coolingUntil);
            }
            // Pace uncached requests across searches and retries, not per browser.
            const slot = Math.max(Date.now(), lastRequestAt + 1000);
            lastRequestAt = slot;
            if (slot > Date.now()) await sleep(slot - Date.now());
            if (Date.now() < coolingUntil) throw new PricingProviderError("Price service is cooling down; cached prices still work.", coolingKind, coolingUntil);
            try { return await fetchJson(`${BASE}${path}`, { headers: { "x-api-key": apiKey } }, { service: "Price lookup" }); }
            catch (error) {
                if (error instanceof ProviderError || error instanceof TypeError) { coolingKind = "TEMPORARY"; coolingUntil = Math.max(coolingUntil, Date.now() + 30_000); throw new PricingProviderError((error as Error).message, "TEMPORARY", coolingUntil); }
                throw error;
            }
        });

        const creditLimit = /credit/i.test(`${body.error?.code ?? ""} ${body.error?.message ?? ""}`);

        if (response.status === 429 && creditLimit) {
            coolingKind = "CREDITS";
            coolingUntil = Math.max(coolingUntil, Date.now() + retryAfterMs(response.headers.get("retry-after"), Date.now(), 60 * 60_000));
            throw new PricingProviderError("Price-service credits are unavailable. Check the provider account; cached prices still work.", "CREDITS", coolingUntil);
        }
        if (response.status === 429 && attempt < RETRY_WAITS_MS.length) {
            // Retry-After, in seconds, when pkmnprices sends one.
            const waitMs = retryAfterMs(response.headers.get("retry-after"), Date.now(), RETRY_WAITS_MS[attempt]);
            coolingKind = "RATE_LIMIT";
            coolingUntil = Math.max(coolingUntil, Date.now() + waitMs);
            // A long server-directed wait is deferred, never retried early.
            if (waitMs > 15_000 || attempt >= 2) {
                throw new PricingProviderError("Price service is rate limited. Retry pricing after the cooldown.", "RATE_LIMIT", coolingUntil);
            }
            await sleep(waitMs);
            continue;
        }

        return finish(path, response, body);
    }
}

async function finish(path: string, response: Response, body: ApiBody): Promise<ApiBody> {
    if (!response.ok) {
        const message = `pkmnprices request failed (${response.status}): ${body.error?.message ?? "unknown error"}`;
        if (response.status >= 500 || [401, 403].includes(response.status)) {
            coolingKind = response.status >= 500 ? "TEMPORARY" : "CONFIG";
            coolingUntil = Math.max(coolingUntil, Date.now() + 30_000);
            throw new PricingProviderError(message, coolingKind, coolingUntil);
        }
        throw new Error(message);
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
    const nameTerm = pricingSearchName(name);
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
