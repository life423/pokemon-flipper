import type { DeeperPhotoReview, EbayUsage, Evaluation, ListingSummary, SearchIntent, Targets } from "./types";
import type { SniperJob, SniperMode, SniperQuote } from "../../shared/sniper.ts";
import type { BuyerAccount, BuyerEnvironment } from "../../shared/ebay-connection.ts";
import type { CameraGradeResult } from "../../shared/camera-grade.ts";
import type { CardmarketComparison } from "../../shared/cardmarket.ts";
import type { ShortlistEntry, RefreshResult } from "../../shared/shortlist.ts";
import type { SearchPlan, SearchPlanInput } from "../../shared/search-plan.ts";
import type { PricingRetryResult } from "../../shared/pricing-retries.ts";
import type { AiUsageDay } from "../../shared/ai-usage.ts";
import type { DiscoveryOrder, ListingFilters, MarketplaceOrder } from "../../shared/listing-filters.ts";
import type { SearchDiagnosticResult, SearchDiagnosticRow, SearchSourceCoverage } from "../../shared/search-diagnostic.ts";
import type { CollectorStrategyState, LiveCollectorReport } from "../../shared/collector-strategy.ts";
import type { DealHuntRequest, DealHuntResponse } from "../../shared/deal-hunt.ts";
import { isBuyerReviewFailure, isBuyerWaitReason, type BuyerListingReview } from "../../shared/wait-skip-review.ts";
import type { SearchReviewSelection } from "../../shared/search-review-selection.ts";
import type { SearchContinuation } from "../../shared/search-continuation.ts";

export function fetchShippingDestination(signal?: AbortSignal) {
    return request<{ zip: string | null }>("/api/shipping-destination", { signal, cache: "no-store" });
}
export function saveShippingDestination(zip: string) {
    return request<{ zip: string }>("/api/shipping-destination", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ zip }) });
}

export function fetchAuctionTracking(signal?: AbortSignal) {
    return request<import("../../shared/auction-tracking.ts").AuctionTrackingResults>("/api/auction-tracking", { signal });
}

export function recheckAuctionClose(listingId: string) {
    return request<import("../../shared/auction-tracking.ts").AuctionTrackingResults>(
        `/api/auction-tracking/${encodeURIComponent(listingId)}/recheck`, { method: "POST" });
}

function filterQuery(filters?: ListingFilters): string {
    const query = new URLSearchParams();
    if (filters?.typeFilter && filters.typeFilter !== "all") query.set("type", filters.typeFilter);
    if (filters?.kindFilter && filters.kindFilter !== "all") query.set("kind", filters.kindFilter);
    if (filters?.maxPrice !== undefined) query.set("ceiling", String(filters.maxPrice));
    return query.size ? `&${query}` : "";
}

