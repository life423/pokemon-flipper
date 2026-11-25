import { cents } from "./cents.ts";
import { releaseIssue } from "../base-set-release.ts";
import { MONEY_CONFIG } from "./config.ts";
import { rateDeal } from "./rating.ts";
import { acquisitionCost } from "./underwriting.ts";
import { currentPriceEvidence } from "../pricing-freshness.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../search-diagnostic.ts";
import type { Evaluation, PricedPath, Targets } from "../types.ts";

export interface VerifiedPurchase {
    listingId: string;
    itemPrice: number;
    termsCheckedAt: string;
    pricesCheckedAt: string;
    shippingDestination?: string | null;
    targets: Targets;
    path: PricedPath;
    maxItemPrice: number;
}

export const PURCHASE_RECHECK_MESSAGE = "The verified price or purchase terms need a fresh check before buying.";

export function verifiedPurchase(evaluation: Evaluation, path: PricedPath, targets: Targets, maxItemPrice = path.maxBid): VerifiedPurchase | undefined {
    const { id, price, termsCheckedAt, buyingOption } = evaluation.listing;
    const { pricesCheckedAt } = evaluation;
    if (releaseIssue(evaluation) || evaluation.identity?.notThisCard || buyingOption !== "FIXED_PRICE" || price === null || !termsCheckedAt || !pricesCheckedAt ||
        !Number.isFinite(maxItemPrice) || maxItemPrice < price || maxItemPrice > path.maxBid) return;
    return { listingId: id, itemPrice: price, termsCheckedAt, pricesCheckedAt, shippingDestination: evaluation.listing.shippingDestination,
        targets, path, maxItemPrice };
}

// Bind the decision to the reviewed copy, terms, prices, targets and modeled route.
// Repricing may still show alternatives, but cannot reuse an earlier approval.
export function applyVerifiedPurchase(evaluation: Evaluation | null, purchase: VerifiedPurchase | undefined, targets: Targets, now: number): Evaluation | null {
    if (!evaluation || !purchase || !evaluation.underwriting?.verdict.startsWith("BUY") || evaluation.identity?.notThisCard || releaseIssue(evaluation)) return null;
    const { listing, underwriting } = evaluation;
    const age = now - Date.parse(purchase.termsCheckedAt);
    if (listing.id !== purchase.listingId || listing.buyingOption !== "FIXED_PRICE" || listing.availability !== "ACTIVE" ||
        Date.parse(listing.endTime ?? "") <= now || listing.price !== purchase.itemPrice || listing.termsCheckedAt !== purchase.termsCheckedAt ||
        (listing.shippingDestination ?? null) !== (purchase.shippingDestination ?? null) ||
        listing.shipping === null || underwriting.shippingUnconfirmed || !(age >= 0 && age < BEST_BUY_TERMS_MAX_AGE_MS) ||
        evaluation.pricesCheckedAt !== purchase.pricesCheckedAt || !currentPriceEvidence(evaluation, now) ||
        purchase.targets?.minProfit !== targets.minProfit || purchase.targets?.minRoi !== targets.minRoi) return null;
    const savedPath = JSON.stringify(purchase.path);
    const path = underwriting.paths.find((candidate): candidate is PricedPath => candidate.status === "PRICED" && JSON.stringify(candidate) === savedPath);
    if (!path?.clears || !(path.profit > 0) || !Number.isFinite(purchase.maxItemPrice) || purchase.maxItemPrice > path.maxBid ||
        purchase.maxItemPrice < purchase.itemPrice || path.shipping !== listing.shipping) return null;

    const cap = purchase.maxItemPrice;
    const cost = cents(acquisitionCost(cap, path.shipping, MONEY_CONFIG.buying)) + cents(path.fixedCosts);
    const profit = cents(path.expectedNet) - cost;
    const best: PricedPath = { ...path, maxBid: cap, costAtMaxBid: cost / 100, profitAtMaxBid: profit / 100,
        roiAtMaxBid: cost > 0 ? profit / cost : null,
        downsideAtMaxBid: path.downside === null ? null : (cents(path.downside) + cents(path.cost) - cost) / 100 };
    const reviewed: Evaluation = { ...evaluation, underwriting: { ...underwriting, best,
        verdict: best.path === "RAW" ? "BUY_RAW" : best.path === "GRADE" ? "BUY_AND_GRADE" : "BUY_GRADED",
        paths: underwriting.paths.map(candidate => candidate === path ? best : candidate) } };
    return { ...reviewed, rating: rateDeal(reviewed) };
}
