import type { Evaluation, ListingSummary, Targets } from "./types.ts";
import type { ListingFilters } from "./listing-filters.ts";
import type { VerifiedPurchase } from "./money/verified-purchase.ts";

export const dealHuntGoals = {
    grade_raw: "Find a raw card worth grading",
    collect_slab: "Find a fairly priced slab for my collection",
    resell: "Find a card to resell for a profit",
} as const;

export type DealHuntGoal = keyof typeof dealHuntGoals;
export const DEAL_HUNT_LISTING_LIMIT = 200;
export const HUNT_RECHECK_MS = 15 * 60_000;
export const MIN_FLIP_BIN_ASK = 50;
export type DealHuntScope = "search" | "same_set" | "any_card";
export type DealHuntAction = "move_on" | "check_listing" | "inspect_photos" | "resolve_printing" | "check_sales" | "check_price_references" | "check_price_tracker" | "verify_sold_listing" | "search_web_sales" | "check_price_history" | "compare_cardmarket" | "calculate_grading" | "check_raw_resale";
export type DealHuntSection = "grading" | "sales" | "photos";
export interface HuntMarketPreferences {
    sets?: string[];
    seed?: { name: string | null; number: string | null; expand: boolean };
    printing?: "FIRST_EDITION" | "SHADOWLESS" | "UNLIMITED";
    grader?: "PSA" | "CGC" | "BGS" | "SGC" | "TAG";
    minGrade?: number;
    maxGrade?: number;
    minYear?: number;
    maxYear?: number;
    finish?: "HOLO" | "REVERSE_HOLO" | "NON_HOLO";
    preferRecentSales?: boolean;
    minimumCondition?: "NEAR_MINT";
}
export interface DealHuntRequest {
    goal: DealHuntGoal;
    listingIds: string[];
    /** Continued batches that own some of the selected rows. */
    batchIds?: string[];
    targets: Targets;
    scope?: DealHuntScope;
    standalone?: boolean;
    watch?: true;
    /** Discover current fixed-price resale candidates from the newest marketplace inventory. */
    freshListings?: true;
    filters?: ListingFilters;
    minPotentialGrade?: number;
    marketPreferences?: HuntMarketPreferences;
}
export interface DealHuntReport {
    searchId: string;
    goal: DealHuntGoal;
    decision: "BUY" | "BID" | "WAIT";
    reason: string;
    marketNote?: string;
    providerStop?: "daily_ebay" | "account";
    /** The search needs an accounting or spending issue resolved before another pass. */
    needsAttention?: true;
    waitingForQuota?: true;
    destination: { listingId: string; section: DealHuntSection } | null;
    verifiedPurchase?: VerifiedPurchase;
    priceGap?: { allIn: number; maxItemPrice: number; drop: number };
    steps: {
        listingId: string | null;
        title: string;
        action: DealHuntAction | "find_listings";
        reason: string;
        observation: string;
        /** Older saved reports may omit who selected this step. */
        selectedBy?: "model" | "app";
        /** First (one-based) step in a pair chosen and dispatched together. */
        parallelGroup?: number;
        /** Whether the planner reused a saved choice. Null for a required action. */
        reused: boolean | null;
    }[];
}
export interface DealHuntResponse {
    nextCheckAt?: number;
    waitingFor?: "inventory" | "provider";
    waitingForQuota?: true;
    gradingOpportunity?: import("./grading-watch.ts").GradingOpportunity;
    auctionOpportunity?: import("./auction-opportunity.ts").AuctionOpportunity;
    collectorAuction?: import("./collector-auction.ts").CollectorAuction;
    report: DealHuntReport;
    evaluation: Evaluation | null;
    alternative?: { listing: ListingSummary; reason: string };
    /** Other eligible eBay copies discovered in a standalone hunt, without a purchase recommendation. */
    candidates?: ListingSummary[];
    candidatePrices?: Record<string, import("./listing-market-prices.ts").ListingMarketPrices>;
}
