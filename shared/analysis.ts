import type { Evaluation, ListingSummary } from "./types.ts";
import { offerFor, offerWorthMaking } from "./money/offer.ts";
import { canRetryPricing } from "./pricing-retries.ts";
import { AI_CONCURRENCY } from "./work-limits.ts";
import { AUTOMATIC_PRICE_CEILING, withinAutomaticAuctionWindow } from "./listing-filters.ts";
import { photoReviewStatus } from "./photo-review.ts";
import { hasSlabEvidence, obscuredDisclosedWear, observedCardKind } from "./photo-evidence.ts";
import { priceEvidenceGap } from "./money/price-evidence.ts";
import { unquotedBuyItNowShipping } from "./money/underwriting.ts";
import { missingTextureReason } from "./grade-qualifier.ts";
import { usableGradingLead } from "./sold-evidence.ts";
import { deferRawPremiumPhotos } from "./raw-market-context.ts";

export type AutoAnalysisBlockReason =
    | "OUTSIDE_AUCTION_WINDOW"
    | "NO_IMAGES"
    | "UNAVAILABLE"
    | "JUNK"
    | "UNSUPPORTED_TEXTURE"
    | "INVALID_PRICE"
    | "PRICE_ABOVE_CEILING"
    | "PRICING_CONFIG"
    | "PRICING_CREDITS"
    | "SCREEN_DROPPED"
    | "SOLD_EVIDENCE_MISSING"
    | "SOLD_EVIDENCE_DEFERRED"
    | "RAW_PRICE_PREMIUM"
    | "CRITERIA_MISMATCH"
    | "NO_ANALYSIS_CANDIDATE";

// Report the first gate that blocks the same automatic work the queue admits.
export function autoAnalysisBlockReason(listing: ListingSummary, now = Date.now()): AutoAnalysisBlockReason | null {
    if (!withinAutomaticAuctionWindow(listing, now)) return "OUTSIDE_AUCTION_WINDOW";
    if (!listing.images.length) return "NO_IMAGES";
    if (listing.availability === "UNAVAILABLE") return "UNAVAILABLE";
    if (listing.screen?.junk) return "JUNK";
    if (missingTextureReason(listing.title)) return "UNSUPPORTED_TEXTURE";
    if (listing.currentPrice === null || !Number.isFinite(listing.currentPrice) || listing.currentPrice < 0) return "INVALID_PRICE";
    if (listing.currentPrice > AUTOMATIC_PRICE_CEILING) return "PRICE_ABOVE_CEILING";

    const screen = listing.screen;
    const pricingIssue = screen?.pricingIssue?.kind;
    if (pricingIssue === "CONFIG") return "PRICING_CONFIG";
    if (pricingIssue === "CREDITS") return "PRICING_CREDITS";
    if (screen?.soldEvidence) {
        // The bounded workflow requires sold screening or a supported exception.
        if (screen.status === "DROPPED") return "SCREEN_DROPPED";
        if (screen.soldEvidence.status !== "AVAILABLE" && !usableGradingLead(listing) && screen.focusedReview !== "CHEAP_FIRST_EDITION_BASE_SET") {
            return screen.soldEvidence.status === "DEFERRED" ? "SOLD_EVIDENCE_DEFERRED" : "SOLD_EVIDENCE_MISSING";
        }
        if (deferRawPremiumPhotos(listing, now)) return "RAW_PRICE_PREMIUM";
    }

    const temporaryPrice = pricingIssue === "TEMPORARY" || pricingIssue === "RATE_LIMIT";
    const resolvable = screen?.status === "UNSCREENED" && (screen.needsAnalysis || temporaryPrice);
    const unusualPrice = screen?.status === "UNSCREENED" && screen.priceAnomaly;
    if (listing.match && (listing.match !== "UNCONFIRMED_CRITERIA" || !resolvable)) return "CRITERIA_MISMATCH";
    // Older screens can still reopen when there is explicit discovery evidence.
    if (screen?.status === "CANDIDATE" || listing.mistakes?.length || resolvable || unusualPrice) return null;
    return screen?.status === "DROPPED" ? "SCREEN_DROPPED" : "NO_ANALYSIS_CANDIDATE";
}

export function canAutoAnalyze(listing: ListingSummary): boolean {
    return autoAnalysisBlockReason(listing) === null;
}

export type ResultGroup = "deals" | "offers" | "candidates" | "review";

