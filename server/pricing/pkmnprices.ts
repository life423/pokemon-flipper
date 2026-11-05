import { readCache, writeCache } from "../lib/cache.ts";
import { sameCardNumber, sameSetFamily, setFamily, setSearchTerm } from "../identity/card-identity.ts";
import { canonicalCatalogName, pricingSearchName, sameCatalogName } from "./search-name.ts";
import { conditionOf } from "./raw-prices.ts";
import { cardNumberOf, cardVariants } from "./records.ts";
import type { CardRecord, Comp, FetchComps, FetchRawComps, FetchSoldPage, LookupCards, LookupQueryCards, QueryCatalogResult, SoldPage, SoldPageSelection, SoldStream } from "./types.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { fetchJson, ProviderError } from "../lib/http.ts";
import { PricingProviderError, retryAfterMs } from "./errors.ts";
import type { PricingIssue } from "../../shared/pricing-retries.ts";
import { getAiUsageContext, withAiUsageContext } from "../ai/usage-context.ts";
import { getPriceResearchSignal, reservePriceRequest, PriceResearchBudgetError } from "./research-budget.ts";
import { PRICE_SCREEN_REQUEST_LIMIT, SOLD_MARKET_PAGE_LIMIT } from "../../shared/research-policy.ts";

// pkmnprices.com: TCGplayer prices by printing and condition, and
// individual eBay sold comps. Provider credits describe returned-item quota,
// not a dollar charge; record the reported counters without inferring billing.
// Positive metadata is saved for a day; sold pages for six hours.
const BASE = "https://api.pkmnprices.com/v1";
const DAY = 24;

// pkmnprices limits requests per minute: two at a time here, and a
// rate-limit 429 waits and retries. A credit-limit 429 doesn't reset
// until the next day, so it fails right away.
const MAX_IN_FLIGHT = 2;
const RETRY_WAITS_MS = [5_000, 15_000, 30_000, 60_000];

const limit = createLimiter(MAX_IN_FLIGHT);
const share = createSharedWork();
const requestSponsors = new Map<string, Set<RequestSponsor>>();
let coolingUntil = 0;
let coolingKind: PricingIssue["kind"] = "RATE_LIMIT";
let lastRequestAt = 0;
export function pricingCooldown(): PricingIssue | null {
    return Date.now() < coolingUntil ? { kind: coolingKind, retryAt: new Date(coolingUntil).toISOString() } : null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const stop = () => { clearTimeout(timer); reject(signal!.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
        signal?.addEventListener("abort", stop, { once: true });
    });
}

function combinedSignal(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
    return first && second && first !== second ? AbortSignal.any([first, second]) : first ?? second;
}

type RequestReservation = Awaited<ReturnType<typeof reservePriceRequest>>;
interface SponsoredReservation extends RequestReservation { available(): boolean; dispatch(): void }
interface RequestSponsor {
    signal?: AbortSignal;
    available(): boolean;
    dispatch(): void;
    reserve(path: string, signal: AbortSignal): Promise<RequestReservation>;
}
function requestSponsor(signal?: AbortSignal, allowance = () => true, dispatch = () => {}): RequestSponsor {
    const owner = { ...getAiUsageContext() };
    return { signal, available: () => !signal?.aborted && allowance(), dispatch,
        reserve: (path, workSignal) => withAiUsageContext(owner, () => reservePriceRequest(path, workSignal)),
    };
}
function attachSponsor(sponsors: Map<string, Set<RequestSponsor>>, key: string, sponsor: RequestSponsor) {
    const consumers = sponsors.get(key) ?? new Set<RequestSponsor>();
    consumers.add(sponsor); sponsors.set(key, consumers);
    return () => { consumers.delete(sponsor); if (!consumers.size && sponsors.get(key) === consumers) sponsors.delete(key); };
}
async function reserveSponsored(path: string, sponsors: Map<string, Set<RequestSponsor>>, key: string, signal: AbortSignal): Promise<SponsoredReservation> {
    signal.throwIfAborted();
    let exhausted: PriceResearchBudgetError | undefined;
    for (const sponsor of [...(sponsors.get(key) ?? [])]) {
        if (!sponsor.available()) continue;
        const dispatchSignal = combinedSignal(signal, sponsor.signal)!;
        let reservation: RequestReservation;
        try { reservation = await sponsor.reserve(path, dispatchSignal); }
        catch (error) {
            signal.throwIfAborted();
            if (sponsor.signal?.aborted) continue;
            if (error instanceof PriceResearchBudgetError && error.reason === "LIMIT") { exhausted = error; continue; }
            throw error;
        }
        if (signal.aborted || !sponsor.available()) {
            await reservation.unresolved();
            signal.throwIfAborted();
            continue;
        }
        return { ...reservation, available: () => !signal.aborted && sponsor.available(), dispatch: sponsor.dispatch };
    }
    throw exhausted ?? new ScreeningPriceBudgetError();
}

