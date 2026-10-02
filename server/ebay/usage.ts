import { ebayGet } from "./api.ts";
import type { EbayUsage } from "../../shared/types.ts";

// How much of today's eBay Browse allowance is left, from eBay's own count.
// Asking uses eBay's Analytics API, which doesn't use up the allowance.

const MAX_AGE_MS = 60 * 1000;

// The last share of the day's allowance is kept in reserve: past it, the
// free check stops fetching listing details and works from titles.
const RESERVE_SHARE = 0.1;

interface RateLimits {
    rateLimits?: {
        apiName: string;
        resources?: { name: string; rates?: { count: number; limit: number; remaining: number; reset?: string }[] }[];
    }[];
}

let saved: { usage: EbayUsage; at: number } | null = null;

export async function ebayUsage({ fresh = false }: { fresh?: boolean } = {}): Promise<EbayUsage | null> {
    if (!fresh && saved && Date.now() - saved.at < MAX_AGE_MS) return saved.usage;

    try {
        const data = await ebayGet<RateLimits>("/developer/analytics/v1_beta/rate_limit/?api_name=Browse&api_context=buy");
        const rate = data.rateLimits
            ?.find((api) => api.apiName === "Browse")
            ?.resources?.find((resource) => resource.name === "buy.browse")
            ?.rates?.[0];

        if (!rate) return saved?.usage ?? null;

        const usage: EbayUsage = {
            used: rate.count,
            limit: rate.limit,
            remaining: rate.remaining,
            resetsAt: rate.reset ?? null,
            braking: rate.remaining <= rate.limit * RESERVE_SHARE,
        };
        saved = { usage, at: Date.now() };

        return usage;
    } catch (error) {
        console.error(`Couldn't read eBay's usage: ${(error as Error).message}`);
        return saved?.usage ?? null;
    }
}

// Between checks with eBay, each request this server sends comes off the
// saved count.
export function countRequest(): void {
    if (!saved) return;

    const remaining = Math.max(0, saved.usage.remaining - 1);
    saved.usage = {
        ...saved.usage,
        used: saved.usage.used + 1,
        remaining,
        braking: remaining <= saved.usage.limit * RESERVE_SHARE,
    };
}

export class EbayBudgetError extends Error {}
