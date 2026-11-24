import type { Evaluation, ListingSummary, Targets } from "./types.ts";
import type { ListingFilters } from "./listing-filters.ts";

export const dealHuntGoals = {
    grade_raw: "Find a raw card worth grading",
    collect_slab: "Find a fairly priced slab for my collection",
    resell: "Find a card to resell for a profit",
} as const;

export type DealHuntGoal = keyof typeof dealHuntGoals;
export type DealHuntScope = "search" | "same_set" | "any_card";
export type DealHuntAction = "check_listing" | "inspect_photos" | "check_sales" | "calculate_grading";
export type DealHuntSection = "grading" | "sales" | "photos";
export interface HuntMarketPreferences {
    minYear?: number;
    maxYear?: number;
    finish?: "HOLO" | "REVERSE_HOLO" | "NON_HOLO";
}
export interface DealHuntRequest {
    goal: DealHuntGoal;
    listingIds: string[];
    targets: Targets;
    scope?: DealHuntScope;
    standalone?: boolean;
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
    destination: { listingId: string; section: DealHuntSection } | null;
    steps: {
        listingId: string | null;
        title: string;
        action: DealHuntAction | "find_listings";
        reason: string;
        observation: string;
        /** Whether the planner reused a saved choice. Null for a required action. */
        reused: boolean | null;
    }[];
}
export interface DealHuntResponse {
    auctionOpportunity?: import("./auction-opportunity.ts").AuctionOpportunity;
    report: DealHuntReport;
    evaluation: Evaluation | null;
    alternative?: { listing: ListingSummary; reason: string };
}
