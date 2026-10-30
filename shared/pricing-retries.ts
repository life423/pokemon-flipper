import type { ListingSummary, Screen } from "./types.ts";
import { listingEvidenceKey } from "./listing-evidence.ts";

export const PRICING_RETRY_LIMIT = 5;
export interface PricingIssue {
    kind: "RATE_LIMIT" | "TEMPORARY" | "CREDITS" | "CONFIG";
    retryAt: string | null;
}
export interface PricingRetry {
    ticket: string;
    snapshotKey: string;
    retryAt: string;
    attemptsLeft: number;
    expiresAt?: string;
}
export interface PricingRecoveryProgress {
    status: "checking" | "done";
    total: number;
    pending: number;
    checked: number;
    priced: number;
    retryAt: string | null;
    note?: string;
}
export interface PricingRetryResult {
    results: { id: string; snapshotKey: string; screen: Screen; match?: ListingSummary["match"] }[];
    note: string | null;
}
export function pricingSnapshotKey(listing: ListingSummary): string {
    return JSON.stringify([listing.id, listingEvidenceKey(listing), listing.isGraded, listing.listedAttributes ?? null, listing.currentPrice, listing.shipping, listing.bids, listing.endTime]);
}
export function canRetryPricing(listing: ListingSummary, now = Date.now()): boolean {
    const retry = listing.screen?.pricingRetry;
    return !listing.match && listing.availability !== "UNAVAILABLE" && (!listing.endTime || Date.parse(listing.endTime) > now) && listing.screen?.status === "UNSCREENED" &&
        Boolean(retry && retry.attemptsLeft > 0 && (!retry.expiresAt || Date.parse(retry.expiresAt) > now) && retry.snapshotKey === pricingSnapshotKey(listing)) &&
        ["RATE_LIMIT", "TEMPORARY"].includes(listing.screen?.pricingIssue?.kind ?? "");
}
export function applyPricingRetry(listing: ListingSummary, result: PricingRetryResult["results"][number]): ListingSummary {
    if (listing.id !== result.id || pricingSnapshotKey(listing) !== result.snapshotKey) return listing;
    return { ...listing, screen: result.screen, match: result.match };
}
