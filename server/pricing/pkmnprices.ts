import { readCache, writeCache } from "../lib/cache.ts";
import { sameCardNumber, sameSetFamily, setSearchTerm, normalizeWords } from "../identity/card-identity.ts";
import { pricingSearchName } from "./search-name.ts";
import { conditionOf } from "./raw-prices.ts";
import { cardNumberOf, cardVariants } from "./records.ts";
import type { CardRecord, Comp, FetchComps, FetchRawComps, LookupCards } from "./types.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { createSingleFlight } from "../lib/single-flight.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { fetchJson, ProviderError } from "../lib/http.ts";
import { PricingProviderError, retryAfterMs } from "./errors.ts";
import type { PricingIssue } from "../../shared/pricing-retries.ts";

// pkmnprices.com: TCGplayer prices by printing and condition, and
// individual eBay sold comps. Every call costs credits per returned item.
// Positive metadata is saved for a day; sold pages for six hours.
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
class OptionalFeatureUnavailable extends Error {}
export function pricingCooldown(): PricingIssue | null {
    return Date.now() < coolingUntil ? { kind: coolingKind, retryAt: new Date(coolingUntil).toISOString() } : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// pkmnprices responses are read field by field where they're used.
type ApiBody = any;

async function apiGet(path: string, maxAgeHours = DAY): Promise<ApiBody> {
    return share(`${path}:${maxAgeHours}`, () => load(path, maxAgeHours));
}

async function readApiCache(path: string, maxAgeHours: number): Promise<ApiBody | null> {
    let cached = await readCache(`pkmnprices:${path}`, maxAgeHours);
    // A successful but empty name search should not hide a newly available
    // record all day. Positive metadata and priced responses keep their TTLs.
    if ((path.startsWith("/cards?") || path.includes("/listings/ebay?")) && Array.isArray(cached?.data) && cached.data.length === 0) {
        cached = await readCache(`pkmnprices:${path}`, Math.min(maxAgeHours, 5 / 60));
    }

    return cached;
}

async function load(path: string, maxAgeHours: number): Promise<ApiBody> {
    const cached = await readApiCache(path, maxAgeHours);
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
            const { assertSqlStorageReady } = await import("../storage/index.ts");
            await assertSqlStorageReady();
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
        // Volume is plan-gated. Its absence must not disable otherwise working
        // card prices or sold comps through the global pricing cooldown.
        if (response.status === 403 && path.includes("/sales/volume?")) throw new OptionalFeatureUnavailable(message);
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
async function lookupCardsFrom({ set, name, cardNumber }: Parameters<LookupCards>[0],
    get: typeof apiGet, cached: typeof readApiCache,
    screening?: { maxCards: number }): ReturnType<LookupCards> {

    const sets = await get(
        `/sets?${new URLSearchParams({ name: setSearchTerm(set), language: "English", per_page: "50" })}`,
        DAY * 7
    );

    const familySets: { id: number; name: string }[] = (sets.data ?? []).filter((s: { name: string }) =>
        sameSetFamily(s.name, set)
    );
    const nameTerm = pricingSearchName(name);
    const cards: CardRecord[] = [];

    for (const familySet of familySets) {
        const params = new URLSearchParams({ set_id: String(familySet.id), name: nameTerm, per_page: "20" });
        const legacyPath = `/cards?${params}`;
        // The provider charges per returned card. Push an already-required
        // plain numeric number into its documented filter, while preserving
        // existing broader cached lists and the local exact-number check.
        // Promo/gallery prefixes and missing catalog totals retain their old
        // lookup semantics rather than guessing a new API normalization rule.
        const numeric = /^#?(\d+)(?:\/\d+)?$/.exec(cardNumber.replace(/\s+/g, ""));
        let list: ApiBody;
        if (numeric) {
            const previous = await cached(legacyPath, DAY);
            params.set("number", numeric[1]!.replace(/^0+(?=\d)/, ""));
            list = previous ?? await get(`/cards?${params}`);
        } else list = await get(legacyPath);

        for (const item of list.data ?? []) {
            if (cardNumber ? !sameCardNumber(cardNumberOf(item), cardNumber) : !screening) continue;
            if (screening && normalizeWords(item.name) !== normalizeWords(name)) continue;

            const detail = await get(`/cards/${item.id}?currency=usd`);
            cards.push(toCardRecord(detail));
            if (screening && cards.length >= screening.maxCards) return cards;
        }
    }

    return cards;
}

export const lookupCards: LookupCards = query => lookupCardsFrom(query, apiGet, readApiCache);

// One page of recent graded eBay sales for a card record and printing.
export const fetchComps: FetchComps = async (recordId, { grader, grade, variant }) => {
    const params = new URLSearchParams({
        graded: "true",
        grader,
        grade: String(grade),
        limit: "20",
        sort: "date_desc",
        period: "180d",
    });

    if (variant) params.set("variant", variant);

    const sales: Comp[] = [];
    for (let page = 0; page < 2; page += 1) {
        const body = await apiGet(`/cards/${recordId}/listings/ebay?${params}`, 6);
        sales.push(...(body.data ?? []).filter((sale: Comp) => sale.currency === "USD"));
        if (!body.pagination?.has_more || !body.pagination?.next_cursor) break;
        params.set("cursor", body.pagination.next_cursor);
    }
    return [...new Map(sales.map(sale => [sale.id ?? sale.listing_url ?? JSON.stringify(sale), sale])).values()];
};

// At most 40 recent raw comps per printing, shared by every listing and
// condition. Bound the pagination; never mistake this sample for volume.
export const fetchRawComps: FetchRawComps = async (recordId, variant) => {
    const params = new URLSearchParams({ graded: "false", period: "90d", sort: "date_desc", limit: "20", variant });
    const sales: Comp[] = [];
    for (let page = 0; page < 2; page += 1) {
        const body = await apiGet(`/cards/${recordId}/listings/ebay?${params}`, 6);
        sales.push(...(body.data ?? []).filter((sale: Comp) => sale.currency === "USD"));
        if (!body.pagination?.has_more || !body.pagination?.next_cursor) break;
        params.set("cursor", body.pagination.next_cursor);
    }
    return sales;
};

export class ScreeningPriceBudgetError extends Error {
    constructor() { super("The search's price-screening request allowance is exhausted. Saved price evidence remains available."); }
}

interface ScreeningSponsor {
    available(): boolean;
    dispatch(): void;
}

// Shared URL jobs retain independent consumers. If one search stops while
// another still needs the page, a live search with allowance sponsors dispatch.
// Accepted responses save even when all consumers stop after dispatch.
const shareScreening = createSharedWork();
const screeningSponsors = new Map<string, Set<ScreeningSponsor>>();

export function createScreeningPriceSource({ signal, maxRequests = 8 }: { signal?: AbortSignal; maxRequests?: number } = {}) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 0) throw new RangeError("The price-screening request allowance must be a nonnegative integer.");
    const requestLimit = maxRequests;
    let requests = 0;
    const cached: typeof readApiCache = async (path, maxAgeHours) => {
        signal?.throwIfAborted();
        const result = await readApiCache(path, maxAgeHours);
        signal?.throwIfAborted();
        return result;
    };
    const get: typeof apiGet = async (path, maxAgeHours = DAY) => {
        const saved = await cached(path, maxAgeHours);
        if (saved) return saved;
        const key = `${path}:${maxAgeHours}`;
        const sponsors = screeningSponsors.get(key) ?? new Set<ScreeningSponsor>();
        const sponsor: ScreeningSponsor = {
            available: () => !signal?.aborted && requests < requestLimit,
            dispatch: () => { requests += 1; },
        };
        sponsors.add(sponsor); screeningSponsors.set(key, sponsors);
        try {
            return await shareScreening(key, async workSignal => {
                workSignal.throwIfAborted();
                const stored = await readApiCache(path, maxAgeHours);
                workSignal.throwIfAborted();
                if (stored) return stored;
                return limit(async () => {
                    workSignal.throwIfAborted();
                    if (Date.now() < coolingUntil) throw new PricingProviderError("Price service is cooling down; saved prices remain available.", coolingKind, coolingUntil);
                    if (![...(screeningSponsors.get(key) ?? [])].some(consumer => consumer.available())) throw new ScreeningPriceBudgetError();
                    const apiKey = process.env.PKMNPRICES_API_KEY;
                    if (!apiKey) throw new PricingProviderError("PKMNPRICES_API_KEY is not set", "CONFIG");
                    const slot = Math.max(Date.now(), lastRequestAt + 1000);
                    lastRequestAt = slot;
                    if (slot > Date.now()) await sleep(slot - Date.now());
                    workSignal.throwIfAborted();
                    if (Date.now() < coolingUntil) throw new PricingProviderError("Price service is cooling down; saved prices remain available.", coolingKind, coolingUntil);
                    const { assertSqlStorageReady } = await import("../storage/index.ts");
                    await assertSqlStorageReady();
                    workSignal.throwIfAborted();
                    const payer = [...(screeningSponsors.get(key) ?? [])].find(consumer => consumer.available());
                    if (!payer) throw new ScreeningPriceBudgetError();
                    payer.dispatch();
                    let result: Awaited<ReturnType<typeof fetchJson>>;
                    try {
                        // Do not cancel an accepted provider request: its answer
                        // can still save and prevent replacement research.
                        result = await fetchJson(`${BASE}${path}`, { headers: { "x-api-key": apiKey } }, { service: "Price screening" });
                    } catch (error) {
                        if (error instanceof ProviderError || error instanceof TypeError) {
                            coolingKind = "TEMPORARY"; coolingUntil = Math.max(coolingUntil, Date.now() + 30_000);
                            throw new PricingProviderError((error as Error).message, "TEMPORARY", coolingUntil);
                        }
                        throw error;
                    }
                    const { response, body } = result;
                    if (response.status === 429) {
                        const credits = /credit/i.test(`${body.error?.code ?? ""} ${body.error?.message ?? ""}`);
                        coolingKind = credits ? "CREDITS" : "RATE_LIMIT";
                        coolingUntil = Math.max(coolingUntil, Date.now() + retryAfterMs(response.headers.get("retry-after"), Date.now(), credits ? 60 * 60_000 : RETRY_WAITS_MS[0]!));
                        throw new PricingProviderError(credits ? "Price-service credits are unavailable; saved prices remain available." : "Price service is rate limited; screening will not retry this request.", coolingKind, coolingUntil);
                    }
                    return finish(path, response, body);
                });
            }, signal);
        } finally {
            sponsors.delete(sponsor);
            if (!sponsors.size && screeningSponsors.get(key) === sponsors) screeningSponsors.delete(key);
        }
    };
    const source: { lookupCards: LookupCards; fetchComps: FetchComps; fetchRawComps: FetchRawComps; stats(): { requests: number; limit: number } } = {
        lookupCards: query => lookupCardsFrom(query, get, cached, { maxCards: 4 }),
        fetchComps: async (recordId, { grader, grade, variant }) => {
            const params = new URLSearchParams({ graded: "true", grader, grade: String(grade), limit: "20", sort: "date_desc", period: "180d" });
            if (variant) params.set("variant", variant);
            const body = await get(`/cards/${recordId}/listings/ebay?${params}`, 6);
            const sales: Comp[] = (body.data ?? []).filter((sale: Comp) => sale.currency === "USD");
            return [...new Map(sales.map(sale => [sale.id ?? sale.listing_url ?? JSON.stringify(sale), sale])).values()];
        },
        fetchRawComps: async (recordId, variant) => {
            const params = new URLSearchParams({ graded: "false", period: "90d", sort: "date_desc", limit: "20", variant });
            const body = await get(`/cards/${recordId}/listings/ebay?${params}`, 6);
            return (body.data ?? []).filter((sale: Comp) => sale.currency === "USD");
        },
        stats: () => ({ requests, limit: requestLimit }),
    };
    return source;
}

export async function fetchSalesVolume(recordId: CardRecord["id"], variant: string, graded: boolean): Promise<{ data: unknown[]; pagination?: { total_pages?: number } }> {
    const params = new URLSearchParams({ graded: String(graded), period: "30d", currency: "usd", variant, limit: "30" });
    const path = `/cards/${recordId}/sales/volume?${params}`;
    const deniedKey = `pkmnprices:optional-denied:${path}`;
    if (await readCache(deniedKey, 15 / 60)) throw new OptionalFeatureUnavailable("Sales volume is unavailable on this provider plan.");
    try { return await apiGet(path, 6); }
    catch (error) {
        if (error instanceof OptionalFeatureUnavailable) await writeCache(deniedKey, true);
        throw error;
    }
}
