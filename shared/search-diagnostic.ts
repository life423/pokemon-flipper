import type { AiSearchBudget } from "./ai-usage.ts";
import type { AutoAnalysisBlockReason } from "./analysis.ts";
import type { SearchReviewSelection } from "./search-review-selection.ts";
import type { DiscoveryOrder } from "./listing-filters.ts";
import type { Seller } from "./types.ts";

export const SEARCH_DIAGNOSTIC_OUTCOMES = ["DEAL", "LOSS", "WAIT", "SKIP", "REVIEW", "PRICED", "UNPRICED", "SKIPPED", "FAILED"] as const;
export const SEARCH_DIAGNOSTIC_REASONS = [
    "OTHER_LANGUAGE", "LISTING_FORMAT", "CARD_TYPE", "ABOVE_MAX_PRICE", "BELOW_MIN_PRICE", "ALREADY_SEEN", "OUTSIDE_GRADING_WATCH",
    "OUTSIDE_AUCTION_WINDOW", "NO_IMAGES", "UNAVAILABLE", "JUNK", "UNSUPPORTED_TEXTURE", "INVALID_PRICE",
    "PRICE_ABOVE_CEILING", "PRICING_CONFIG", "PRICING_CREDITS", "SCREEN_DROPPED", "SOLD_EVIDENCE_MISSING",
    "SOLD_EVIDENCE_DEFERRED", "RAW_PRICE_PREMIUM", "CRITERIA_MISMATCH", "NO_ANALYSIS_CANDIDATE", "EXACT_MARKET_UNCONFIRMED",
    "BUYER_BUY", "BUYER_WAIT", "BUYER_SKIP", "BUYER_CHECK_UNAVAILABLE",
    "DEAL_CONFIRMED", "NET_LOSS", "TARGETS_NOT_MET", "IDENTITY_UNRESOLVED", "SLAB_LABEL_UNRESOLVED",
    "MATERIAL_REVIEW", "PRICE_EVIDENCE_UNAVAILABLE", "PRICING_DEFERRED", "SHIPPING_UNCONFIRMED", "PHOTO_EVIDENCE_INCONSISTENT", "ASSESSMENT_FAILED", "FILTERS_CHANGED",
    "AI_EVIDENCE_HELD", "ANALYSIS_PAUSED", "AUTO_OFF", "AUTO_LIMIT", "NOT_ASSESSED", "AI_CREDITS", "AI_PAUSED", "AI_BUDGET", "AI_ACCOUNTING", "AI_INPUT_PREFLIGHT",
    "STORAGE_UNAVAILABLE", "PRICE_RESEARCH_BUDGET", "PRICE_RESEARCH_UNAVAILABLE",
    "EBAY_DAILY_BUDGET", "EBAY_BUDGET_ACCOUNTING", "EBAY_AUTH",
] as const;

export interface SearchDiagnosticRow {
    id: string;
    outcome: typeof SEARCH_DIAGNOSTIC_OUTCOMES[number];
    reason: typeof SEARCH_DIAGNOSTIC_REASONS[number];
    photoChecked?: boolean;
    priced?: boolean;
    profit?: number;
}

export interface ScreenedOverflowRow {
    id: string;
    reason: AutoAnalysisBlockReason | "DISPLAY_LIMIT";
}

export interface SearchDiagnosticOverflow {
    version: 1;
    stage: "SCREENING";
    rows: ScreenedOverflowRow[];
}

export const SOURCE_REJECTION_REASONS = [
    "VARIATION", "LOT", "DIGITAL", "PROXY_OR_REPLICA", "MYSTERY", "SEALED", "MERCHANDISE", "EMPTY_HOLDER",
    "OTHER_LANGUAGE", "UNAVAILABLE", "ALREADY_SEEN", "OUTSIDE_GRADING_WATCH", "ABOVE_SOLD_CEILING", "OUTSIDE_AUCTION_WINDOW", "PRICE_ABOVE_CEILING",
    "LISTING_FORMAT", "CARD_TYPE", "ABOVE_MAX_PRICE", "BELOW_MIN_PRICE", "OTHER_CARD", "OTHER_SET", "OTHER_PRINTING",
    "OTHER_GRADER", "OTHER_GRADE", "OTHER_FINISH", "JUNK", "SOLD_PRICE_EXCLUDED",
] as const;
export type SourceRejectionReason = typeof SOURCE_REJECTION_REASONS[number];
export type SourceDispositionRow = { id: string } & (
    { outcome: "REJECTED"; reason: SourceRejectionReason } |
    { outcome: "NOT_REACHED"; reason: "ENOUGH_CANDIDATES" }
);

export const BEST_BUY_TERMS_MAX_AGE_MS = 120_000;

export interface SearchCompetition {
    title: string;
    url: string;
    price: number;
    shipping: number;
    ceiling: number;
    identity: "PHOTO" | "LABEL" | "LISTING";
    pricing?: { resale: number; totalCost: number; profit: number; roi: number | null; sales: number };
    image?: string;
    seller?: Seller | null;
    checkedAt?: string;
    coverage?: { found: number; checked: number };
    concerns?: string[];
}

export interface SearchSourceCoverage {
    sourceCoverage?: "COMPLETE" | "PARTIAL";
    sourceDispositions?: SourceDispositionRow[];
    overflow?: SearchDiagnosticOverflow;
    competition?: SearchCompetition;
}

export interface SearchDiagnosticDiscovery extends SearchSourceCoverage {
    total: number;
    found: number;
    screened?: number;
    priceExcluded?: number;
    unresolvedOverflow?: number;
    skipped: number;
    deferred: number;
    previouslySeen?: number;
    soldPurchaseCeiling?: number;
    pricePass?: { status: "COMPLETE" | "UNAVAILABLE"; newListings: number; candidates: number };
    marketplaceOrder?: DiscoveryOrder;
    retainedIds: string[];
    reviewSelection?: SearchReviewSelection;
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
    status: "recorded" | "complete" | "skipped" | "unavailable";
    message?: string;
    review?: SearchDiagnosticReview;
    examples?: Record<string, string>;
    reviewBudget?: AiSearchBudget;
}
