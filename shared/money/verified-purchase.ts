import { relistEstimate, type ComparableAsk, type RelistModel, type SaleStatistic } from "./relist-estimate.ts";
import { cents, meetsMoneyTargets } from "./cents.ts";
import { releaseIssue } from "../base-set-release.ts";
import { MONEY_CONFIG } from "./config.ts";
import { rateDeal } from "./rating.ts";
import { acquisitionCost, affordableItemLimit, maxBid, netFromSale } from "./underwriting.ts";
import { currentPriceEvidence } from "../pricing-freshness.ts";
import { currentQuote } from "../fresh-listing.ts";
import type { Evaluation, PricedPath, Targets } from "../types.ts";

export interface VerifiedPurchase {
    relist?: { model?: RelistModel; statistic?: SaleStatistic; competitor?: ComparableAsk | null; price: number; profit: number; lowestOtherDelivered: number | null };
    listingId: string;
    itemPrice: number;
    termsCheckedAt: string;
    pricesCheckedAt: string;
    shippingDestination?: string | null;
    targets: Targets;
    path: PricedPath;
    maxItemPrice: number;
    maxDelivered?: number;
    marketMaxItemPrice?: number;
}

export const PURCHASE_RECHECK_MESSAGE = "The verified price or purchase terms need a fresh check before buying.";

export function verifiedPurchase(evaluation: Evaluation, path: PricedPath, targets: Targets, maxItemPrice = path.maxBid, maxDelivered?: number): VerifiedPurchase | undefined {
    const { id, price, termsCheckedAt, buyingOption } = evaluation.listing;
    const { pricesCheckedAt } = evaluation;
    if (releaseIssue(evaluation) || evaluation.identity?.notThisCard || buyingOption !== "FIXED_PRICE" || price === null || !termsCheckedAt || !pricesCheckedAt ||
        !Number.isFinite(maxItemPrice) || maxItemPrice < price || maxItemPrice > path.maxBid) return;
    const marketLimit = maxItemPrice;
    if (maxDelivered !== undefined) {
        if (!Number.isFinite(maxDelivered) || maxDelivered < 0 || evaluation.listing.shipping === null ||
            cents(acquisitionCost(price, evaluation.listing.shipping, MONEY_CONFIG.buying)) > cents(maxDelivered)) return;
        maxItemPrice = affordableItemLimit(maxItemPrice, evaluation.listing.shipping, maxDelivered);
    }
    return { ...(maxDelivered !== undefined && { maxDelivered }), ...(marketLimit > maxItemPrice && { marketMaxItemPrice: marketLimit }), listingId: id, itemPrice: price, termsCheckedAt, pricesCheckedAt, shippingDestination: evaluation.listing.shippingDestination,
        targets, path, maxItemPrice };
}

// Bind the decision to the reviewed copy, terms, prices, targets and modeled route.
// Repricing may still show alternatives, but cannot reuse an earlier approval.
export function applyVerifiedPurchase(evaluation: Evaluation | null, purchase: VerifiedPurchase | undefined, targets: Targets, now: number, maxDelivered?: number): Evaluation | null {
    if (!evaluation || !purchase || !evaluation.underwriting?.verdict.startsWith("BUY") || evaluation.identity?.notThisCard || releaseIssue(evaluation)) return null;
    const { listing, underwriting } = evaluation;
    if (listing.id !== purchase.listingId || listing.buyingOption !== "FIXED_PRICE" || listing.availability !== "ACTIVE" ||
        Date.parse(listing.endTime ?? "") <= now || listing.price !== purchase.itemPrice || listing.termsCheckedAt !== purchase.termsCheckedAt ||
        (listing.shippingDestination ?? null) !== (purchase.shippingDestination ?? null) ||
        listing.shipping === null || underwriting.shippingUnconfirmed || !currentQuote(purchase.termsCheckedAt, now) ||
        evaluation.pricesCheckedAt !== purchase.pricesCheckedAt || !currentPriceEvidence(evaluation, now) ||
        purchase.targets?.minProfit !== targets.minProfit || purchase.targets?.minRoi !== targets.minRoi) return null;
    const savedPath = JSON.stringify(purchase.path);
    const path = underwriting.paths.find((candidate): candidate is PricedPath => candidate.status === "PRICED" && JSON.stringify(candidate) === savedPath);
    if (!path?.clears || !(path.profit > 0) || !Number.isFinite(purchase.maxItemPrice) || purchase.maxItemPrice > path.maxBid ||
        purchase.maxItemPrice < purchase.itemPrice || path.shipping !== listing.shipping) return null;

    const cap = purchase.maxItemPrice;
    if (purchase.relist) {
        const { price, profit, lowestOtherDelivered } = purchase.relist;
        if (path.path === "GRADE" || !path.salePrice || !(price > 0)) return null;
        if (purchase.relist.model === "matched-sales-v1" || purchase.relist.model === "matched-sales-v2") {
            if (purchase.relist.model === "matched-sales-v2" && purchase.relist.statistic !== "median" && purchase.relist.statistic !== "mean") return null;
            const projected = relistEstimate(evaluation, path, purchase.relist.competitor ?? null, now, purchase.relist.statistic, purchase.relist.model);
            if (!projected || projected.price !== price || projected.lowestOtherDelivered !== lowestOtherDelivered) return null;
        } else if (purchase.relist.model !== undefined ||
            lowestOtherDelivered !== null && !(Number.isFinite(lowestOtherDelivered) && lowestOtherDelivered > 0) ||
            price !== Math.min(path.salePrice, lowestOtherDelivered ?? Infinity)) return null;
        const net = netFromSale(price, path.path === "RAW" ? "raw" : "graded", MONEY_CONFIG.selling);
        if (!Number.isFinite(profit) || cents(profit) !== cents(net) - cents(path.cost) ||
            !meetsMoneyTargets(cents(net), cents(path.cost), targets.minProfit, targets.minRoi) ||
            cap > maxBid({ expectedNet: net, shipping: path.shipping, fixedCosts: path.fixedCosts }, { ...MONEY_CONFIG, targets })) return null;
    }
    if (purchase.marketMaxItemPrice !== undefined && (!Number.isFinite(purchase.marketMaxItemPrice) ||
        purchase.marketMaxItemPrice < cap || purchase.marketMaxItemPrice > path.maxBid)) return null;
    for (const budget of [purchase.maxDelivered, maxDelivered]) {
        if (budget !== undefined && (!Number.isFinite(budget) || budget < 0 ||
            cents(acquisitionCost(cap, path.shipping, MONEY_CONFIG.buying)) > cents(budget))) return null;
    }
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