export function resultGroup(listing: ListingSummary, evaluation: Evaluation | null, includeOffers = false, analysisFailed = false): ResultGroup | null {
    const verdict = evaluation?.underwriting?.verdict;
    const availability = evaluation?.listing?.availability ?? listing.availability;
    if (verdict === "PASS" && evaluation && obscuredDisclosedWear(evaluation)) return null;
    if ((evaluation?.frontPhotoStop === "SLAB_PRICE" || evaluation?.frontPhotoStop === "RAW_PRICE") && verdict === "CANT_PRICE") {
        return photoReviewStatus(evaluation).needsYourReview ? "review" : "candidates";
    }
    if (evaluation && evaluation.listing?.availability !== "UNAVAILABLE" && priceEvidenceGap(evaluation)) {
        return photoReviewStatus(evaluation).needsYourReview ? "review" : "candidates";
    }
    if (evaluation && availability !== "UNKNOWN" && availability !== "UNAVAILABLE" &&
        (evaluation.underwriting?.shippingUnconfirmed || verdict?.startsWith("BUY") && unquotedBuyItNowShipping(evaluation.listing ?? listing))) {
        return photoReviewStatus(evaluation).needsYourReview ? "review" : "candidates";
    }
    if (evaluation?.pricingDeferred && evaluation.listing.availability !== "UNAVAILABLE" && !verdict?.startsWith("BUY")) {
        const check = evaluation.photoCheck, card = check?.cardIdentity;
        const materialReview = evaluation.identity?.notThisCard ||
            evaluation.identity?.status === "NEEDS_REVIEW" && !evaluation.pricingDeferred.identityLookupPending ||
            evaluation.slab?.status === "NEEDS_REVIEW" ||
            !check || !observedCardKind(evaluation) ||
            !card?.name || !card.set || !card.cardNumber || card.confidence === "LOW" ||
            check.cardMatch?.verdict === "MISMATCH" && evaluation.identity?.status !== "IDENTIFIED" ||
            !evaluation.slab && evaluation.condition?.creases === "SUSPECTED" && verdict === "NEEDS_REVIEW" ||
            !evaluation.slab && (!evaluation.condition || evaluation.condition.rawCondition === "UNKNOWN" || evaluation.condition.authenticity.concern !== "NONE_SEEN") ||
            evaluation.deeperPhotoReview?.findings.some(finding => finding.impact === "NEW_CONCERN");
        return materialReview ? "review" : "candidates";
    }
    // A priced rejection is finished work. Keep its paid evidence in All
    // matching, but do not turn old screen/photo notes back into a queue item.
    // The only actionable alternative is an explicitly enabled, realistic offer.
    if (verdict === "PASS") {
        const unresolvedRisk = evaluation?.identity?.status === "NEEDS_REVIEW" || evaluation?.slab?.status === "NEEDS_REVIEW" ||
            evaluation?.condition?.authenticity.concern === "POSSIBLE" ||
            evaluation?.deeperPhotoReview?.findings.some((finding) => finding.impact === "NEW_CONCERN");
        if (unresolvedRisk) return "review";
        const offer = availability !== "UNKNOWN" && evaluation?.researchMode !== "DEFERRED_LOW_RESALE" &&
            evaluation?.condition?.creases !== "SUSPECTED" && includeOffers && offerWorthMaking(offerFor(listing, evaluation?.underwriting?.best?.maxBid));
        if (!offer) return null;
        return unquotedBuyItNowShipping(evaluation?.listing ?? listing) ? "candidates" : "offers";
    }
    if (evaluation?.researchMode === "DEFERRED_LOW_RESALE") return photoReviewStatus(evaluation).needsYourReview ? "review" : null;
    if (verdict?.startsWith("BUY")) return availability === "UNKNOWN" ? "review" : "deals";
    if (verdict === "NEEDS_REVIEW" || verdict === "CANT_PRICE") return "review";
    if (evaluation && !verdict) return "review";
    // An incomplete check is unresolved, never a priced rejection or a queued analysis.
    if (!evaluation && analysisFailed) return "review";
    if (!evaluation && listing.screen?.soldEvidence) {
        if (listing.screen.status === "DROPPED") return null;
        // Missing market data is unfinished sorting work, not a request for
        // the user to identify the card or authorize automatic paid photos.
        if (listing.screen.soldEvidence.status !== "AVAILABLE" || deferRawPremiumPhotos(listing, Date.now())) return "candidates";
    }
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
    if (hasSlabEvidence(evaluation)) return false;
    const range = evaluation.condition?.gradeRange;
    return Boolean(range && range.high >= minimum);
}
