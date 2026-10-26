import type { ListingSummary } from "./types.ts";

// Automatic analysis and its progress counts use the same eligibility rule.
export function canAutoAnalyze(listing: ListingSummary): boolean {
    return !listing.match && listing.screen?.status === "CANDIDATE" && !listing.screen.longShot;
}
