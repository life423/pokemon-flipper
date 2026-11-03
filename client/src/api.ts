import type { DeeperPhotoReview, EbayUsage, Evaluation, ListingSummary, SearchIntent, Targets } from "./types";
import type { ShortlistEntry, RefreshResult } from "../../shared/shortlist.ts";
import type { PricingRetryResult, PricingRecoveryProgress } from "../../shared/pricing-retries.ts";
import type { AiUsageDay } from "../../shared/ai-usage.ts";
import type { ListingFilters } from "../../shared/listing-filters.ts";

function filterQuery(filters?: ListingFilters): string {
    const query = new URLSearchParams();
    if (filters?.typeFilter && filters.typeFilter !== "all") query.set("type", filters.typeFilter);
    if (filters?.kindFilter && filters.kindFilter !== "all") query.set("kind", filters.kindFilter);
    if (filters?.maxPrice !== undefined) query.set("ceiling", String(filters.maxPrice));
    return query.size ? `&${query}` : "";
}

function retryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, milliseconds);
        signal?.addEventListener("abort", cancel, { once: true });
    });
}
export function fetchAiUsage(searchRunId?: string): Promise<AiUsageDay> { return request(`/api/ai-usage${searchRunId ? `?searchId=${encodeURIComponent(searchRunId)}` : ""}`); }
// One explicit operation keeps one ID through retries and nested analysis.
// Standalone link/shortlist actions receive their own bounded request group.
const searchHeaders = (searchRunId: string = crypto.randomUUID()): Record<string, string> => ({ "X-Pokemon-Flipper-Search-Id": searchRunId });
export class ApiRequestError extends Error {
    constructor(message: string, readonly retryable = false, readonly retryAfterMs = 1500, readonly code?: string) { super(message); }
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
        throw new ApiRequestError("The app connection was interrupted. Reconnecting to resume saved analysis.", true);
    }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await reach(url, init);
    const body = await response.json().catch(() => null);

    if (!response.ok) {
        throw new ApiRequestError(body?.error ?? `Request failed (${response.status})`, body?.retryable === true || body?.retryable === undefined && [502, 503, 504].includes(response.status),
            Math.min(90_000, Math.max(1500, Number(body?.retryAfterMs) || 1500)), body?.code);
    }

    return body as T;
}