// Reservation is immediately before actual transport. Accepted responses are
// accounted for and can save even when every subscriber stops after dispatch.
async function request(path: string, apiKey: string, signal: AbortSignal, sponsors: Map<string, Set<RequestSponsor>>, key: string) {
    let reservation = await reserveSponsored(path, sponsors, key, signal);
    while (!reservation.available()) {
        await reservation.unresolved();
        signal.throwIfAborted();
        reservation = await reserveSponsored(path, sponsors, key, signal);
    }
    // No await between this final cancellation/allowance check and fetch.
    signal.throwIfAborted();
    reservation.dispatch();
    let result: Awaited<ReturnType<typeof fetchJson>>;
    try {
        result = await fetchJson(`${BASE}${path}`, { headers: { "x-api-key": apiKey } }, { service: "Price lookup" });
    } catch (error) {
        await reservation.unresolved();
        if (error instanceof ProviderError || error instanceof TypeError) {
            coolingKind = "TEMPORARY"; coolingUntil = Math.max(coolingUntil, Date.now() + 30_000);
            throw new PricingProviderError((error as Error).message, "TEMPORARY", coolingUntil);
        }
        throw error;
    }
    try { await reservation.complete(result.response, result.body); }
    catch (error) {
        // An accounting write failure must fail closed without throwing away
        // an already accepted paid response or mislabeling it as provider throttle.
        try { if (result.response.ok) await finish(path, result.response, result.body); }
        finally { await reservation.unresolved(); }
        throw error;
    }
    return result;
}

// pkmnprices responses are read field by field where they're used.
type ApiBody = any;

function creditLimitReached(body: ApiBody): boolean {
    if (body.error?.limit_type === "daily") return true;
    if (body.error?.limit_type === "per_minute") return false;
    return /credit/i.test(`${body.error?.code ?? ""} ${body.error?.message ?? ""}`);
}

