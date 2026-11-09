import type { AiSearchBudget } from "./ai-usage.ts";

export const SEARCH_DIAGNOSTIC_OUTCOMES = ["DEAL", "LOSS", "REVIEW", "PRICED", "UNPRICED", "SKIPPED", "FAILED"] as const;
export const SEARCH_DIAGNOSTIC_REASONS = [
    "OTHER_LANGUAGE", "LISTING_FORMAT", "CARD_TYPE", "ABOVE_MAX_PRICE", "BELOW_MIN_PRICE", "ALREADY_SEEN",
    "OUTSIDE_AUCTION_WINDOW", "NO_IMAGES", "UNAVAILABLE", "JUNK", "UNSUPPORTED_TEXTURE", "INVALID_PRICE",
    "PRICE_ABOVE_CEILING", "PRICING_CONFIG", "PRICING_CREDITS", "SCREEN_DROPPED", "SOLD_EVIDENCE_MISSING",
    "SOLD_EVIDENCE_DEFERRED", "CRITERIA_MISMATCH", "NO_ANALYSIS_CANDIDATE", "EXACT_MARKET_UNCONFIRMED",
    "DEAL_CONFIRMED", "NET_LOSS", "TARGETS_NOT_MET", "IDENTITY_UNRESOLVED", "SLAB_LABEL_UNRESOLVED",
    "MATERIAL_REVIEW", "PRICE_EVIDENCE_UNAVAILABLE", "PRICING_DEFERRED", "ASSESSMENT_FAILED", "FILTERS_CHANGED",
    "ANALYSIS_PAUSED", "AUTO_OFF", "AUTO_LIMIT", "NOT_ASSESSED", "AI_CREDITS", "AI_PAUSED", "AI_BUDGET",
    "STORAGE_UNAVAILABLE", "PRICE_RESEARCH_BUDGET", "PRICE_RESEARCH_UNAVAILABLE",
] as const;

export interface SearchDiagnosticRow {
    id: string;
    outcome: typeof SEARCH_DIAGNOSTIC_OUTCOMES[number];
    reason: typeof SEARCH_DIAGNOSTIC_REASONS[number];
    photoChecked?: boolean;
    priced?: boolean;
    profit?: number;
}

export interface SearchDiagnosticDiscovery {
    total: number;
    found: number;
    screened?: number;
    priceExcluded?: number;
    skipped: number;
    deferred: number;
    previouslySeen?: number;
    pricePass?: { status: "COMPLETE" | "UNAVAILABLE"; newListings: number; candidates: number };
    retainedIds: string[];
}

export const SEARCH_DIAGNOSTIC_EVIDENCE_GROUPS = ["discovery", "screening", "assessment", "providerUsage", "reviewHolds"] as const;
export const SEARCH_DIAGNOSTIC_CONFIDENCE = ["low", "medium", "high"] as const;

export interface SearchDiagnosticTask {
    title: string;
    evidenceGroup: typeof SEARCH_DIAGNOSTIC_EVIDENCE_GROUPS[number];
    evidence: string;
    proposedFix: string;
    confidence: typeof SEARCH_DIAGNOSTIC_CONFIDENCE[number];
    checks: string[];
    exampleRows?: number[];
}

export interface SearchDiagnosticReview {
    summary: string;
    proposedTasks: SearchDiagnosticTask[];
}

export interface SearchDiagnosticResult {
    searchId: string;
    savedAt: string;
    status: "complete" | "skipped" | "unavailable";
    message?: string;
    review?: SearchDiagnosticReview;
    examples?: Record<string, string>;
    reviewBudget?: AiSearchBudget;
}
