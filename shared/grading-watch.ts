import type { Grader, ListingSummary } from "./types.ts";

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
    likely: { grade: number; profit: number; sales30: number };
    lower: { grade: number; profit: number; sales30: number };
}

export function freshListingTime(listing: Pick<ListingSummary, "listedAt" | "createdAt">, now: number): number | null {
    const time = Date.parse(listing.listedAt ?? listing.createdAt ?? "");
    return time <= now && now - time < GRADING_WATCH_FRESH_MS ? time : null;
}

// A screening quote can justify inspecting photos. Only a completed assessment
// with matching transactions can produce a buyer alert.
export function freshGradingLead(listing: ListingSummary, now: number): boolean {
    return listing.buyingOption === "FIXED_PRICE" && !listing.isGraded && !listing.match &&
        listing.screen?.status !== "DROPPED" && !!listing.screen?.gradingLead &&
        listing.images.length >= 2 && freshListingTime(listing, now) !== null;
}
