import type { Evaluation, ListingSummary, SearchIntent } from "./types";

// fetch, with a plain message when the server can't be reached at all.
async function reach(url: string, init?: RequestInit): Promise<Response> {
    try {
        return await fetch(url, init);
    } catch {
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
    | { type: "start"; total: number; found: number; count: number; intent: SearchIntent }
    | { type: "listing"; listing: ListingSummary }
    | { type: "done" }
    | { type: "error"; error: string };

// A search with every listing screened for free, streamed one listing at
// a time so the page fills in while the first, slower search runs.
export async function streamDeals(query: string, onMessage: (message: DealsMessage) => void): Promise<void> {
    const response = await reach(`/api/deals?q=${encodeURIComponent(query)}`);

    if (!response.ok || !response.body) {
        throw new Error(`Search failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    for (;;) {
        const { done, value } = await reader.read();

        buffered += decoder.decode(value, { stream: !done });

        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";

        for (const line of lines) {
            if (!line.trim()) continue;

            const message = JSON.parse(line) as DealsMessage;

            if (message.type === "error") throw new Error(message.error);
            onMessage(message);
        }

        if (done) return;
    }
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
            price: listing.currentPrice,
            shipping: listing.shipping,
            bids: listing.bids,
            endTime: listing.endTime,
        }),
    });
}
