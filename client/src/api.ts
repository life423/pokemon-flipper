import type { SniperJob, SniperMode, SniperQuote } from "../../shared/sniper.ts";
import type { BuyerAccount, BuyerEnvironment } from "../../shared/ebay-connection.ts";
export function fetchShippingDestination(signal?: AbortSignal) {
    return request<{ zip: string | null }>("/api/shipping-destination", { signal, cache: "no-store" });
}
export function saveShippingDestination(zip: string) {
    return request<{ zip: string }>("/api/shipping-destination", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ zip }) });
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
    constructor(message: string, readonly code?: string) { super(message); }
}

async function reach(url: string, init?: RequestInit): Promise<Response> {
    try {
        const headers = new Headers(init?.headers);
        headers.set("X-Pokemon-Flipper", "1");
        return await fetch(url, { ...init, headers });
    } catch (error) {
        if (init?.signal?.aborted) throw error;
        throw new ApiRequestError("The app connection was interrupted. Reconnect to continue.");
    }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await reach(url, init);
    const body = await response.json().catch(() => {
        init?.signal?.throwIfAborted();
        return null;
    });

    if (!response.ok) {
        throw new ApiRequestError(body?.error ?? `Request failed (${response.status})`, body?.code);
    }

    return body as T;
}
