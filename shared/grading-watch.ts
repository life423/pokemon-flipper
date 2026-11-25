import { availablePhotoCount } from "./analysis-priority.ts";
import { sellerConditionClues } from "./raw-condition-claim.ts";
import { usableGradingLead } from "./sold-evidence.ts";
import type { Grader, ListingSummary } from "./types.ts";
import type { VerifiedPurchase } from "./money/verified-purchase.ts";

export const GRADING_WATCH_FRESH_MS = 24 * 60 * 60_000;
export const GRADING_WATCH_INTERVAL_MS = 10 * 60_000;
export const GRADING_WATCH_DURATION_MS = 30 * 60_000;

export interface GradingOpportunity {
    grader: Grader;
    listingDate: string;
    dateSource: "listed" | "created";
    validUntil: number;
    delivered: number;
    gradingCosts: number;
    verifiedPurchase?: VerifiedPurchase;
    likely: { grade: number; profit: number; sales30: number; sales60?: number };
    lower: { grade: number; profit: number; sales30: number; sales60?: number };
}

export function freshListingTime(listing: Pick<ListingSummary, "listedAt" | "createdAt">, now: number): number | null {
    const time = Date.parse(listing.listedAt ?? listing.createdAt ?? "");
    return time <= now && now - time < GRADING_WATCH_FRESH_MS ? time : null;
}

// A screening quote can justify inspecting photos. Only a completed assessment
// with matching transactions can produce a buyer alert.
export function freshGradingLeadTime(listing: ListingSummary, now: number): number | null {
    if (listing.buyingOption !== "FIXED_PRICE" || listing.isGraded || listing.match || listing.screen?.status === "DROPPED" ||
        !usableGradingLead(listing) || availablePhotoCount(listing.images) < 2) return null;
    const condition = sellerConditionClues(listing);
    if (condition.severe || condition.conflict || condition.claim === "MODERATELY_PLAYED") return null;
    return freshListingTime(listing, now);
}
