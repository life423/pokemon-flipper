import { marketDataPath, readMarketData, saveMarketData } from "./market-cache.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { sameCardNumber, sameSetFamily, setFamily, setSearchTerm } from "../identity/card-identity.ts";
import { catalogPrintedName, catalogQueryAlias, numberedCatalogName, sameNumberedCatalogName } from "../identity/catalog-name.ts";
import { canonicalCatalogName, pricingSearchName } from "./search-name.ts";
import { cardNumberOf, cardVariants } from "./records.ts";
import { CONFIRMED_SALE_TYPES, uniqueSoldComps } from "./sold-comps.ts";
import type { CardRecord, Comp, FetchComps, FetchRawComps, FetchSoldPage, LookupCards, LookupQueryCards, QueryCatalogResult, SoldPage, SoldPageSelection, SoldStream } from "./types.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { fetchJson, ProviderError } from "../lib/http.ts";
import { PricingProviderError, retryAfterMs } from "./errors.ts";
import type { PricingIssue } from "../../shared/pricing-retries.ts";
import { getAiUsageContext, withAiUsageContext } from "../ai/usage-context.ts";
import { getPriceResearchSignal, reservePriceRequest } from "./research-budget.ts";
import { SOLD_MARKET_PAGE_LIMIT } from "../../shared/research-policy.ts";

