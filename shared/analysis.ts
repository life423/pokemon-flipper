import type { Evaluation, ListingSummary } from "./types.ts";
import { offerFor, offerWorthMaking } from "./money/offer.ts";
import { canRetryPricing } from "./pricing-retries.ts";

// Automatic analysis and its progress counts use the same eligibility rule.
export function canAutoAnalyze(listing: ListingSummary): boolean {
    if (!listing.images.length || listing.availability === "UNAVAILABLE" || listing.screen?.junk ||
        listing.currentPrice === null || !Number.isFinite(listing.currentPrice) || listing.currentPrice < 0 ||
        ["CONFIG", "CREDITS"].includes(listing.screen?.pricingIssue?.kind ?? "")) return false;
    const temporaryPrice = ["TEMPORARY", "RATE_LIMIT"].includes(listing.screen?.pricingIssue?.kind ?? "");
    const resolvable = Boolean(listing.screen?.status === "UNSCREENED" && (listing.screen.needsAnalysis || temporaryPrice));
    const unusualPrice = Boolean(listing.screen?.priceAnomaly && listing.screen.status === "UNSCREENED");
    // Seller condition and preliminary resale quotes rank work; they must not
    // veto a photo assessment. The final underwriting still decides profit.
    const preliminaryRejection = listing.screen?.status === "DROPPED" && Boolean(listing.screen.money);
    return (!listing.match || listing.match === "UNCONFIRMED_CRITERIA" && resolvable) &&
        (listing.screen?.status === "CANDIDATE" || preliminaryRejection || Boolean(listing.mistakes?.length) || resolvable || unusualPrice);
}

export type ResultGroup = "deals" | "offers" | "candidates" | "longShots" | "review";

export function resultGroup(listing: ListingSummary, evaluation: Evaluation | null, includeOffers = false, analysisFailed = false): ResultGroup | null {
    const verdict = evaluation?.underwriting?.verdict;
    if (verdict?.startsWith("BUY")) return evaluation?.rating?.level === "LONG_SHOT" ? "longShots" : "deals";
    if (includeOffers && verdict === "PASS" && offerWorthMaking(offerFor(listing, evaluation?.underwriting?.best?.maxBid))) return "offers";
    if (verdict === "NEEDS_REVIEW" || verdict === "CANT_PRICE") return "review";
    // An incomplete check is unresolved, never a priced rejection or a queued analysis.
    if (!evaluation && analysisFailed) return "review";
    if (!evaluation && canRetryPricing(listing)) return "candidates";
    if (!evaluation && canAutoAnalyze(listing)) return "candidates";
    if (!evaluation && listing.screen?.status === "UNSCREENED") return "review";
    if (!evaluation && listing.screen?.priceAnomaly && !listing.screen.priceAnomaly.photoChecked) return "review";
    if (!evaluation && listing.mistakes?.length && listing.screen?.status !== "CANDIDATE") return "review";
    if (!evaluation && listing.screen?.status === "CANDIDATE") return listing.screen.longShot ? "longShots" : "candidates";
    return null;
}

// Grow with eligible work, not irrelevant search results. Recent failures
// reduce pressure; successful analyses gradually clear that feedback.
export function analysisConcurrency(work: number, recentOutcomes: readonly boolean[] = []): number {
    const demand = Math.min(8, Math.max(1, Math.ceil(Math.sqrt(Math.max(0, work)))));
    const failures = recentOutcomes.filter((succeeded) => !succeeded).length;
    return Math.max(1, Math.floor(demand / (1 + failures)));
}

export function meetsMinimumGrade(evaluation: Evaluation, minimum: number): boolean {
    if (minimum <= 0) return true;
    if (evaluation.slab) return evaluation.slab.status === "OK" && Number(evaluation.slab.grade) >= minimum;
    const range = evaluation.condition?.gradeRange;
    return Boolean(range && range.high >= minimum);
}
