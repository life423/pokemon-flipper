import type { EbayUsage, SearchIntent } from "../types";
import { describeSearchCriteria } from "../../../shared/search-criteria.ts";
import { name } from "../format";

export type AnalysisBlockCode = "AI_CREDITS" | "AI_PAUSED" | "AI_BUDGET" | "STORAGE_UNAVAILABLE" | "PRICE_RESEARCH_BUDGET" | "PRICE_RESEARCH_UNAVAILABLE" |
    "EBAY_DAILY_BUDGET" | "EBAY_BUDGET_ACCOUNTING" | "EBAY_AUTH" | "AI_ACCOUNTING" | "AI_INPUT_PREFLIGHT";
export function analysisBlockPolicy(code: AnalysisBlockCode | null) {
    switch (code) {
        case "EBAY_DAILY_BUDGET": return { title: "eBay daily reserve protected", retryLabel: "Retry after quota resets",
            stopListingStream: true, detail: "New research is paused to keep eBay's daily reserve available." };
        case "EBAY_BUDGET_ACCOUNTING": return { title: "eBay usage accounting unavailable", retryLabel: "Retry when accounting is available",
            stopListingStream: true, detail: "New research is paused until eBay usage accounting is available." };
        case "EBAY_AUTH": return { title: "eBay access unavailable", retryLabel: "Retry after fixing eBay access",
            stopListingStream: true, detail: "New research is paused until eBay access is restored." };
        case "PRICE_RESEARCH_BUDGET": return { title: "Previous price request limit", retryLabel: "Retry with current request policy",
            stopListingStream: true, detail: "This search stopped under the previous price request limit." };
        case "PRICE_RESEARCH_UNAVAILABLE": return { title: "Price research accounting unavailable", retryLabel: "Retry when accounting is available",
            stopListingStream: true, detail: "New analysis is stopped until price-request accounting is available." };
        case "AI_CREDITS": return { title: "AI credits unavailable", retryLabel: "Retry after adding credits",
            stopListingStream: true, detail: "New analysis is stopped. Retry the remaining candidates after credits are available." };
        case "AI_PAUSED": return { title: "Paid AI is paused", retryLabel: "Retry after AI is resumed",
            stopListingStream: false, detail: "New checks are paused. Resume paid AI in its existing spending configuration to continue under this search’s allowance." };
        case "STORAGE_UNAVAILABLE": return { title: "Research storage unavailable", retryLabel: "Retry when storage is available",
            stopListingStream: true, detail: "New checks can resume when storage is available." };
        case "AI_ACCOUNTING": return { title: "AI spending records unavailable", retryLabel: "Retry when accounting is available",
            stopListingStream: true, detail: "New AI checks need durable spending records." };
        case "AI_INPUT_PREFLIGHT": return { title: "AI input check unavailable", retryLabel: "Retry AI input check",
            stopListingStream: true, detail: "The app needs an exact input check before starting new AI analysis." };
        case "AI_BUDGET": return { title: "AI spending guard blocked this search", retryLabel: "Retry AI checks",
            stopListingStream: false, detail: "New analysis is paused under the current spending limit." };
        default: return { title: "Paid AI unavailable", retryLabel: null,
            stopListingStream: false, detail: "New analysis is stopped. Matching listings can still load; the server's spending configuration must be ready before paid work can resume." };
    }
}

// "1st Edition Charizard from Base Set, graded": how the search was read.
export function describeIntent(intent: SearchIntent): string {
    let text = [intent.printing ? name(intent.printing) : null, intent.cardName ?? (intent.sets.length ? "cards" : "listings for this search")]
        .filter(Boolean)
        .join(" ");

    if (intent.sets.length > 0) text += ` from ${intent.sets.join(" or ")}`;
    if (intent.cardNumber) text += ` #${intent.cardNumber}`;
    const criteria = describeSearchCriteria(intent);
    if (criteria.length) text += ` · ${criteria.join(" · ")}`;

    return text;
}

export function describeUsage(usage: EbayUsage): string {
    const left = `eBay today: ${usage.remaining.toLocaleString()} of ${usage.limit.toLocaleString()} requests left`;
    const search = usage.searchBudget ? usage.searchBudget.limit === null
        ? ` This search used ${usage.searchBudget.used.toLocaleString()} Browse requests.`
        : ` This search: ${usage.searchBudget.remaining} of ${usage.searchBudget.limit} requests left.` : "";
    return usage.braking
        ? `${left}. New Browse requests are paused to protect the daily reserve.${search}`
        : `${left}.${search}`;
}
