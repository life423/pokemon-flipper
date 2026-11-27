import { ProviderError } from "../lib/http.ts";
import type { PricingIssue } from "../../shared/pricing-usage.ts";

export class PricingProviderError extends ProviderError {
    constructor(message: string, readonly kind: PricingIssue["kind"], readonly retryAt: number | null = null) { super(message); }
}
export function retryAfterMs(value: string | null, now: number, fallback: number): number {
    const seconds = value?.trim() ? Number(value) : NaN;
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const date = value ? Date.parse(value) : NaN;
    return Number.isFinite(date) && date > now ? date - now : fallback;
}
