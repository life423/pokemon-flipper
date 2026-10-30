import { EbayError } from "../ebay/api.ts";
import { EbayBudgetError } from "../ebay/usage.ts";
import { ProviderError } from "../lib/http.ts";

// Known provider errors carry actionable, controlled text. Never expose an
// arbitrary exception or raw response body (which may contain credentials).
export function searchFailureMessage(error: unknown): string {
    if (error instanceof ProviderError || error instanceof EbayBudgetError) return error.message;
    if (error instanceof EbayError) {
        if (error.status === 401) return "eBay authorization expired or was rejected. Check the Production credentials in .env, then restart the app.";
        if (error.status === 403) return "eBay denied access. Check that the Production app has Browse API access.";
        if (error.status === 429) return "eBay is rate limited. Please retry later.";
        if (error.status >= 500) return "eBay is temporarily unavailable. Please retry later.";
    }
    return "Failed to screen listings";
}
