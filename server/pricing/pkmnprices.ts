import { marketDataPath, readMarketData, saveMarketData } from "./market-cache.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { fetchJson, ProviderError } from "../lib/http.ts";
import { PricingProviderError, retryAfterMs } from "./errors.ts";
import type { PricingIssue } from "../../shared/pricing-usage.ts";
import { getProviderContext, withProviderContext } from "../lib/provider-context.ts";
import { getPriceResearchSignal, reservePriceRequest } from "./research-budget.ts";

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
    const owner = { ...getProviderContext() };
    return { signal, available: () => !signal?.aborted, dispatch,
        reserve: (path, workSignal) => withProviderContext(owner, () => reservePriceRequest(path, workSignal)),
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


// Low-level provider transport; returns source data without a deal verdict.
export { apiGet as pkmnPricesGet };