export type DealsMessage =
    | { type: "start"; total: number; found: number; count: number; skipped: number; intent: SearchIntent; mode?: "new" | "development"; deferred?: number; previouslySeen?: number }
    | { type: "listing"; listing: ListingSummary }
    | { type: "discovery"; status: "checking" | "done" | "error"; checked: number; total: number; note?: string }
    | ({ type: "pricing" } & PricingRecoveryProgress)
    | { type: "pricing-listing"; listing: ListingSummary; snapshotKey: string }
    | { type: "done" }
    | { type: "error"; error: string };

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
        throw new Error(body?.error ?? `Search failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let completed = false;
    const deliver = (line: string) => {
        if (!line.trim()) return;
        const message = JSON.parse(line) as T & { error?: string };
        if (message.type === "error") throw new Error(message.error);
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
                if (!completed) throw new Error("Search ended before completion. Results checked so far are kept; run the search again to finish.");
                return;
            }
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export function streamDeals(
    query: string,
    { maxResults, minPrice, signal, targets, includeOffers = false, filters, searchRunId }: { maxResults: number; minPrice: number; signal?: AbortSignal; targets?: Targets; includeOffers?: boolean; filters?: ListingFilters; searchRunId?: string },
    onMessage: (message: DealsMessage) => void
): Promise<void> {
    const criteria = targets ? `&profit=${targets.minProfit}&roi=${targets.minRoi}` : "";
    return streamLines(`/api/deals?q=${encodeURIComponent(query)}&max=${maxResults}&min=${minPrice}${criteria}&offers=${includeOffers ? 1 : 0}${filterQuery(filters)}`, onMessage, signal,
        { headers: searchHeaders(searchRunId) });
}

export function streamNewDeals(query: string, options: { minPrice: number; signal?: AbortSignal; targets: Targets; includeOffers: boolean; knownIds: string[]; filters?: ListingFilters; searchRunId?: string }, onMessage: (message: DealsMessage) => void): Promise<void> {
    return streamLines(`/api/deals/new?min=${options.minPrice}&profit=${options.targets.minProfit}&roi=${options.targets.minRoi}&offers=${options.includeOffers ? 1 : 0}${filterQuery(options.filters)}`, onMessage, options.signal,
        { method: "POST", headers: { "Content-Type": "application/json", ...searchHeaders(options.searchRunId) }, body: JSON.stringify({ query, knownIds: options.knownIds.slice(-500) }) });
}

export function resolveListingLink(input: string, signal?: AbortSignal, searchRunId?: string): Promise<ListingSummary> {
    return request("/api/listings/resolve", { method: "POST", headers: { "Content-Type": "application/json", ...searchHeaders(searchRunId) }, body: JSON.stringify({ input }), signal });
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

export type DigMessage =
    | { type: "start"; total: number; queries: string[] }
    | { type: "listing"; listing: ListingSummary }
    | { type: "done" }
    | { type: "error"; error: string };

// Dig deeper: misspelled, vague, wrong-category, and lot listings, checked by photo.
export function streamDig(query: string, minPrice: number, onMessage: (message: DigMessage) => void, targets?: Targets, includeOffers = false, searchRunId?: string): Promise<void> {
    const criteria = targets ? `&profit=${targets.minProfit}&roi=${targets.minRoi}` : "";
    return streamLines(`/api/dig?q=${encodeURIComponent(query)}&min=${minPrice}${criteria}&offers=${includeOffers ? 1 : 0}`, onMessage, undefined, { headers: searchHeaders(searchRunId) });
}

// A friendly note to send with a Best Offer, written fresh each time.
export async function writeOfferNote(title: string): Promise<string> {
    const { note } = await request<{ note: string }>("/api/offer-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
    });

    return note;
}

// How much of today's eBay allowance is left, or null if eBay won't say.
export function fetchEbayUsage(searchRunId?: string): Promise<EbayUsage | null> {
    return request("/api/ebay-usage", searchRunId ? { headers: searchHeaders(searchRunId) } : undefined);
}

// Paid the first time for a listing; the server reuses saved answers
// after that. fresh asks the model again.
// The listing's current price, bid, and end time go along, so the server
// can use its saved details instead of asking eBay again.
export async function evaluateListing(listing: ListingSummary, { fresh = false, signal, searchRunId = crypto.randomUUID(), automatic = false }: { fresh?: boolean; signal?: AbortSignal; searchRunId?: string; automatic?: boolean } = {}): Promise<Evaluation> {
    for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        const refreshQuery = fresh ? attempt === 0 ? "?fresh=1" : "?refreshTerms=1" : "";
        const query = automatic ? `${refreshQuery}${refreshQuery ? "&" : "?"}auto=1` : refreshQuery;
        try { return await request(`/api/listings/${encodeURIComponent(listing.id)}/evaluate${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...searchHeaders(searchRunId) },
        signal,
        body: JSON.stringify({
            title: listing.title,
            images: listing.images,
            price: listing.currentPrice,
            shipping: listing.shipping,
            bids: listing.bids,
            endTime: listing.endTime,
        }),
        }); } catch (error) {
            if (signal?.aborted || attempt > 0 || !(error instanceof ApiRequestError) || !error.retryable) throw error;
            await retryDelay(error.retryAfterMs, signal);
        }
    }
}

// Each set's release year, by set key (shared/sets.ts).
export function fetchSetYears(): Promise<Record<string, number>> {
    return request("/api/set-years");
}

export function reviewListingPhotos(itemId: string, key: string, searchRunId?: string): Promise<DeeperPhotoReview> {
    return request(`/api/listings/${encodeURIComponent(itemId)}/photo-review`, {
        method: "POST", headers: { "Content-Type": "application/json", ...searchHeaders(searchRunId) }, body: JSON.stringify({ key }),
    });
}