async function apiGet(path: string, maxAgeHours = DAY): Promise<ApiBody> {
    const signal = getPriceResearchSignal();
    signal?.throwIfAborted();
    const saved = await readApiCache(path, maxAgeHours);
    signal?.throwIfAborted();
    if (saved) return saved;
    const key = `${path}:${maxAgeHours}`;
    const detach = attachSponsor(requestSponsors, key, requestSponsor(signal));
    try {
        for (let attempt = 0; ; attempt += 1) {
            const { response, body } = await share(key, workSignal => loadAttempt(path, maxAgeHours, workSignal, key), signal);
            if (!response || response.ok) return body;
            const creditLimit = creditLimitReached(body);
            if (response.status === 429 && creditLimit) throw creditLimitError(response);
            if (response.status === 429 && attempt < RETRY_WAITS_MS.length) {
                const waitMs = retryAfterMs(response.headers.get("retry-after"), Date.now(), RETRY_WAITS_MS[attempt]);
                coolingKind = "RATE_LIMIT";
                coolingUntil = Math.max(coolingUntil, Date.now() + waitMs);
                if (waitMs > 15_000 || attempt >= 2) throw new PricingProviderError("Price service is rate limited. Retry pricing after the cooldown.", "RATE_LIMIT", coolingUntil);
                await sleep(waitMs, signal);
                continue;
            }
            return finish(path, response, body);
        }
    } finally { detach(); }
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
async function cachedApiGet(path: string, maxAgeHours: number): Promise<ApiBody | null> {
    const signal = getPriceResearchSignal();
    signal?.throwIfAborted();
    const saved = await readApiCache(path, maxAgeHours);
    signal?.throwIfAborted();
    return saved;
}

function creditLimitError(response: Response): PricingProviderError {
    coolingKind = "CREDITS";
    coolingUntil = Math.max(coolingUntil, Date.now() + retryAfterMs(response.headers.get("retry-after"), Date.now(), 60 * 60_000));
    return new PricingProviderError("Price-service credits are unavailable. Check the provider account; cached prices still work.", "CREDITS", coolingUntil);
}

// Share one transport attempt across every stage. Retries belong to normal
// subscribers, so screening alone can never trigger a later paid attempt.
async function loadAttempt(path: string, maxAgeHours: number, signal: AbortSignal, key: string): Promise<{ response: Response | null; body: ApiBody }> {
    signal.throwIfAborted();
    const cached = await readApiCache(path, maxAgeHours);
    signal.throwIfAborted();
    if (cached) return { response: null, body: cached };
    const apiKey = process.env.PKMNPRICES_API_KEY;
    if (!apiKey) throw new PricingProviderError("PKMNPRICES_API_KEY is not set", "CONFIG");
    return limit(async () => {
        signal.throwIfAborted();
        if (Date.now() < coolingUntil) {
            throw new PricingProviderError(coolingKind === "CREDITS" ? "Price-service credits are unavailable. Check the provider account; cached prices still work." : "Price service is cooling down. Cached prices still work; retry missing prices after the cooldown.", coolingKind, coolingUntil);
        }
        const slot = Math.max(Date.now(), lastRequestAt + 1000);
        lastRequestAt = slot;
        if (slot > Date.now()) await sleep(slot - Date.now(), signal);
        signal.throwIfAborted();
        if (Date.now() < coolingUntil) throw new PricingProviderError("Price service is cooling down; cached prices still work.", coolingKind, coolingUntil);
        const { assertSqlStorageReady } = await import("../storage/index.ts");
        await assertSqlStorageReady();
        signal.throwIfAborted();
        const result = await request(path, apiKey, signal, requestSponsors, key);
        // Accepted responses and provider cooldowns persist even after Stop.
        // This stage records a throttle; only normal subscribers can retry it.
        if (result.response.status === 429) {
            const credits = creditLimitReached(result.body);
            coolingKind = credits ? "CREDITS" : "RATE_LIMIT";
            coolingUntil = Math.max(coolingUntil, Date.now() + retryAfterMs(result.response.headers.get("retry-after"), Date.now(), credits ? 60 * 60_000 : RETRY_WAITS_MS[0]!));
        } else await finish(path, result.response, result.body);
        return result;
    });
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

// Query resolution needs complete candidate coverage, unlike a bounded list
// of research leads. Reuse ordinary cache paths and the screening source's get.
async function lookupQueryCardsFrom({ set, name }: Parameters<LookupQueryCards>[0], get: typeof apiGet): Promise<QueryCatalogResult> {
    const incomplete: QueryCatalogResult = { cards: [], complete: false };
    const nameTerm = pricingSearchName(name);
    if (!nameTerm) return incomplete;
    async function pages(endpoint: string, params: URLSearchParams, size: number, age = DAY): Promise<any[] | null> {
        const items: any[] = [];
        let total: number | undefined, pageCount: number | undefined;
        for (let page = 1; page <= 4; page++) {
            const body = await get(`${endpoint}?${params}`, age);
            if (!Array.isArray(body?.data) || body.data.length > size) return null;
            items.push(...body.data);
            const pagination = body.pagination;
            if (pagination == null) return page === 1 && body.data.length < size ? items : null;
            if (pagination.page !== page || pagination.per_page !== size || !Number.isSafeInteger(pagination.total) || pagination.total < 0 ||
                !Number.isSafeInteger(pagination.total_pages) || pagination.total_pages !== Math.max(1, Math.ceil(pagination.total / size)) ||
                total !== undefined && (pagination.total !== total || pagination.total_pages !== pageCount)) return null;
            total = pagination.total; pageCount = pagination.total_pages;
            if (body.data.length !== Math.min(size, Math.max(0, total! - (page - 1) * size))) return null;
            if (page === pageCount) return pagination.next_cursor ? null : items;
            params.set("page", String(page + 1));
        }
        return null;
    }
    const sets = await pages("/sets", new URLSearchParams({ name: setSearchTerm(set), language: "English", per_page: "50" }), 50, DAY * 7);
    if (!sets) return incomplete;
    const family = new Map<number, { id: number; name: string }>();
    for (const entry of sets.filter(entry => sameSetFamily(entry?.name, set))) {
        if (!Number.isSafeInteger(entry.id) || entry.id < 1 || family.has(entry.id) && family.get(entry.id)!.name !== entry.name) return incomplete;
        family.set(entry.id, entry);
    }
    const candidates = new Map<number, PkmnCard>();
    for (const entry of family.values()) {
        const items = await pages("/cards", new URLSearchParams({ set_id: String(entry.id), name: nameTerm, per_page: "20" }), 20);
        if (!items) return incomplete;
        for (const item of items.filter(item => sameCatalogName(item?.name, name))) {
            if (!Number.isSafeInteger(item.id) || item.id < 1 || item.set?.name && !sameSetFamily(item.set.name, set)) return incomplete;
            const previous = candidates.get(item.id);
            if (previous && !sameCardNumber(cardNumberOf(previous), cardNumberOf(item))) return incomplete;
            candidates.set(item.id, item);
            if (candidates.size > 4) return incomplete;
        }
    }
    const cards: CardRecord[] = [];
    for (const item of candidates.values()) {
        const detail = await get(`/cards/${item.id}?currency=usd`);
        if (detail?.id !== item.id || !sameCatalogName(detail.name, name) || !sameSetFamily(detail.set?.name, set) ||
            !sameCardNumber(cardNumberOf(detail), cardNumberOf(item))) return incomplete;
        cards.push(toCardRecord(detail));
    }
    return { cards, complete: true };
}

// Candidate cards for a listing: every set in the listing's set family,
// narrowed by name and number before the per-card price lookups.
async function lookupCardsFrom({ set, name, cardNumber }: Parameters<LookupCards>[0],
    get: typeof apiGet, cached: typeof readApiCache,
    screening?: { maxCards: number }): ReturnType<LookupCards> {

    const nameTerm = pricingSearchName(name);
    if (!nameTerm) return [];
    const sets = await get(
        `/sets?${new URLSearchParams({ name: setSearchTerm(set), language: "English", per_page: "50" })}`,
        DAY * 7
    );

    const familySets: { id: number; name: string }[] = (sets.data ?? []).filter((s: { name: string }) =>
        sameSetFamily(s.name, set)
    );
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
        let list = await cached(legacyPath, DAY);
        if (numeric) params.set("number", numeric[1]!.replace(/^0+(?=\d)/, ""));
        // Earlier provider queries split owner apostrophes into spaces. Reuse
        // their positive exact matches from cache, but an empty malformed
        // query must never prevent the corrected spelling from being tried.
        if (!list && nameTerm.includes("'")) {
            const previousParams = new URLSearchParams(params);
            previousParams.set("name", nameTerm.replace(/'/g, " ").replace(/\s+/g, " ").trim());
            const previousPaths = [`/cards?${previousParams}`];
            if (numeric) {
                previousParams.delete("number");
                previousPaths.unshift(`/cards?${previousParams}`);
            }
            for (const previousPath of previousPaths) {
                const previous = await cached(previousPath, DAY);
                if (previous?.data?.some((item: PkmnCard) => sameCatalogName(item.name, name) &&
                    (!item.set?.name || sameSetFamily(item.set.name, set)) &&
                    (!cardNumber || sameCardNumber(cardNumberOf(item), cardNumber)))) {
                    list = previous;
                    break;
                }
            }
        }
        list ??= await get(`/cards?${params}`);

        for (const item of list.data ?? []) {
            if (cardNumber ? !sameCardNumber(cardNumberOf(item), cardNumber) : !screening) continue;
            if (!sameCatalogName(item.name, name)) continue;

            const detail = await get(`/cards/${item.id}?currency=usd`);
            if (!sameCatalogName(detail.name, name) || !sameSetFamily(detail.set?.name, set) ||
                cardNumber && !sameCardNumber(cardNumberOf(detail), cardNumber) ||
                !sameCardNumber(cardNumberOf(detail), cardNumberOf(item))) continue;
            cards.push(toCardRecord(detail));
            if (screening && cards.length >= screening.maxCards) return cards;
        }
    }

    return cards;
}

export const lookupCards: LookupCards = query => lookupCardsFrom(query, apiGet, cachedApiGet);

const uniqueSales = (sales: readonly Comp[]) => [...new Map(sales.map(sale => [sale.id ?? sale.listing_url ?? JSON.stringify(sale), sale])).values()];

const CONFIRMED_SALE_TYPES = "auction,fixed_price,best_offer_accepted";
const soldPage = (body: ApiBody, stream: SoldStream): SoldPage => ({
    sales: uniqueSales((body.data ?? []).filter((sale: Comp) => sale.currency === "USD")),
    nextCursor: body.pagination?.has_more && typeof body.pagination.next_cursor === "string" && body.pagination.next_cursor
        ? body.pagination.next_cursor : null,
    stream,
});

// Opaque cursors belong to the query that produced them. Old unfiltered pages
// remain cache-only; new requests ask for known transaction amounts. Never save
// a filtered response under an old key or send its legacy cursor to the provider.
async function readSoldPage(recordId: CardRecord["id"], params: URLSearchParams,
    { cursor, stream, stopWhen }: { cursor?: string; stream?: SoldStream } & SoldPageSelection = {},
    get = apiGet, cached = cachedApiGet, signal = getPriceResearchSignal()): Promise<SoldPage> {
    signal?.throwIfAborted();
    if (stream !== undefined && stream !== "LEGACY" && stream !== "CONFIRMED") throw new Error("Unknown sold-page stream.");
    const endpoint = (mode: SoldStream, next?: string) => {
        const query = new URLSearchParams(params);
        if (mode === "CONFIRMED") query.set("sale_type", CONFIRMED_SALE_TYPES);
        if (next) query.set("cursor", next);
        return `/cards/${recordId}/listings/ebay?${query}`;
    };
    if (stream === "CONFIRMED") return soldPage(await get(endpoint(stream, cursor), 6), stream);
    if (cursor) {
        const saved = await cached(endpoint("LEGACY", cursor), 6);
        if (saved) return soldPage(saved, "LEGACY");
        return soldPage(await get(endpoint("CONFIRMED"), 6), "CONFIRMED");
    }
    const confirmed = await cached(endpoint("CONFIRMED"), 6);
    if (confirmed) return soldPage(confirmed, "CONFIRMED");

    const first = await cached(endpoint("LEGACY"), 6);
    if (first) {
        let page = soldPage(first, "LEGACY");
        const sales: Comp[] = [];
        const seen = new Set<string>();
        for (let count = 0; count < SOLD_MARKET_PAGE_LIMIT; count += 1) {
            sales.push(...page.sales);
            const useful = stopWhen ? await stopWhen(uniqueSales(sales))
                : sales.some(sale => CONFIRMED_SALE_TYPES.split(",").includes(sale.sale_type ?? ""));
            // Check cancellation after an asynchronous eligibility callback too.
            signal?.throwIfAborted();
            if (useful || !sales.length && !page.nextCursor) return soldPage(first, "LEGACY");
            if (!page.nextCursor || seen.has(page.nextCursor) || count + 1 === SOLD_MARKET_PAGE_LIMIT) break;
            seen.add(page.nextCursor);
            const next = await cached(endpoint("LEGACY", page.nextCursor), 6);
            if (!next) break;
            page = soldPage(next, "LEGACY");
        }
    }
    return soldPage(await get(endpoint("CONFIRMED"), 6), "CONFIRMED");
}

// Screening and final pricing share native URLs, SQL cache and in-flight work.
// The four-page bound still applies when a legacy cache gap restarts at root.
async function collectSoldPages(recordId: CardRecord["id"], params: URLSearchParams, { stopWhen }: SoldPageSelection = {}, minimumPages = 1) {
    const sales: Comp[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined, stream: SoldStream | undefined;
    const limit = stopWhen ? SOLD_MARKET_PAGE_LIMIT : 2;
    for (let page = 0; page < limit; page += 1) {
        getPriceResearchSignal()?.throwIfAborted();
        const key = JSON.stringify([stream, cursor]);
        if (seen.has(key)) break;
        seen.add(key);
        const result = await readSoldPage(recordId, params, { cursor, stream, stopWhen });
        sales.push(...result.sales);
        const enough = stopWhen && page + 1 >= minimumPages && await stopWhen(uniqueSales(sales));
        getPriceResearchSignal()?.throwIfAborted();
        if (enough) break;
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
        stream = result.stream;
    }
    return sales;
}

export const fetchComps: FetchComps = async (recordId, { grader, grade, variant, stopWhen }) => {
    const params = new URLSearchParams({
        graded: "true",
        grader,
        grade: String(grade),
        limit: "20",
        sort: "date_desc",
        period: "180d",
    });

    if (variant) params.set("variant", variant);

    return uniqueSales(await collectSoldPages(recordId, params, { stopWhen }));
};

// Retain the first two pages of raw research candidates. Sparse markets may
// recover the same later pages admitted by screening, up to four total.
export const fetchRawComps: FetchRawComps = async (recordId, variant, selection) => {
    const params = new URLSearchParams({ graded: "false", period: "90d", sort: "date_desc", limit: "20", variant });
    return collectSoldPages(recordId, params, selection, 2);
};

export class ScreeningPriceBudgetError extends Error {
    constructor() { super("The search's price-screening request allowance is exhausted. Saved price evidence remains available."); }
}

export function createScreeningPriceSource({ signal: sourceSignal, maxRequests = PRICE_SCREEN_REQUEST_LIMIT }: { signal?: AbortSignal; maxRequests?: number } = {}) {
    const signal = combinedSignal(sourceSignal, getPriceResearchSignal());
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 0) throw new RangeError("The price-screening request allowance must be a nonnegative integer.");
    const requestLimit = maxRequests;
    let requests = 0;
    const queryCatalogs = new Map<string, CardRecord[]>();
    const queryKey = (query: { set: string; name: string }) => JSON.stringify([[...setFamily(query.set)].sort(), canonicalCatalogName(query.name)]);
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
        const sponsor = requestSponsor(signal, () => requests < requestLimit, () => { requests += 1; });
        const detach = attachSponsor(requestSponsors, key, sponsor);
        try {
            const { response, body } = await share(key, workSignal => loadAttempt(path, maxAgeHours, workSignal, key), signal);
            if (!response || response.ok) return body;
            if (response.status === 429) {
                if (creditLimitReached(body)) throw creditLimitError(response);
                coolingKind = "RATE_LIMIT";
                coolingUntil = Math.max(coolingUntil, Date.now() + retryAfterMs(response.headers.get("retry-after"), Date.now(), RETRY_WAITS_MS[0]!));
                throw new PricingProviderError("Price service is rate limited; screening will not retry this request.", coolingKind, coolingUntil);
            }
            return finish(path, response, body);
        } finally { detach(); }
    };
    const fetchSoldPage: FetchSoldPage = async (recordId, { grader, grade, variant, cursor, stream, stopWhen }) => {
        if (Boolean(grader) !== Boolean(grade)) throw new Error("A sold-page target requires both its grader and grade.");
        // Keep parameter order identical to final pricing for shared cache keys.
        const params = grader && grade
            ? new URLSearchParams({ graded: "true", grader, grade, limit: "20", sort: "date_desc", period: "180d", variant })
            : new URLSearchParams({ graded: "false", period: "90d", sort: "date_desc", limit: "20", variant });
        return readSoldPage(recordId, params, { cursor, stream, stopWhen }, get, cached, signal);
    };
    const source: { lookupCards: LookupCards; lookupQueryCards: LookupQueryCards; fetchComps: FetchComps; fetchRawComps: FetchRawComps; fetchSoldPage: FetchSoldPage; stats(): { requests: number; limit: number } } = {
        lookupCards: query => {
            signal?.throwIfAborted();
            const complete = queryCatalogs.get(queryKey(query));
            return complete ? Promise.resolve(structuredClone(complete.filter(card => !query.cardNumber || sameCardNumber(card.cardNumber, query.cardNumber))))
                : lookupCardsFrom(query, get, cached, { maxCards: 4 });
        },
        lookupQueryCards: async query => {
            const result = await lookupQueryCardsFrom(query, get);
            if (result.complete) queryCatalogs.set(queryKey(query), structuredClone(result.cards));
            return result;
        },
        fetchComps: async (recordId, { grader, grade, variant, stopWhen }) => {
            if (variant) return (await fetchSoldPage(recordId, { grader, grade: String(grade), variant, stopWhen })).sales;
            // Retain the optional variant's established URL for other callers.
            const params = new URLSearchParams({ graded: "true", grader, grade: String(grade), limit: "20", sort: "date_desc", period: "180d" });
            return (await readSoldPage(recordId, params, { stopWhen }, get, cached, signal)).sales;
        },
        fetchRawComps: async (recordId, variant, selection) => (await fetchSoldPage(recordId, { grader: null, grade: null, variant, ...selection })).sales,
        fetchSoldPage,
        stats: () => ({ requests, limit: requestLimit }),
    };
    return source;
}
