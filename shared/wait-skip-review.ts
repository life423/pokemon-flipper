import { CONDITION_NAMES, isRawCondition } from "./conditions.ts";
import { dollars } from "./format.ts";
import { isPrinting, printingClaimFromAspects, printingClaimFromText, printingName } from "./identity.ts";
import { isRawSoldPrice } from "./money/price-evidence.ts";
import { currentPriceEvidence } from "./pricing-freshness.ts";
import type { VerifiedPurchase } from "./money/verified-purchase.ts";
import type { SearchDiagnosticRow } from "./search-diagnostic.ts";
import { autoAnalysisBlockReason, type AutoAnalysisBlockReason } from "./analysis.ts";
import type { Evaluation, ListingSummary } from "./types.ts";

export const BUYER_REVIEW_FAILURE_CODES = ["PROVIDER_TEMPORARY", "AI_CREDITS", "AI_PAUSED", "AI_BUDGET", "AI_ACCOUNTING", "AI_INPUT_PREFLIGHT", "AI_EVIDENCE_HELD",
    "EBAY_DAILY_BUDGET", "EBAY_BUDGET_ACCOUNTING", "EBAY_AUTH",
    "PRICE_RESEARCH_BUDGET", "PRICE_RESEARCH_UNAVAILABLE", "STORAGE_UNAVAILABLE", "PRICING_CONFIG", "PRICING_CREDITS", "REVIEW_UNAVAILABLE"] as const;
export interface BuyerReviewFailure {
    code: typeof BUYER_REVIEW_FAILURE_CODES[number];
    retryable: boolean;
    scope?: "listing" | "search";
}
export const BUYER_REVIEW_MAX_ATTEMPTS = 3;
export const BUYER_REVIEW_MIN_RETRY_MS = 1500;
const BUYER_WAIT_REASONS = ["SHIPPING_UNCONFIRMED", "IDENTITY_UNRESOLVED", "SLAB_LABEL_UNRESOLVED", "MATERIAL_REVIEW",
    "PRICE_EVIDENCE_UNAVAILABLE", "PRICING_DEFERRED", "PHOTO_EVIDENCE_INCONSISTENT", "NO_IMAGES", "OUTSIDE_AUCTION_WINDOW",
    "INVALID_PRICE", "PRICE_ABOVE_CEILING"] as const satisfies readonly SearchDiagnosticRow["reason"][];
export type BuyerWaitReason = typeof BUYER_WAIT_REASONS[number];
export function isBuyerWaitReason(value: unknown): value is BuyerWaitReason {
    return BUYER_WAIT_REASONS.some(reason => reason === value);
}

export function isBuyerReviewFailure(value: unknown): value is BuyerReviewFailure {
    const failure = value as BuyerReviewFailure | null;
    return !!failure && BUYER_REVIEW_FAILURE_CODES.includes(failure.code) && typeof failure.retryable === "boolean" &&
        (failure.scope === undefined || failure.scope === "listing" || failure.scope === "search") &&
        (!failure.retryable || failure.code === "PROVIDER_TEMPORARY");
}

// Only a confirmed temporary provider/connection interruption can reopen an
// unchanged copy automatically. Budget, held-charge and identity facts cannot.
export function buyerReviewFailure(code: string | undefined, retryable: boolean, scope?: BuyerReviewFailure["scope"]): BuyerReviewFailure {
    const known = BUYER_REVIEW_FAILURE_CODES.find(value => value === code);
    const failure: BuyerReviewFailure = known && known !== "PROVIDER_TEMPORARY" ? { code: known, retryable: false }
        : { code: retryable ? "PROVIDER_TEMPORARY" : known ?? "REVIEW_UNAVAILABLE", retryable };
    return scope ? { ...failure, scope } : failure;
}

// These are app-generated historical quota decisions, not card evidence.
// Current request policy no longer enforces those per-search ceilings.
export function isRetiredRequestLimit(failure: BuyerReviewFailure | undefined, reason: string): boolean {
    return failure?.code === "PRICE_RESEARCH_BUDGET" || failure?.code === "REVIEW_UNAVAILABLE" &&
        /^This search has reached its \d+-request eBay Browse cap\./.test(reason);
}

export function isEbayResearchHold(failure: BuyerReviewFailure | undefined): boolean {
    return failure?.code === "EBAY_DAILY_BUDGET" || failure?.code === "EBAY_BUDGET_ACCOUNTING" || failure?.code === "EBAY_AUTH";
}

