import type { EbayUsage, SearchIntent } from "../types";
import { describeSearchCriteria } from "../../../shared/search-criteria.ts";
import { name } from "../format";

export type AnalysisBlockCode = "AI_CREDITS" | "AI_PAUSED" | "AI_BUDGET" | "STORAGE_UNAVAILABLE";
export function analysisBlockPolicy(code: AnalysisBlockCode | null) {
    switch (code) {
        case "AI_CREDITS": return { title: "AI credits unavailable", retryLabel: "Retry after adding credits",
            stopListingStream: true, detail: "New analysis is stopped. Retry the remaining saved candidates after credits are available." };
        case "STORAGE_UNAVAILABLE": return { title: "Saved evidence unavailable", retryLabel: "Retry when storage is available",
            stopListingStream: true, detail: "New analysis is stopped to avoid buying replacement evidence. Saved results stay visible." };
        case "AI_BUDGET": return { title: "AI spending guard blocked this search", retryLabel: null,
            stopListingStream: false, detail: "New analysis is stopped. Matching listings can still finish loading; retrying cannot increase this search's AI allowance." };
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
    const search = usage.searchBudget ? ` This search: ${usage.searchBudget.remaining} of ${usage.searchBudget.limit} requests left.` : "";
    return usage.braking
        ? `${left}. New optional lookups are paused to preserve the daily reserve.${search}`
        : `${left}.${search}`;
}
