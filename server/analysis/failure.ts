import { ProviderError } from "../lib/http.ts";
import { EbayAuthenticationError, EbayError } from "../ebay/api.ts";
import { EbayBudgetError } from "../ebay/usage.ts";
import { AiCreditsError, isAiCreditFailure } from "../ai/errors.ts";
import { aiSpendingFailure } from "../ai/spending.ts";
import { storageFailure } from "../lib/storage-failure.ts";
import { EnglishOnlyError } from "../../shared/card-language.ts";
import { PriceResearchBudgetError } from "../pricing/research-budget.ts";
export { EnglishOnlyError } from "../../shared/card-language.ts";
export class RejectedPhotoAssessmentError extends Error {
    constructor(reason = "The photo observations do not establish a consistent assessment of this listing.") { super(reason); }
}
export function evaluationFailure(error: unknown) {
    // Provider/account failures can be wrapped by stored-evidence readers.
    // Preserve the authority's typed cause instead of retrying it per copy.
    const seen = new Set<unknown>();
    for (let current = error; current && typeof current === "object" && !seen.has(current); current = (current as { cause?: unknown }).cause) {
        seen.add(current);
        if (current instanceof EbayBudgetError) return { status: 503,
            code: current.reason === "QUOTA" ? "EBAY_DAILY_BUDGET" : "EBAY_BUDGET_ACCOUNTING", error: current.message, retryable: false, scope: "search" as const };
        if (current instanceof EbayAuthenticationError) return { status: 503,
            code: "EBAY_AUTH", error: current.message, retryable: false, scope: "search" as const };
    }
    if (error instanceof EnglishOnlyError) return { status: 422, code: "OTHER_LANGUAGE", error: error.message, retryable: false };
    if (error instanceof PriceResearchBudgetError) return { status: 503,
        code: error.reason === "LIMIT" ? "PRICE_RESEARCH_BUDGET" : "PRICE_RESEARCH_UNAVAILABLE", error: error.message, retryable: false };
    const storage = storageFailure(error);
    if (storage) return { status: 503, code: storage.code, error: storage.message, retryable: false, scope: storage.scope };
    const spending = aiSpendingFailure(error);
    if (spending) return { status: spending.code === "AI_EVIDENCE_HELD" ? 409 : 503, code: spending.code, error: spending.message,
        retryable: false, ...(spending.scope && { scope: spending.scope }) };
    if (error instanceof RejectedPhotoAssessmentError) return { status: 422, code: "PHOTO_ASSESSMENT_REJECTED", error: error.message, retryable: false };
    const value = (error ?? {}) as { status?: number; name?: string; code?: string; message?: string };
    if (error instanceof EbayError && [404, 410].includes(error.status)) return { status: 404, error: "Listing not found or no longer available", retryable: false };
    if ([401, 403].includes(value.status ?? 0)) return { status: 503, error: "The AI service rejected the API key or model access. Check the configured key and model.", retryable: false };
    if (isAiCreditFailure(error)) return { status: 503, code: "AI_CREDITS", error: new AiCreditsError().message, retryable: false };
    if (value.status === 429) return { status: 503, error: "The AI service is rate limited. Analysis will resume after a cooldown.", retryable: true, retryAfterMs: 30_000 };
    if (error instanceof ProviderError || value.name === "APIConnectionError" || value.name === "APIConnectionTimeoutError" || value.status && value.status >= 500) return {
        status: 503, error: error instanceof ProviderError ? error.message : "The analysis service was interrupted.", retryable: true, retryAfterMs: error instanceof ProviderError ? Math.max(3000, error.retryAfterMs ?? 0) : 3000,
    };
    return { status: 500, error: "Listing analysis could not finish. Open the analysis to retry.", retryable: false };
}
