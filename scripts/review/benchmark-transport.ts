// Diagnostic-process observer only. It never changes application budgets,
// retries, cache contents, cancellation signals or accepted-response handling.
import { createHash } from "node:crypto";
import { EBAY_SEARCH_BROWSE_LIMIT } from "../../server/ebay/search-budget.ts";
import { PRICE_RESEARCH_LIMIT } from "../../server/pricing/research-budget.ts";

export const BENCHMARK_TRANSPORT_LIMITS = Object.freeze({ ebayBrowse: EBAY_SEARCH_BROWSE_LIMIT, prices: PRICE_RESEARCH_LIMIT, aiGeneration: 25, aiPreflight: 25 });
type BenchmarkLimits = { -readonly [Key in keyof typeof BENCHMARK_TRANSPORT_LIMITS]: number };
export type BenchmarkService = keyof typeof BENCHMARK_TRANSPORT_LIMITS | "ebayAnalytics" | "ebayOAuth" | "photos" | "azureAuth" | "unknown";
export interface BenchmarkContext { searchId?: string; listingId?: string; phase?: string }
type BoundedSchema = "bounded_card_assessment" | "bounded_slab_label_assessment" | "focused_printing_experiment" | "listing_priority_experiment";
export interface BenchmarkTransportRecord extends BenchmarkContext {
    at: string;
    service: BenchmarkService;
    path: string;
    requestHash?: string;
    schema?: BoundedSchema;
    model?: string;
    images?: number;
    dispatched: boolean;
    outcome: "blocked" | "responded" | "transport-error" | "cancelled";
    status: number | null;
    durationMs: number;
    reason?: "offline" | "limit" | "endpoint" | "schema" | "invalid-request";
    numericHeaders?: Record<string, number>;
    returnedRows?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedInputTokens?: number | null;
    cacheWriteTokens?: number | null;
    cacheWrite30mTokens?: number | null;
    cacheWrite12hTokens?: number | null;
    reasoningOutputTokens?: number | null;
}
interface Options {
    live?: boolean;
    fetch?: typeof globalThis.fetch;
    context?: () => BenchmarkContext;
    allowAzureAuth?: boolean;
    allowManagedIdentity?: boolean;
    // A diagnostic can tighten these limits, never raise them.
    limits?: Partial<BenchmarkLimits>;
}
const SERVICES: BenchmarkService[] = ["ebayBrowse", "prices", "aiGeneration", "aiPreflight", "ebayAnalytics", "ebayOAuth", "photos", "azureAuth", "unknown"];
const counts = () => Object.fromEntries(SERVICES.map(service => [service, 0])) as Record<BenchmarkService, number>;
const integer = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const identifier = (value: unknown): string | undefined => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(value) ? value : undefined;
const schemas = new Set<BoundedSchema>(["bounded_card_assessment", "bounded_slab_label_assessment", "focused_printing_experiment", "listing_priority_experiment"]);
const pricingSegments = new Set(["v1", "cards", "sets", "listings", "ebay", "prices", "price-history", "sales", "volume", "tcgplayer", "cardmarket", "history"]);
function classify(url: URL, options: Options): { service: BenchmarkService; path: string; allowed: boolean } {
    // Do not retain query strings, credentials, IDs embedded in URLs or media paths.
    if (url.username || url.password || url.port || url.protocol !== "https:") {
        if (!(options.allowManagedIdentity && url.protocol === "http:" && url.hostname === "169.254.169.254" && !url.port && !url.username && !url.password && url.pathname === "/metadata/identity/oauth2/token")) return { service: "unknown", path: "/[blocked]", allowed: false };
        return { service: "azureAuth", path: "/metadata/identity/oauth2/token", allowed: true };
    }
    if (url.hostname === "api.openai.com") {
        if (url.pathname === "/v1/responses") return { service: "aiGeneration", path: url.pathname, allowed: true };
        if (url.pathname === "/v1/responses/input_tokens") return { service: "aiPreflight", path: url.pathname, allowed: true };
        return { service: "unknown", path: "/[blocked]", allowed: false };
    }
    if (url.hostname === "api.ebay.com") {
        if (url.pathname.startsWith("/buy/browse/")) {
            const path = ["/buy/browse/v1/item_summary/search", "/buy/browse/v1/item/get_item_by_legacy_id"].includes(url.pathname) ? url.pathname
                : /^\/buy\/browse\/v1\/item\/[^/]+$/.test(url.pathname) ? "/buy/browse/v1/item/:id" : "/buy/browse/[endpoint]";
            return { service: "ebayBrowse", path, allowed: true };
        }
        if (url.pathname.startsWith("/developer/analytics/")) return { service: "ebayAnalytics", path: "/developer/analytics/[endpoint]", allowed: true };
        if (url.pathname === "/identity/v1/oauth2/token") return { service: "ebayOAuth", path: url.pathname, allowed: true };
    }
    if (url.hostname === "api.pkmnprices.com" && url.pathname.startsWith("/v1/")) return { service: "prices", path: "/" + url.pathname.split("/").filter(Boolean).map(segment => pricingSegments.has(segment) ? segment : ":id").join("/"), allowed: true };
    if (url.hostname.endsWith(".ebayimg.com") || url.hostname === "ebayimg.com") return { service: "photos", path: "/[listing-photo]", allowed: true };
    if (options.allowAzureAuth && url.hostname === "login.microsoftonline.com" && /^\/[^/]+\/oauth2\/(?:v2\.0\/)?token$/.test(url.pathname)) return { service: "azureAuth", path: "/[tenant]/oauth2/token", allowed: true };
    return { service: "unknown", path: "/[blocked]", allowed: false };
}
function safeNumericHeaders(headers: Headers): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, value] of headers) {
        if (!/^x-(?:credits|ratelimit)(?:-[a-z0-9]+)+$/.test(key) || !/^\d+(?:\.\d+)?$/.test(value)) continue;
        const number = Number(value);
        if (Number.isFinite(number) && number <= Number.MAX_SAFE_INTEGER) result[key] = number;
    }
    return result;
}
export class BenchmarkTransportBlockedError extends Error {
    readonly code = "BENCHMARK_TRANSPORT_BLOCKED";
    constructor(readonly service: BenchmarkService, readonly reason: NonNullable<BenchmarkTransportRecord["reason"]>) {
        super(`Benchmark ${service} transport blocked (${reason}); request was not sent.`);
    }
}
export function createBenchmarkTransport(options: Options = {}) {
    const delegate = options.fetch ?? globalThis.fetch;
    const limits: BenchmarkLimits = { ...BENCHMARK_TRANSPORT_LIMITS };
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
        const value = options.limits?.[key];
        if (value === undefined) continue;
        if (!Number.isSafeInteger(value) || value < 0 || value > limits[key]) throw new Error(`Invalid benchmark ${key} limit; only stricter nonnegative limits are allowed.`);
        limits[key] = value;
    }
    const records: BenchmarkTransportRecord[] = [];
    const actual = counts(), blocked = counts();
    function block(record: BenchmarkTransportRecord, reason: NonNullable<BenchmarkTransportRecord["reason"]>): never {
        record.outcome = "blocked"; record.reason = reason;
        blocked[record.service]++;
        throw new BenchmarkTransportBlockedError(record.service, reason);
    }
    const request: typeof globalThis.fetch = async (input, init) => {
        const started = performance.now();
        const context = options.context?.() ?? {};
        const record: BenchmarkTransportRecord = {
            at: new Date().toISOString(), searchId: identifier(context.searchId), listingId: identifier(context.listingId), phase: identifier(context.phase),
            service: "unknown", path: "/[blocked]", dispatched: false, outcome: "blocked", status: null, durationMs: 0,
        };
        records.push(record);
        try {
            let effective: Request;
            try { effective = new Request(input instanceof Request ? input.clone() : input, init); }
            catch { return block(record, "invalid-request"); }
            const route = classify(new URL(effective.url), options);
            record.service = route.service; record.path = route.path;
            if (!route.allowed) return block(record, "endpoint");
            if (route.service === "prices" || route.service === "ebayBrowse") record.requestHash = createHash("sha256").update(effective.method + "\n" + effective.url).digest("hex");
            if (route.service !== "azureAuth" && !options.live) return block(record, "offline");
            if (route.service === "aiGeneration" || route.service === "aiPreflight") {
                let body: any;
                try { body = JSON.parse(await effective.clone().text()); } catch { return block(record, "schema"); }
                const schema = body?.text?.format?.name;
                if (!schemas.has(schema)) return block(record, "schema");
                record.schema = schema; record.model = identifier(body.model);
                record.images = Array.isArray(body.input) ? body.input.flatMap((message: any) => Array.isArray(message?.content) ? message.content : []).filter((part: any) => part?.type === "input_image").length : 0;
                if (schema === "listing_priority_experiment" && (record.images !== 0 || body.model !== "gpt-6-luna" || body.reasoning?.effort !== "none")) return block(record, "schema");
            }
            if (effective.signal.aborted) { record.outcome = "cancelled"; effective.signal.throwIfAborted(); }
            if (Object.hasOwn(limits, route.service) && actual[route.service] >= limits[route.service as keyof typeof limits]) return block(record, "limit");
            // Reserve synchronously before awaiting transport, including failed attempts.
            actual[route.service]++;
            record.dispatched = true; record.outcome = "transport-error";
            // Redirects must not bypass the host allowlist or hide extra transports.
            const response = await delegate(effective, { redirect: "error" });
            record.status = response.status; record.outcome = "responded";
            const headers = safeNumericHeaders(response.headers);
            if (Object.keys(headers).length) record.numericHeaders = headers;
            if (["prices", "aiGeneration", "aiPreflight"].includes(route.service)) {
                const body: any = await response.clone().json().catch(() => null);
                if (route.service === "prices") record.returnedRows = Array.isArray(body?.data) ? body.data.length : null;
                else if (route.service === "aiPreflight") record.inputTokens = integer(body?.input_tokens);
                else {
                    record.inputTokens = integer(body?.usage?.input_tokens); record.outputTokens = integer(body?.usage?.output_tokens);
                    const details = body?.usage?.input_tokens_details;
                    record.cachedInputTokens = integer(details?.cached_tokens); record.cacheWriteTokens = integer(details?.cache_write_tokens);
                    record.cacheWrite30mTokens = integer(details?.cache_write_tokens_details?.ttl_30m_tokens);
                    record.cacheWrite12hTokens = integer(details?.cache_write_tokens_details?.ttl_12h_tokens);
                    record.reasoningOutputTokens = integer(body?.usage?.output_tokens_details?.reasoning_tokens);
                }
            }
            return response;
        } finally { record.durationMs = Math.round(performance.now() - started); }
    };
    return {
        fetch: request, records,
        snapshot() {
            const pricing = records.filter(record => record.service === "prices" && record.dispatched);
            return { limits: { ...limits }, actual: { ...actual }, blocked: { ...blocked },
                pricingCredits: { reportedCharged: pricing.reduce((total, record) => total + (record.numericHeaders?.["x-credits-charged"] ?? 0), 0),
                    unreportedRequests: pricing.filter(record => record.numericHeaders?.["x-credits-charged"] === undefined).length } };
        },
        assertNoBlock() {
            const denied = records.find(record => record.reason);
            if (denied?.reason) throw new BenchmarkTransportBlockedError(denied.service, denied.reason);
        },
    };
}
