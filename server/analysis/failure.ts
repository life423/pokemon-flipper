import { ProviderError } from "../lib/http.ts";
import { EbayAuthenticationError, EbayError } from "../ebay/api.ts";
import { EbayBudgetError } from "../ebay/usage.ts";
export function evaluationFailure(error: unknown) {
    const value = error as { status?: number; name?: string; code?: string; message?: string };
    if (error instanceof EbayError && [404, 410].includes(error.status)) return { status: 404, error: "Listing not found or no longer available", retryable: false };
    if (error instanceof EbayAuthenticationError || error instanceof EbayBudgetError) return { status: 503, error: error.message, retryable: false };
    if ([401, 403].includes(value.status ?? 0)) return { status: 503, error: "The AI service rejected the API key or model access. Check the configured key and model.", retryable: false };
    if (value.code === "insufficient_quota") return { status: 503, error: "The AI account has insufficient credits. Saved assessments are available.", retryable: false };
    if (value.status === 429) return { status: 503, error: "The AI service is rate limited. Analysis will resume after a cooldown.", retryable: true, retryAfterMs: 30_000 };
    if (error instanceof ProviderError || value.name === "APIConnectionError" || value.name === "APIConnectionTimeoutError" || value.status && value.status >= 500) return {
        status: 503, error: error instanceof ProviderError ? error.message : "The analysis service was interrupted. Completed steps were saved.", retryable: true, retryAfterMs: error instanceof ProviderError ? Math.max(3000, error.retryAfterMs ?? 0) : 3000,
    };
    return { status: 500, error: "Listing analysis could not finish. Completed steps were kept; open the analysis to retry.", retryable: false };
}
