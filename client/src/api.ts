import type { DeeperPhotoReview, EbayUsage, Evaluation, ListingSummary, SearchIntent, Targets } from "./types";
import type { ShortlistEntry, RefreshResult } from "../../shared/shortlist.ts";
import type { PricingRetryResult, PricingRecoveryProgress } from "../../shared/pricing-retries.ts";

export function retryPricingBatch(tickets: string[], targets: Targets, includeOffers: boolean, signal: AbortSignal): Promise<PricingRetryResult> {
    return request(`/api/pricing/retry?profit=${targets.minProfit}&roi=${targets.minRoi}&offers=${includeOffers ? 1 : 0}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickets }), signal });
}

// fetch, with a plain message when the server can't be reached at all.
async function reach(url: string, init?: RequestInit): Promise<Response> {
    try {
        return await fetch(url, init);
    } catch (error) {
        if (init?.signal?.aborted) throw error;
        throw new Error("Can't reach the app's server. Is npm run dev running?");
    }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await reach(url, init);
    const body = await response.json().catch(() => null);

    if (!response.ok) {
        throw new Error(body?.error ?? `Request failed (${response.status})`);
    }

    return body as T;
}

export type DealsMessage =
    | { type: "start"; total: number; found: number; count: number; skipped: number; intent: SearchIntent; mode?: "new"; deferred?: number; previouslySeen?: number }
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
        throw new Error(`Search failed (${response.status})`);
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
    { maxResults, minPrice, signal, targets, includeOffers = false }: { maxResults: number; minPrice: number; signal?: AbortSignal; targets?: Targets; includeOffers?: boolean },
    onMessage: (message: DealsMessage) => void
): Promise<void> {
    const criteria = targets ? `&profit=${targets.minProfit}&roi=${targets.minRoi}` : "";
    return streamLines(`/api/deals?q=${encodeURIComponent(query)}&max=${maxResults}&min=${minPrice}${criteria}&offers=${includeOffers ? 1 : 0}`, onMessage, signal);
}

export function streamNewDeals(query: string, options: { minPrice: number; signal?: AbortSignal; targets: Targets; includeOffers: boolean; knownIds: string[] }, onMessage: (message: DealsMessage) => void): Promise<void> {
    return streamLines(`/api/deals/new?min=${options.minPrice}&profit=${options.targets.minProfit}&roi=${options.targets.minRoi}&offers=${options.includeOffers ? 1 : 0}`, onMessage, options.signal,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, knownIds: options.knownIds.slice(-500) }) });
}

export function resolveListingLink(input: string, signal?: AbortSignal): Promise<ListingSummary> {
    return request("/api/listings/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }), signal });
}

export async function fetchShortlist(): Promise<ShortlistEntry[]> { return (await request<{ entries: ShortlistEntry[] }>("/api/shortlist")).entries; }
export function saveListing(listing: ListingSummary): Promise<ShortlistEntry> {
    return request("/api/shortlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ listing }) });
}
export function updateSavedListing(id: string, notes: string, ceiling: number | null): Promise<ShortlistEntry> {
    return request(`/api/shortlist/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes, ceiling }) });
}
export function removeSavedListing(id: string): Promise<{ removed: string }> { return request(`/api/shortlist/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function refreshSavedListings(ids: string[]): Promise<RefreshResult> {
    return request("/api/shortlist/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
}

export type DigMessage =
    | { type: "start"; total: number; queries: string[] }
    | { type: "listing"; listing: ListingSummary }
    | { type: "done" }
    | { type: "error"; error: string };

// Dig deeper: misspelled, vague, wrong-category, and lot listings, checked by photo.
export function streamDig(query: string, minPrice: number, onMessage: (message: DigMessage) => void, targets?: Targets, includeOffers = false): Promise<void> {
    const criteria = targets ? `&profit=${targets.minProfit}&roi=${targets.minRoi}` : "";
    return streamLines(`/api/dig?q=${encodeURIComponent(query)}&min=${minPrice}${criteria}&offers=${includeOffers ? 1 : 0}`, onMessage);
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
export function fetchEbayUsage(): Promise<EbayUsage | null> {
    return request("/api/ebay-usage");
}

// Paid the first time for a listing; the server reuses saved answers
// after that. fresh asks the model again.
// The listing's current price, bid, and end time go along, so the server
// can use its saved details instead of asking eBay again.
export function evaluateListing(listing: ListingSummary, { fresh = false } = {}): Promise<Evaluation> {
    const query = fresh ? "?fresh=1" : "";

    return request(`/api/listings/${encodeURIComponent(listing.id)}/evaluate${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title: listing.title,
            images: listing.images,
            price: listing.currentPrice,
            shipping: listing.shipping,
            bids: listing.bids,
            endTime: listing.endTime,
        }),
    });
}

// Each set's release year, by set key (shared/sets.ts).
export function fetchSetYears(): Promise<Record<string, number>> {
    return request("/api/set-years");
}

export function reviewListingPhotos(itemId: string, key: string): Promise<DeeperPhotoReview> {
    return request(`/api/listings/${encodeURIComponent(itemId)}/photo-review`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }),
    });
}