export function retryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, milliseconds);
        signal?.addEventListener("abort", cancel, { once: true });
    });
}
export function fetchAiUsage(searchRunId?: string, huntId?: string | string[]): Promise<AiUsageDay> {
    const query = new URLSearchParams();
    if (searchRunId) query.set("searchId", watchBudgets.get(searchRunId) ?? searchRunId);
    if (Array.isArray(huntId)) query.set("legs", huntId.join(","));
    else if (huntId && huntId !== query.get("searchId")) query.set("huntId", huntId);
    return request(`/api/ai-usage${query.size ? `?${query}` : ""}`);
}
export function gradeCameraCard(photos: { front: string; back: string; tilted?: string }, signal?: AbortSignal): Promise<CameraGradeResult> {
    return request("/api/camera/grade", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(photos), signal,
    });
}
// One explicit operation keeps one ID through retries and nested analysis.
// Standalone link/shortlist actions receive their own bounded request group.
const watchBudgets = new Map<string, string>();
export function restoreWatchBudget(id: string, original: string) {
    if (id !== original) watchBudgets.set(id, watchBudgets.get(original) ?? original);
}
export function newWatchScanId(parentSearchId: string): string {
    const id = crypto.randomUUID();
    restoreWatchBudget(id, parentSearchId);
    return id;
}
const searchHeaders = (searchRunId: string = crypto.randomUUID()): Record<string, string> => {
    const parent = watchBudgets.get(searchRunId);
    return { "X-Pokemon-Flipper-Search-Id": searchRunId, ...(parent && { "X-Pokemon-Flipper-Watch-Budget": parent }) };
};
export async function interpretSearchRequest(input: SearchPlanInput, searchRunId: string, signal: AbortSignal): Promise<SearchPlan> {
    signal.throwIfAborted();
    const plan = await request<SearchPlan>("/api/search-plan", { method: "POST",
        headers: { ...searchHeaders(searchRunId), "Content-Type": "application/json" }, body: JSON.stringify(input), signal });
    signal.throwIfAborted();
    if (!plan || !["named_search", "market_hunt"].includes(plan.workflow) || !plan.query?.trim() ||
        !plan.intent || !plan.marketPreferences || !["FIXED_PRICE", "AUCTION"].includes(plan.format) || !plan.summary?.trim() ||
        plan.listingFormats !== undefined && (!Array.isArray(plan.listingFormats) || plan.listingFormats.length < 1 || plan.listingFormats.length > 2 ||
            new Set(plan.listingFormats).size !== plan.listingFormats.length || !plan.listingFormats.includes(plan.format) ||
            plan.listingFormats.some(format => !["FIXED_PRICE", "AUCTION"].includes(format))))
        throw new ApiRequestError("The search interpretation was incomplete. Run the search again.");
    return plan;
}
export async function reviewBuyerListing(id: string, searchId: string, targets: Targets, offers: boolean, allowResearch: boolean, signal: AbortSignal): Promise<BuyerListingReview> {
    const path = `/api/listings/${encodeURIComponent(id)}/buyer-review?profit=${targets.minProfit}&roi=${targets.minRoi}&offers=${offers ? 1 : 0}`;
    signal.throwIfAborted();
    // The queue owns the finite cooldown policy. A second retry layer here
    // would multiply requests and could outrun a provider's actual retry time.
    const result = await request<BuyerListingReview>(path, { method: "POST", headers: { ...searchHeaders(searchId), "Content-Type": "application/json" },
        body: JSON.stringify({ allowResearch }), signal });
    if (!result || result.listingId !== id || !["WAIT", "SKIP", "BUY"].includes(result.decision) || typeof result.reason !== "string" || !result.reason.trim() ||
        result.unavailable && (result.decision !== "WAIT" || result.offer) ||
        result.failure !== undefined && (!result.unavailable || !isBuyerReviewFailure(result.failure)) ||
        result.waitReason !== undefined && (result.decision !== "WAIT" || !isBuyerWaitReason(result.waitReason)) ||
        result.retryAt !== undefined && (!result.unavailable || !result.failure?.retryable || !Number.isSafeInteger(result.retryAt) || result.retryAt < 0) ||
        result.failure?.retryable && result.retryAt === undefined)
        throw new ApiRequestError("The buyer review response was incomplete. Its purchase advice was not accepted.");
    return result;
}
export function runDealHunt(searchId: string, hunt: DealHuntRequest, signal: AbortSignal): Promise<DealHuntResponse> {
    return request("/api/deal-hunt", {
        method: "POST", headers: { ...searchHeaders(searchId), "Content-Type": "application/json" },
        body: JSON.stringify(hunt), signal,
    });
}
export function readCollectorStrategy(id: string, signal: AbortSignal): Promise<CollectorStrategyState> {
    return request(`/api/collector-strategy?searchId=${encodeURIComponent(id)}`, { signal });
}
export function startCollectorStrategy(id: string, signal: AbortSignal): Promise<CollectorStrategyState> {
    return request("/api/collector-strategy", { method: "POST", headers: searchHeaders(id), signal });
}
export function readLiveCollectorStrategy(sourceSearchId: string, signal: AbortSignal): Promise<{ report: LiveCollectorReport | null }> {
    return request(`/api/collector-strategy/live?searchId=${encodeURIComponent(sourceSearchId)}`, { signal });
}
export function startLiveCollectorStrategy(sourceSearchId: string, maxTotal: number, runId: string, signal: AbortSignal): Promise<{ report: LiveCollectorReport }> {
    return request("/api/collector-strategy/live", {
        method: "POST", headers: { ...searchHeaders(runId), "Content-Type": "application/json" },
        body: JSON.stringify({ sourceSearchId, maxTotal }), signal,
    });
}
export function fetchPriceHistory(listingId: string, market: string, signal: AbortSignal) {
    return request<import("../../shared/price-history.ts").MarketHistory>(`/api/listings/${encodeURIComponent(listingId)}/price-history`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ market }), signal,
    });
}
export function fetchMarketPrices(listingId: string, market: string, signal: AbortSignal) {
    return request<import("../../shared/listing-market-prices.ts").BuyerPriceComparison>(`/api/listings/${encodeURIComponent(listingId)}/market-prices`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ market }), signal,
    });
}
export function fetchCardmarketComparison(listingId: string, market: string, searchId?: string): Promise<CardmarketComparison> {
    return request(`/api/listings/${encodeURIComponent(listingId)}/cardmarket`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(searchId && searchHeaders(searchId)) },
        body: JSON.stringify({ market }),
    });
}

