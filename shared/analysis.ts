import type { Evaluation, ListingSummary } from "./types.ts";
import { offerFor, offerWorthMaking } from "./money/offer.ts";
import { canRetryPricing } from "./pricing-retries.ts";
import { AI_CONCURRENCY } from "./work-limits.ts";
import { AUTOMATIC_PRICE_CEILING, withinAutomaticAuctionWindow } from "./listing-filters.ts";
import { photoReviewStatus } from "./photo-review.ts";

// Automatic analysis and its progress counts use the same eligibility rule.
export function canAutoAnalyze(listing: ListingSummary): boolean {
    if (!withinAutomaticAuctionWindow(listing) || !listing.images.length || listing.availability === "UNAVAILABLE" || listing.screen?.junk ||
        listing.currentPrice === null || !Number.isFinite(listing.currentPrice) || listing.currentPrice < 0 || listing.currentPrice > AUTOMATIC_PRICE_CEILING ||
        ["CONFIG", "CREDITS"].includes(listing.screen?.pricingIssue?.kind ?? "")) return false;
    if (listing.screen?.lowResale && !listing.screen.lowResale.cheapFirstEditionBaseSet) return false;
    const temporaryPrice = ["TEMPORARY", "RATE_LIMIT"].includes(listing.screen?.pricingIssue?.kind ?? "");
    const resolvable = Boolean(listing.screen?.status === "UNSCREENED" && (listing.screen.needsAnalysis || temporaryPrice));
    const unusualPrice = Boolean(listing.screen?.priceAnomaly && listing.screen.status === "UNSCREENED");
    // Price-first screening narrows automatic paid work. Explicit discovery
    // evidence can reopen a listing; manual analysis remains available.
    return (!listing.match || listing.match === "UNCONFIRMED_CRITERIA" && resolvable) &&
        (listing.screen?.status === "CANDIDATE" || Boolean(listing.mistakes?.length) || resolvable || unusualPrice);
}

export type ResultGroup = "deals" | "offers" | "candidates" | "review";

export function resultGroup(listing: ListingSummary, evaluation: Evaluation | null, includeOffers = false, analysisFailed = false): ResultGroup | null {
    if (evaluation?.researchMode === "DEFERRED_LOW_RESALE") return photoReviewStatus(evaluation).needsYourReview ? "review" : null;
    const verdict = evaluation?.underwriting?.verdict;
    if (verdict?.startsWith("BUY")) return "deals";
    if (includeOffers && verdict === "PASS" && offerWorthMaking(offerFor(listing, evaluation?.underwriting?.best?.maxBid))) return "offers";
    if (verdict === "NEEDS_REVIEW" || verdict === "CANT_PRICE") return "review";
    // An incomplete check is unresolved, never a priced rejection or a queued analysis.
    if (!evaluation && analysisFailed) return "review";
    if (!evaluation && canRetryPricing(listing)) return "candidates";
    if (!evaluation && canAutoAnalyze(listing)) return "candidates";
    if (!evaluation && listing.screen?.status === "UNSCREENED") return "review";
    if (!evaluation && listing.screen?.priceAnomaly && !listing.screen.priceAnomaly.photoChecked) return "review";
    if (!evaluation && listing.mistakes?.length && listing.screen?.status !== "CANDIDATE") return "review";
    if (!evaluation && listing.screen?.status === "CANDIDATE") return "candidates";
    return null;
}

// Grow with eligible work, not irrelevant search results. Recent failures
// reduce pressure; successful analyses gradually clear that feedback.
export function analysisConcurrency(work: number, recentOutcomes: readonly boolean[] = []): number {
    const demand = Math.min(AI_CONCURRENCY, Math.max(1, Math.ceil(work)));
    const failures = recentOutcomes.filter((succeeded) => !succeeded).length;
    return Math.max(1, Math.floor(demand / (1 + failures)));
}

export function meetsMinimumGrade(evaluation: Evaluation, minimum: number): boolean {
    if (minimum <= 0) return true;
    if (evaluation.slab) return evaluation.slab.status === "OK" && Number(evaluation.slab.grade) >= minimum;
    const range = evaluation.condition?.gradeRange;
    return Boolean(range && range.high >= minimum);
}
