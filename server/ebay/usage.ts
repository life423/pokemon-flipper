import { ebayGet } from "./api.ts";
import type { EbayUsage } from "../../shared/types.ts";
import { createSingleFlight } from "../lib/single-flight.ts";
import { reserveDailyBrowseCall } from "./daily-budget.ts";
import { developmentBrowseAllowance } from "./development-budget.ts";
export { EbayBudgetError } from "./daily-budget.ts";
const share = createSingleFlight();

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

async function withDevelopmentAllowance(usage: EbayUsage | null): Promise<EbayUsage | null> {
    const development = await developmentBrowseAllowance();
    return usage && development ? { ...usage, devRemaining: development.remaining, devLimit: development.limit, devExpiresAt: development.expiresAt,
        ...(development.renewalRequired ? { devRenewalRequired: true } : {}) } : usage;
}

export async function ebayUsage({ fresh = false }: { fresh?: boolean } = {}): Promise<EbayUsage | null> {
    if (saved?.usage.resetsAt && Date.parse(saved.usage.resetsAt) <= Date.now()) saved = null;
    if (!fresh && saved && Date.now() - saved.at < MAX_AGE_MS) return withDevelopmentAllowance(saved.usage);
    const usage = await share("usage", async () => {
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
        // An expired Analytics period is not evidence that today's allowance
        // refilled. Keep its expiry so the next read discards it normally.
        const expired = usage.resetsAt && Date.parse(usage.resetsAt) <= Date.now();
        const reconciled = expired ? usage : await reserveDailyBrowseCall(usage, false, false);
        saved = { usage: reconciled, at: Date.now() };

        return reconciled;
    } catch (error) {
        console.error(`Couldn't read eBay's usage: ${(error as Error).message}`);
        return saved?.usage ?? null;
    }
    });
    return withDevelopmentAllowance(usage);
}

// Called at the actual Browse transport boundary, including nested historical
// photos and comparisons. Cached reads and Analytics do not spend Browse calls.
export async function reserveBrowseRequest(keepReserve = false): Promise<void> {
    const snapshot = saved?.usage.resetsAt && Date.parse(saved.usage.resetsAt) <= Date.now() ? null : saved?.usage ?? null;
    const usage = await reserveDailyBrowseCall(snapshot, keepReserve);
    saved = { usage, at: saved?.at ?? 0 };
}