export function isLegacyAiAccountingFailure(code: string | undefined | null, reason: string): boolean {
    return code === "AI_BUDGET" &&
        reason === "Paid AI could not durably update its spending ledger. No new work is authorized. Cached results and screened candidates remain available.";
}

export function isAiAuthorityHold(failure: BuyerReviewFailure | undefined): boolean {
    return failure?.scope !== "listing" && (failure?.code === "AI_ACCOUNTING" || failure?.code === "AI_INPUT_PREFLIGHT");
}

export function buyerReviewRetryAt(failure: BuyerReviewFailure | undefined, retryAt: number | undefined, attempts: number, now: number): number | undefined {
    if (failure?.code !== "PROVIDER_TEMPORARY" || !failure.retryable || !Number.isInteger(attempts) || attempts < 1 || attempts >= BUYER_REVIEW_MAX_ATTEMPTS ||
        !Number.isSafeInteger(retryAt) || retryAt! < 0) return undefined;
    return Math.max(retryAt!, now + BUYER_REVIEW_MIN_RETRY_MS * attempts);
}

/** A completed per-copy decision under the buyer's current search and targets. */
export interface BuyerListingReview {
    listingId: string;
    decision: "BUY" | "WAIT" | "SKIP";
    reason: string;
    waitReason?: BuyerWaitReason;
    evidence: "saved" | "photos" | "prices" | "listing";
    evaluation: Evaluation | null;
    verifiedPurchase?: VerifiedPurchase;
    auctionOpportunity?: import("./auction-opportunity.ts").AuctionOpportunity;
    gradingOpportunity?: import("./grading-watch.ts").GradingOpportunity;
    offer?: { opening: number; maxItemPrice: number; verifiedPurchase: VerifiedPurchase };
    unavailable?: true;
    failure?: BuyerReviewFailure;
    /** Absolute server cooldown; does not create a new search or spending allowance. */
    retryAt?: number;
}


// A missing sold screen can be repaired by establishing the printing and condition
// first. Hard listing exclusions and a supported exact-slab rejection still stand.
export function buyerReviewBlock(listing: ListingSummary, now = Date.now()): AutoAnalysisBlockReason | null {
    if (listing.match && listing.match !== "UNCONFIRMED_CRITERIA") return "CRITERIA_MISMATCH";
    const block = autoAnalysisBlockReason(listing, now);
    switch (block) {
        case "SOLD_EVIDENCE_MISSING": case "SOLD_EVIDENCE_DEFERRED": case "RAW_PRICE_PREMIUM":
        case "NO_ANALYSIS_CANDIDATE": case "CRITERIA_MISMATCH": return null;
        case "SCREEN_DROPPED":
            return listing.isGraded && listing.screen?.soldEvidence?.exactScope && listing.screen.soldEvidence.status === "AVAILABLE" &&
                listing.screen.bestCase && listing.screen.bestCase.profit <= 0 && !listing.screen.requiresOffer ? block : null;
        default: return block;
    }
}

export function unconfirmedResale(e: Evaluation, now = Date.now()) {
    const id = e.identity, wear = e.condition?.rawCondition;
    const claims = [printingClaimFromText(e.listing.title), printingClaimFromAspects(e.listing.aspects ?? {})];
    const editions = [...new Set(claims.filter(isPrinting))];
    const conflicting = editions.length > 1 || claims.includes("CONFLICTING");
    const edition = !conflicting && editions.length === 1 ? editions[0] : undefined;
    const seller = conflicting ? "The seller gives conflicting editions." : edition ? `The seller lists ${printingName(edition)}.` : e.photoCheck ? "The photos did not settle the edition." : "The edition is unverified.";
    const condition = isRawCondition(wear) ? ` The photos place this copy at ${CONDITION_NAMES[wear]}.` : "";
    const market = e.rawPricing;
    const matched = market?.prices?.find(p => p.condition === wear && isRawSoldPrice(p) && (p.comps?.count ?? 0) > 0);
    if (id?.set && id.cardNumber && matched && currentPriceEvidence(e, now) && isPrinting(market?.printing)) {
        return `${seller}${condition} The ${printingName(market.printing)} resale comparison is ${dollars(matched.price)} before fees. The listing evidence does not establish that this copy would sell in that market.`;
    }
    if (!id?.set || !id.cardNumber) return `${condition.trim()} A matching sale needs the same set and collector number. The listing evidence does not establish ${id?.set ? "the collector number" : "the set"} for this copy.`.trim();
    return `${seller}${condition} The comparisons do not establish a resale value after fees for this copy${edition ? ` as ${printingName(edition)}` : " in a verified edition"}.`;
}