// pkmnprices.com: native catalog identity, variant labels and individual eBay
// sold comps. Provider credits describe returned-item quota,
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
function requestSponsor(signal?: AbortSignal, dispatch = () => {}): RequestSponsor {
    const owner = { ...getAiUsageContext() };
    return { signal, available: () => !signal?.aborted, dispatch,
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
    for (const sponsor of [...(sponsors.get(key) ?? [])]) {
        if (!sponsor.available()) continue;
        const dispatchSignal = combinedSignal(signal, sponsor.signal)!;
        let reservation: RequestReservation;
        try { reservation = await sponsor.reserve(path, dispatchSignal); }
        catch (error) {
            signal.throwIfAborted();
            if (sponsor.signal?.aborted) continue;
            throw error;
        }
        if (signal.aborted || !sponsor.available()) {
            await reservation.unresolved();
            signal.throwIfAborted();
            continue;
        }
        return { ...reservation, available: () => !signal.aborted && sponsor.available(), dispatch: sponsor.dispatch };
    }
    throw new DOMException("Price research stopped.", "AbortError");
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
    // No await between this final cancellation check and fetch.
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
    if (marketDataPath(path)) return readMarketData(`pkmnprices:${path}`, maxAgeHours);
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
    return new PricingProviderError("Price-service credits are unavailable. Check the provider account.", "CREDITS", coolingUntil);
}

// Share one transport attempt across every stage. Retries belong to normal
// subscribers, so screening alone can never trigger a later paid attempt.
async function loadAttempt(path: string, maxAgeHours: number, signal: AbortSignal, key: string): Promise<{ response: Response | null; body: ApiBody }> {
    signal.throwIfAborted();
    const cached = await readApiCache(path, maxAgeHours);
    signal.throwIfAborted();
    if (cached) return { response: null, body: cached };
    const available = () => [...(requestSponsors.get(key) ?? [])].some(sponsor => sponsor.available());
    if (!available()) throw new DOMException("Price research stopped.", "AbortError");
    const apiKey = process.env.PKMNPRICES_API_KEY;
    if (!apiKey) throw new PricingProviderError("PKMNPRICES_API_KEY is not set", "CONFIG");
    return limit(async () => {
        signal.throwIfAborted();
        if (!available()) throw new DOMException("Price research stopped.", "AbortError");
        if (Date.now() < coolingUntil) {
            throw new PricingProviderError(coolingKind === "CREDITS" ? "Price-service credits are unavailable. Check the provider account." : "Price service is cooling down. Retry missing prices after the cooldown.", coolingKind, coolingUntil);
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
        if ([402, 403].includes(response.status) && marketDataPath(path)) throw new PricingProviderError("This PKMNPrices account cannot access that market series.", "CONFIG");
        if ([402, 403].includes(response.status) && path.includes("/listings/cardmarket?")) {
            throw new PricingProviderError("PKMNPrices denied access to Cardmarket offers for this account.", "CONFIG");
        }
        if (response.status >= 500 || [401, 403].includes(response.status)) {
            coolingKind = response.status >= 500 ? "TEMPORARY" : "CONFIG";
            coolingUntil = Math.max(coolingUntil, Date.now() + 30_000);
            throw new PricingProviderError(message, coolingKind, coolingUntil);
        }
        throw new Error(message);
    }

    await (marketDataPath(path) ? saveMarketData : writeCache)(`pkmnprices:${path}`, body);

    return body;
}

export function catalogSample(params: URLSearchParams, cachedOnly = false) {
    return (cachedOnly ? cachedApiGet : apiGet)("/cards?" + params, 24);
}
export function recentVolume(id: number, kind?: boolean, cachedOnly = false) {
    const query = new URLSearchParams({ currency: "usd", period: "30d", limit: "64" });
    if (kind !== undefined) query.set("graded", String(kind));
    return (cachedOnly ? cachedApiGet : apiGet)("/cards/" + id + "/sales/volume?" + query, 6);
}
export function dailyRawHistory(id: string, variant: string, condition: string) {
    const query = new URLSearchParams({ currency: "usd", period: "90d", variant, condition, limit: "90" });
    return apiGet("/cards/" + id + "/prices/history?" + query, 12);
}

interface PkmnVariantEntry {
    currency?: string;
    variant: string;
}

interface PkmnCard {
    id: number;
    tcg_player_id?: number | null;
    name: string;
    number: string;
    total_set_number?: string | null;
    set?: { id: number; name: string };
    // The card-detail response carries native variant labels in this array.
    prices?: PkmnVariantEntry[];
}

function nativeCardName(card: PkmnCard): string {
    return catalogPrintedName(card.name, card.set?.name, card.number);
}

function nativeCardMatchesName(card: PkmnCard, name: string, catalogSet?: string): boolean {
    return sameNumberedCatalogName(nativeCardName(card), name, card.set?.name ?? catalogSet, cardNumberOf(card));
}

// A pkmnprices card in the shape identity and pricing expect.
export function toCardRecord(detail: PkmnCard): CardRecord {
    const variants = (detail.prices ?? []).filter(entry => (entry.currency ?? "USD") === "USD").map(entry => entry.variant);

    return {
        source: "pkmnprices",
        id: detail.id,
        ...(typeof detail.tcg_player_id === "number" && Number.isSafeInteger(detail.tcg_player_id) && detail.tcg_player_id > 0
            ? { tcgPlayerId: detail.tcg_player_id } : {}),
        name: nativeCardName(detail),
        setName: detail.set?.name ?? null,
        cardNumber: cardNumberOf(detail),
        variants: cardVariants([...new Set(variants)], detail.set?.name),
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
        for (const item of items.filter(item => item && nativeCardMatchesName(item, name, entry.name))) {
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
        if (detail?.id !== item.id || !nativeCardMatchesName(detail, name) || !sameSetFamily(detail.set?.name, set) ||
            !sameCardNumber(cardNumberOf(detail), cardNumberOf(item))) return incomplete;
        cards.push(toCardRecord(detail));
    }
    return { cards, complete: true };
}

// Only a complete broad page can stand in for a number-filtered lookup.
// A cached prefix may omit even the only matching card.
function completeCatalogPage(page: ApiBody, size: number): boolean {
    if (!Array.isArray(page?.data)) return false;
    const pagination = page.pagination;
    if (!pagination) return page.data.length < size;
    return pagination.page === 1 && !pagination.next_cursor && pagination.total === page.data.length &&
        pagination.total_pages <= 1;
}

// Candidate cards for a listing: every set in the listing's set family,
// narrowed by name and number before the per-card price lookups.
async function lookupCardsFrom({ set, name, cardNumber }: Parameters<LookupCards>[0],
    get: (path: string, maxAgeHours?: number) => Promise<ApiBody | null>, cached: typeof readApiCache,
    screening?: { maxCards: number }, allowCatalogOnly = false): ReturnType<LookupCards> {

    const nativeTerm = pricingSearchName(name);
    const printedName = numberedCatalogName(name, set, cardNumber);
    const nameTerm = pricingSearchName(printedName);
    const alias = catalogQueryAlias(printedName);
    if (!nameTerm) return [];
    const sets = await get(
        `/sets?${new URLSearchParams({ name: setSearchTerm(set), language: "English", per_page: "50" })}`,
        DAY * 7
    );

    const familySets: { id: number; name: string }[] = (sets?.data ?? []).filter((s: { name: string }) =>
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
        if (numeric) {
            params.set("number", numeric[1]!.replace(/^0+(?=\d)/, ""));
            if (!completeCatalogPage(list, 20)) list = null;
        }
        if (!list && nativeTerm !== nameTerm) {
            const previousParams = new URLSearchParams(params);
            previousParams.set("name", nativeTerm);
            const previous = await cached(`/cards?${previousParams}`, DAY);
            if (Array.isArray(previous?.data) && previous.data.some((item: PkmnCard) => item &&
                sameCardNumber(cardNumberOf(item), cardNumber) && nativeCardMatchesName(item, name, familySet.name))) list = previous;
        }
        if (!list && alias) {
            const alternate = new URLSearchParams(params);
            alternate.set("name", alias);
            const numbered = await cached(`/cards?${alternate}`, DAY);
            alternate.delete("number");
            const prior = numbered ?? await cached(`/cards?${alternate}`, DAY);
            if (Array.isArray(prior?.data) && prior.data.some((item: PkmnCard) => item &&
                sameCardNumber(cardNumberOf(item), cardNumber) && nativeCardMatchesName(item, name, familySet.name))) list = prior;
        }
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
                if (completeCatalogPage(previous, 20) && previous.data.some((item: PkmnCard) => item && nativeCardMatchesName(item, name, familySet.name) &&
                    (!item.set?.name || sameSetFamily(item.set.name, set)) &&
                    (!cardNumber || sameCardNumber(cardNumberOf(item), cardNumber)))) {
                    list = previous;
                    break;
                }
            }
        }
        if (!list && alias && /[♀♂]\s*$/.test(printedName)) params.set("name", alias);
        list ??= await get(`/cards?${params}`);

        for (const item of list?.data ?? []) {
            if (!item || item.set?.name && !sameSetFamily(item.set.name, set)) continue;
            if (cardNumber ? !sameCardNumber(cardNumberOf(item), cardNumber) : !screening) continue;
            if (!nativeCardMatchesName(item, name, familySet.name)) continue;

            const detail = await get(`/cards/${item.id}?currency=usd`);
            if (!detail && allowCatalogOnly && item.set?.name) {
                cards.push(toCardRecord(item));
                continue;
            }
            if (detail?.id !== item.id || !nativeCardMatchesName(detail, name) || !sameSetFamily(detail.set?.name, set) ||
                cardNumber && !sameCardNumber(cardNumberOf(detail), cardNumber) ||
                !sameCardNumber(cardNumberOf(detail), cardNumberOf(item))) continue;
            cards.push(toCardRecord(detail));
            if (screening && cards.length >= screening.maxCards) return cards;
        }
    }

    return cards;
}

// Reuse the same catalog detail and cache as sold pricing. Active offer pages
// are scoped to a previously resolved record and a single bounded market.
async function readPricingRecord(recordId: string, get: typeof cachedApiGet) {
    const detail: PkmnCard | null = await get(`/cards/${recordId}?currency=usd`, DAY * 7);
    if (!detail || String(detail.id) !== recordId || !detail.name || !detail.set?.name || !Array.isArray(detail.prices)) return null;
    return toCardRecord(detail);
}
export const pricingRecord = (recordId: string) => readPricingRecord(recordId, apiGet);
export const cardmarketRecord = pricingRecord;
export const cachedPricingRecord = (recordId: string) => readPricingRecord(recordId, cachedApiGet);
export async function cardmarketOfferPage(recordId: string, params: URLSearchParams): Promise<unknown[]> {
    const body = await apiGet(`/cards/${recordId}/listings/cardmarket?${params}`, 1);
    if (!Array.isArray(body?.data)) throw new PricingProviderError("PKMNPrices returned an unreadable Cardmarket offer page.", "TEMPORARY");
    return body.data;
}

export const lookupCards: LookupCards = query => lookupCardsFrom(query, apiGet, cachedApiGet);
export const lookupCachedCards: LookupCards = query => {
    // Reconsider physical identity, which can reuse exact catalog records after
    // their narrower live pricing TTL. toCardRecord never retains amounts.
    const saved = (path: string) => cachedApiGet(path, DAY * 30);
    return lookupCardsFrom(query, saved, saved, undefined, true);
};

// Currencies belong to individual rows. Keep all revisions until the result
// pages have been reconciled so a corrected EUR row can retire an old USD row.
const usdSales = (sales: readonly Comp[]) => uniqueSoldComps(sales).filter(sale => sale.currency === "USD");
const soldPage = (body: ApiBody, stream: SoldStream): SoldPage => ({
    sales: uniqueSoldComps(body.data ?? []),
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
        if (mode === "CONFIRMED") query.set("sale_type", CONFIRMED_SALE_TYPES.join(","));
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
            const usd = usdSales(sales);
            const useful = stopWhen ? await stopWhen(usd)
                : usd.some(sale => CONFIRMED_SALE_TYPES.includes(sale.sale_type ?? ""));
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
async function cachedSoldPage(path: string, maxAgeHours = 6) {
    return await cachedApiGet(path, maxAgeHours) ?? { data: [] };
}

async function collectSoldPages(recordId: CardRecord["id"], params: URLSearchParams, { stopWhen }: SoldPageSelection = {}, minimumPages = 1, get = apiGet) {
    const sales: Comp[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined, stream: SoldStream | undefined;
    const limit = stopWhen ? SOLD_MARKET_PAGE_LIMIT : 2;
    for (let page = 0; page < limit; page += 1) {
        getPriceResearchSignal()?.throwIfAborted();
        const key = JSON.stringify([stream, cursor]);
        if (seen.has(key)) break;
        seen.add(key);
        const result = await readSoldPage(recordId, params, { cursor, stream, stopWhen }, get);
        sales.push(...result.sales);
        const enough = stopWhen && page + 1 >= minimumPages && await stopWhen(usdSales(sales));
        getPriceResearchSignal()?.throwIfAborted();
        if (enough) {
            if (params.get("graded") !== "false") break;
            // Later raw pages may already be saved from another listing's research.
            // Complete the condition sample from those pages without another request.
            get = cachedSoldPage;
        }
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
        stream = result.stream;
    }
    return usdSales(sales);
}

export function soldMarketParams(variant: string | undefined, grader: string | null, grade: number | string | null) {
    if (!grader) return new URLSearchParams({ graded: "false", period: "90d", sort: "date_desc", limit: "20", variant: variant ?? "" });
    const params = new URLSearchParams({
        graded: "true",
        grader,
        grade: String(grade),
        limit: "20",
        sort: "date_desc",
        period: "180d",
    });

    if (variant) params.set("variant", variant);

    return params;
}
async function gradedSoldPages(recordId: CardRecord["id"], { grader, grade, variant, stopWhen }: Parameters<FetchComps>[1], get: typeof apiGet) {
    return collectSoldPages(recordId, soldMarketParams(variant, grader, grade), { stopWhen }, 1, get);
}
export const fetchComps: FetchComps = (recordId, target) => gradedSoldPages(recordId, target, apiGet);
export const fetchCachedComps: FetchComps = (recordId, target) => gradedSoldPages(recordId, target, cachedSoldPage);

// Retain the first two pages of raw research candidates. Sparse markets may
// recover the same later pages admitted by screening, up to four total.
export const fetchRawComps: FetchRawComps = async (recordId, variant, selection) => {
    const params = soldMarketParams(variant, null, null);
    return collectSoldPages(recordId, params, selection, 2);
};

export const fetchCachedRawComps: FetchRawComps = (recordId, variant, selection) =>
    collectSoldPages(recordId, soldMarketParams(variant, null, null), selection, 2, cachedSoldPage);

// These use the same cache, pacing, cancellation and original-search accounting
// as sold research. Live offers are not completed transactions.
export async function fetchTcgplayerConditionData(recordId: CardRecord["id"], condition: string, printing: string, cursor?: string, cachedOnly = false) {
    const params = new URLSearchParams({ condition, language: "English", printing, sort: "total_asc", limit: "20" });
    if (cursor) params.set("cursor", cursor);
    return (cachedOnly ? cachedApiGet : apiGet)(`/cards/${recordId}/listings/tcgplayer?${params}`, 1);
}
export async function fetchTcgplayerMarketData(recordId: CardRecord["id"], cachedOnly = false) {
    return (cachedOnly ? cachedApiGet : apiGet)(`/cards/${recordId}`, DAY);
}

export function createScreeningPriceSource({ signal: sourceSignal, maxSoldAgeHours }: { signal?: AbortSignal; maxSoldAgeHours?: number } = {},
    replay?: { read: typeof readApiCache }) {
    const signal = combinedSignal(sourceSignal, getPriceResearchSignal());
    let requests = 0;
    const queryCatalogs = new Map<string, CardRecord[]>();
    // One source session reads the same set/catalog and legacy sold paths for
    // many copies. Keep positive saved responses and share pending SQL reads.
    // A missing response remains refreshable after another stage saves it.
    const cachedResponses = new Map<string, Promise<ApiBody | null>>();
    const queryKey = (query: { set: string; name: string }) => JSON.stringify([[...setFamily(query.set)].sort(), canonicalCatalogName(query.name)]);
    const cached: typeof readApiCache = async (path, maxAgeHours) => {
        signal?.throwIfAborted();
        const key = JSON.stringify([path, maxAgeHours]);
        let pending = cachedResponses.get(key);
        if (!pending) {
            pending = (replay?.read ?? readApiCache)(path, maxAgeHours);
            cachedResponses.set(key, pending);
            pending.then(value => { if (!value) cachedResponses.delete(key); }, () => { cachedResponses.delete(key); });
        }
        const result = await pending;
        signal?.throwIfAborted();
        return result;
    };
    const get: typeof apiGet = async (path, maxAgeHours = DAY) => {
        const saved = await cached(path, maxAgeHours);
        if (saved) return saved;
        if (replay) throw new PricingProviderError("No saved price response for this replay.", "TEMPORARY");
        const key = `${path}:${maxAgeHours}`;
        const sponsor = requestSponsor(signal, () => { requests += 1; });
        const detach = attachSponsor(requestSponsors, key, sponsor);
        try {
            const { response, body } = await share(key, workSignal => loadAttempt(path, maxAgeHours, workSignal, key), signal);
            if (!response || response.ok) {
                cachedResponses.set(JSON.stringify([path, maxAgeHours]), Promise.resolve(body));
                return body;
            }
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
        const age = (hours = 6) => Math.min(hours, maxSoldAgeHours ?? hours);
        return readSoldPage(recordId, params, { cursor, stream, stopWhen },
            (path, hours) => get(path, age(hours)), (path, hours) => cached(path, age(hours)), signal);
    };
    const source: { lookupCards: LookupCards; lookupQueryCards: LookupQueryCards; fetchComps: FetchComps; fetchRawComps: FetchRawComps; fetchSoldPage: FetchSoldPage; stats(): { requests: number } } = {
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
            if (variant) return usdSales((await fetchSoldPage(recordId, { grader, grade: String(grade), variant, stopWhen })).sales);
            // Retain the optional variant's established URL for other callers.
            const params = new URLSearchParams({ graded: "true", grader, grade: String(grade), limit: "20", sort: "date_desc", period: "180d" });
            return usdSales((await readSoldPage(recordId, params, { stopWhen }, get, cached, signal)).sales);
        },
        fetchRawComps: async (recordId, variant, selection) => usdSales((await fetchSoldPage(recordId, { grader: null, grade: null, variant, ...selection })).sales),
        fetchSoldPage,
        stats: () => ({ requests }),
    };
    return source;
}