export function fetchAuctionReminders(signal?: AbortSignal): Promise<{ jobs: SniperJob[] }> {
    return request("/api/sniper?mode=reminder", { signal });
}
export function fetchBuyerAccount(signal?: AbortSignal): Promise<BuyerAccount> {
    return request("/api/ebay/connection?environment=production", { signal });
}
export function startBuyerConnection(environment: BuyerEnvironment): Promise<{ authorizationUrl: string }> {
    return request("/api/ebay/connection/start", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ environment }),
    });
}
export function disconnectBuyerAccount(): Promise<BuyerAccount> {
    return request("/api/ebay/connection/disconnect?environment=production", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ environment: "production" }),
    });
}
export function previewSnipe(url: string, mode: SniperMode, searchId?: string, signal?: AbortSignal): Promise<{ quote: SniperQuote }> {
    return request("/api/sniper/preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, mode, searchId }), signal,
    });
}
export function armSnipe(quote: SniperQuote, mode: SniperMode, maxBid: number, searchId?: string): Promise<{ job: SniperJob }> {
    return request("/api/sniper", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: quote.url, mode, maxBid, title: quote.title, endTime: quote.endTime, shipping: quote.shipping, buyerConnectionId: quote.buyerConnectionId, searchId }),
    });
}
export function cancelSnipe(id: string): Promise<{ job: SniperJob }> {
    return request(`/api/sniper/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export class ApiRequestError extends Error {
    constructor(message: string, readonly retryable = false, readonly retryAfterMs = 1500, readonly code?: string, readonly retryAt?: number,
        readonly failureScope?: "listing" | "search") {
        super(message);
        if (code === "EBAY_BUDGET") this.code = "EBAY_DAILY_BUDGET";
    }
}

export function saveSearchDiagnostic(searchRunId: string, rows: SearchDiagnosticRow[], signal: AbortSignal): Promise<SearchDiagnosticResult> {
    return request("/api/search-diagnostic", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...searchHeaders(searchRunId) },
        body: JSON.stringify({ rows }),
        signal,
    });
}

export function retryPricingBatch(tickets: string[], targets: Targets, includeOffers: boolean, signal: AbortSignal, searchRunId?: string): Promise<PricingRetryResult> {
    return request(`/api/pricing/retry?profit=${targets.minProfit}&roi=${targets.minRoi}&offers=${includeOffers ? 1 : 0}`, { method: "POST", headers: { "Content-Type": "application/json", ...searchHeaders(searchRunId) }, body: JSON.stringify({ tickets }), signal });
}

// fetch, with a plain message when the server can't be reached at all.
async function reach(url: string, init?: RequestInit): Promise<Response> {
    try {
        const headers = new Headers(init?.headers);
        headers.set("X-Pokemon-Flipper", "1");
        return await fetch(url, { ...init, headers });
    } catch (error) {
        if (init?.signal?.aborted) throw error;
        throw new ApiRequestError("The app connection was interrupted. Reconnect to continue.", true, 1500,
            url === "/api/deal-hunt" ? "FLIP_CONNECTION" : undefined);
    }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await reach(url, init);
    const body = await response.json().catch((error: unknown) => {
        init?.signal?.throwIfAborted();
        if (url === "/api/deal-hunt" && response.ok) {
            if (error instanceof TypeError) throw new ApiRequestError("The connection closed while receiving the search result.", true, 1500, "FLIP_CONNECTION");
            throw new ApiRequestError("The app returned an unreadable search result.");
        }
        return null;
    });

    if (!response.ok) {
        const declared = Number(body?.retryAfterMs);
        const cooldown = Number.isFinite(declared) && declared > 0 ? Math.max(1500, Math.ceil(declared)) : 1500;
        throw new ApiRequestError(body?.error ?? `Request failed (${response.status})`, body?.retryable === true || body?.retryable === undefined && [502, 503, 504].includes(response.status),
            Math.min(90_000, cooldown), body?.code, Number.isSafeInteger(Date.now() + cooldown) ? Date.now() + cooldown : undefined,
            body?.scope === "listing" || body?.scope === "search" ? body.scope : undefined);
    }

    return body as T;
}

export type DealsMessage =
    | { type: "progress"; found: number; screened: number }
    | { type: "start"; comparisonQuote?: ListingSummary; total: number; found: number; count: number; skipped: number; intent: SearchIntent; continuation?: SearchContinuation; sourceLimitReached?: boolean; reviewSelection?: SearchReviewSelection; mode?: "new" | "development"; deferred?: number; previouslySeen?: number; screened?: number; priceExcluded?: number; unresolvedOverflow?: number; soldPurchaseCeiling?: number; marketplaceOrder?: DiscoveryOrder; pricePass?: { status: "COMPLETE" | "UNAVAILABLE"; newListings: number; candidates: number } }
    | { type: "listing"; listing: ListingSummary }
    | ({ type: "done" } & SearchSourceCoverage)
    | { type: "error"; error: string; code?: string; retryable?: boolean; scope?: "listing" | "search" };

// A search with every listing screened for free, streamed one listing at
// a time so the page fills in while the first, slower search runs.
// Reads a stream of JSON lines, handing each message on as it arrives.
async function streamLines<T extends { type: string }>(
    url: string,
    onMessage: (message: T) => void,
    signal?: AbortSignal,
    init?: RequestInit
): Promise<void> {
    const response = await reach(url, { ...init, signal });

    if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null);
        throw new ApiRequestError(body?.error ?? `Search failed (${response.status})`, body?.retryable === true, 1500, body?.code, undefined, body?.scope);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let completed = false;
    const deliver = (line: string) => {
        if (!line.trim()) return;
        const message = JSON.parse(line) as T & { error?: string; code?: string; retryable?: boolean; scope?: "listing" | "search" };
        if (message.type === "error") throw new ApiRequestError(message.error ?? "The search could not finish.", message.retryable === true, 1500, message.code, undefined, message.scope);
        onMessage(message);
        if (message.type === "done") completed = true;
    };

    try {
        for (;;) {
            const { done, value } = await reader.read();
            buffered += decoder.decode(value, { stream: !done });

            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";

            for (const line of lines) {
                deliver(line);
                if (completed) return;
            }

            if (done) {
                deliver(buffered);
                if (!completed) throw new ApiRequestError("The search connection ended before completion. Continue the search to check the remaining listings.", true, 1500, "SEARCH_STREAM_INTERRUPTED");
                return;
            }
        }
    } catch (error) {
        if (signal?.aborted || error instanceof ApiRequestError || error instanceof SyntaxError) throw error;
        throw new ApiRequestError("The search connection was interrupted. Continue the search to check the remaining listings.", true, 1500, "SEARCH_STREAM_INTERRUPTED");
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export function streamDeals(
    query: string,
    { minPrice, signal, targets, includeOffers = false, automaticPhotos = true, filters, searchRunId, marketplaceOrder, continuation }: { minPrice: number; signal?: AbortSignal; targets?: Targets; includeOffers?: boolean; automaticPhotos?: boolean; filters?: ListingFilters; searchRunId?: string; marketplaceOrder?: MarketplaceOrder; continuation?: string },
    onMessage: (message: DealsMessage) => void
): Promise<void> {
    const criteria = targets ? `&profit=${targets.minProfit}&roi=${targets.minRoi}` : "";
    const order = marketplaceOrder ? `&order=${marketplaceOrder}` : "";
    const next = continuation ? `&continuation=${encodeURIComponent(continuation)}` : "";
    return streamLines(`/api/deals?q=${encodeURIComponent(query)}&min=${minPrice}${criteria}&offers=${includeOffers ? 1 : 0}&autoPhotos=${automaticPhotos ? 1 : 0}${filterQuery(filters)}${order}${next}`, onMessage, signal,
        { headers: searchHeaders(searchRunId) });
}

export function streamNewDeals(query: string, options: { minPrice: number; signal?: AbortSignal; targets: Targets; includeOffers: boolean; automaticPhotos?: boolean; knownIds: string[]; gradingWatch?: boolean; filters?: ListingFilters; searchRunId?: string }, onMessage: (message: DealsMessage) => void): Promise<void> {
    return streamLines(`/api/deals/new?min=${options.minPrice}&profit=${options.targets.minProfit}&roi=${options.targets.minRoi}&offers=${options.includeOffers ? 1 : 0}&autoPhotos=${options.automaticPhotos === false ? 0 : 1}${filterQuery(options.filters)}`, onMessage, options.signal,
        { method: "POST", headers: { "Content-Type": "application/json", ...searchHeaders(options.searchRunId) }, body: JSON.stringify({ query, knownIds: options.knownIds.slice(-500), gradingWatch: options.gradingWatch }) });
}

export function resolveListingLink(input: string, signal?: AbortSignal, searchRunId?: string, comparison = false): Promise<ListingSummary> {
    return request("/api/listings/resolve", { method: "POST", headers: { "Content-Type": "application/json", ...searchHeaders(searchRunId) }, body: JSON.stringify({ input, comparison }), signal });
}

export async function fetchShortlist(): Promise<ShortlistEntry[]> { return (await request<{ entries: ShortlistEntry[] }>("/api/shortlist")).entries; }
export function saveListing(listing: ListingSummary): Promise<ShortlistEntry> {
    return request("/api/shortlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ listing }) });
}
export function updateSavedListing(id: string, notes: string, ceiling: number | null): Promise<ShortlistEntry> {
    return request(`/api/shortlist/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes, ceiling }) });
}
export function removeSavedListing(id: string): Promise<{ removed: string }> { return request(`/api/shortlist/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function refreshSavedListings(ids: string[], searchRunId?: string): Promise<RefreshResult> {
    return request("/api/shortlist/refresh", { method: "POST", headers: { "Content-Type": "application/json", ...searchHeaders(searchRunId) }, body: JSON.stringify({ ids }) });
}

// How much of today's eBay allowance is left, or null if eBay won't say.
export function fetchEbayUsage(searchRunId?: string): Promise<EbayUsage | null> {
    return request("/api/ebay-usage?cachedOnly=1", searchRunId ? { headers: searchHeaders(searchRunId) } : undefined);
}

// Paid the first time for a listing; the server reuses saved answers
// after that. fresh refreshes listing terms while compatible photos are reused.
// The search's terms and their observation time let the server use saved
// listing details without replacing newer purchase terms.
export async function evaluateListing(listing: ListingSummary, { fresh = false, signal, searchRunId, automatic = false, typeFilter, includeOffers = true, targets, addedPhotosOnly = false, priceOnly = false }: { targets?: Targets; fresh?: boolean; signal?: AbortSignal; searchRunId?: string; automatic?: boolean; typeFilter?: ListingFilters["typeFilter"]; includeOffers?: boolean; addedPhotosOnly?: boolean; priceOnly?: boolean } = {}): Promise<Evaluation> {
    const account = searchRunId ?? (priceOnly ? undefined : crypto.randomUUID());
    for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        const refreshQuery = priceOnly ? "priceOnly=1" : fresh ? attempt === 0 ? "fresh=1" : "refreshTerms=1" : "";
        const query = new URLSearchParams(refreshQuery);
        if (addedPhotosOnly) query.set("addedPhotosOnly", "1");
        if (automatic && !priceOnly) {
            query.set("auto", "1");
            if (typeFilter && typeFilter !== "all") query.set("type", typeFilter);
        }
        if (!includeOffers) query.set("offers", "0");
        if (targets) { query.set("profit", String(targets.minProfit)); query.set("roi", String(targets.minRoi)); }
        try { return await request(`/api/listings/${encodeURIComponent(listing.id)}/evaluate?${query}`, {
        method: "POST",
        headers: account ? searchHeaders(account) : undefined,
        signal,
        }); } catch (error) {
            if (priceOnly || signal?.aborted || attempt > 0 || !(error instanceof ApiRequestError) || !error.retryable || error.code === "AI_EVIDENCE_HELD") throw error;
            await retryDelay(error.retryAfterMs, signal);
        }
    }
}

// Each set's release year, by set key (shared/sets.ts).
export function fetchSetYears(): Promise<Record<string, number>> {
    return request("/api/set-years?cachedOnly=1");
}

export function reviewListingPhotos(itemId: string, key: string, searchRunId?: string): Promise<DeeperPhotoReview> {
    return request(`/api/listings/${encodeURIComponent(itemId)}/photo-review`, {
        method: "POST", headers: { "Content-Type": "application/json", ...searchHeaders(searchRunId) }, body: JSON.stringify({ key }),
    });
}
