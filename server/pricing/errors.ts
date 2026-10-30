import { ProviderError } from "../lib/http.ts";
import type { PricingIssue } from "../../shared/pricing-retries.ts";

export class PricingProviderError extends ProviderError {
    constructor(message: string, readonly kind: PricingIssue["kind"], readonly retryAt: number | null = null) { super(message); }
}
export function pricingIssue(error: unknown, now = Date.now()): PricingIssue | undefined {
    if (error instanceof PricingProviderError) return { kind: error.kind, retryAt: error.retryAt === null ? null : new Date(error.retryAt).toISOString() };
    if (error instanceof ProviderError) return { kind: "TEMPORARY", retryAt: new Date(now + 30_000).toISOString() };
    return undefined;
}
export function retryAfterMs(value: string | null, now: number, fallback: number): number {
    const seconds = value?.trim() ? Number(value) : NaN;
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const date = value ? Date.parse(value) : NaN;
    return Number.isFinite(date) && date > now ? date - now : fallback;
}
