import { ProviderError } from "../lib/http.ts";
import { EbayAuthenticationError, EbayError } from "../ebay/api.ts";
import { EbayBudgetError } from "../ebay/usage.ts";
import { AiCreditsError, isAiCreditFailure } from "../ai/errors.ts";
import { aiSpendingFailure } from "../ai/spending.ts";
import { storageFailure } from "../lib/storage-failure.ts";
import { EnglishOnlyError } from "../../shared/card-language.ts";
import { PriceResearchBudgetError } from "../pricing/research-budget.ts";
export { EnglishOnlyError } from "../../shared/card-language.ts";
export function evaluationFailure(error: unknown) {
    if (error instanceof EnglishOnlyError) return { status: 422, code: "OTHER_LANGUAGE", error: error.message, retryable: false };
    if (error instanceof PriceResearchBudgetError) return { status: 503,
        code: error.reason === "LIMIT" ? "PRICE_RESEARCH_BUDGET" : "PRICE_RESEARCH_UNAVAILABLE", error: error.message, retryable: false };
    const storage = storageFailure(error);
    if (storage) return { status: 503, code: storage.code, error: storage.message, retryable: false };
    const spending = aiSpendingFailure(error);
    if (spending) return { status: 503, code: spending.code, error: spending.message, retryable: false };
    const value = error as { status?: number; name?: string; code?: string; message?: string };
    if (error instanceof EbayError && [404, 410].includes(error.status)) return { status: 404, error: "Listing not found or no longer available", retryable: false };
    if (error instanceof EbayAuthenticationError || error instanceof EbayBudgetError) return { status: 503, error: error.message, retryable: false };
    if ([401, 403].includes(value.status ?? 0)) return { status: 503, error: "The AI service rejected the API key or model access. Check the configured key and model.", retryable: false };
    if (isAiCreditFailure(error)) return { status: 503, code: "AI_CREDITS", error: new AiCreditsError().message, retryable: false };
    if (value.status === 429) return { status: 503, error: "The AI service is rate limited. Analysis will resume after a cooldown.", retryable: true, retryAfterMs: 30_000 };
    if (error instanceof ProviderError || value.name === "APIConnectionError" || value.name === "APIConnectionTimeoutError" || value.status && value.status >= 500) return {
        status: 503, error: error instanceof ProviderError ? error.message : "The analysis service was interrupted. Completed steps were saved.", retryable: true, retryAfterMs: error instanceof ProviderError ? Math.max(3000, error.retryAfterMs ?? 0) : 3000,
    };
    return { status: 500, error: "Listing analysis could not finish. Completed steps were kept; open the analysis to retry.", retryable: false };
}
