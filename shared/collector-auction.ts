import { affordableBidLimit, currentAuctionMarket, nextAuctionBid } from "./auction-opportunity.ts";
import { dollars } from "./format.ts";
import { cents } from "./money/cents.ts";
import { MONEY_CONFIG } from "./money/config.ts";
import { acquisitionCost } from "./money/underwriting.ts";
import { maxPriceEvidenceAge } from "./pricing-freshness.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "./search-diagnostic.ts";
import type { Evaluation } from "./types.ts";

export interface CollectorAuction {
    listingId: string;
    endsAt: string;
    validUntil: number;
    status: "BID" | "PASS" | "WATCH";
    marketValue: number;
    sampleSize: number;
    nextBid: number | null;
    nextTotal: number | null;
    maxBid: number | null;
    reason: string;
}

/** The collector keeps the slab. The ceiling covers the purchase, shipping and estimated tax. */
export function collectorAuction(e: Evaluation, now = Date.now(), maxDelivered?: number): CollectorAuction | null {
    const market = currentAuctionMarket(e, now);
    if (market?.kind !== "GRADED_RESALE" || !Number.isSafeInteger(cents(market.price)) ||
        maxDelivered !== undefined && (!Number.isFinite(maxDelivered) || maxDelivered < 0)) return null;
    const listing = e.listing;
    const budget = Math.min(market.price, maxDelivered ?? market.price);
    const shipping = listing.shipping;
    const quoted = shipping !== null && Number.isFinite(shipping) && shipping >= 0 && !e.underwriting?.shippingUnconfirmed;
    const max = quoted ? affordableBidLimit(budget, shipping, budget) : null;
    const next = nextAuctionBid(listing, now);
    const total = quoted && next !== null ? acquisitionCost(next, shipping, MONEY_CONFIG.buying) : null;
    const poorFeedback = listing.seller?.feedbackScore != null && listing.seller.feedbackScore < 10 ||
        listing.seller?.feedbackPercentage != null && listing.seller.feedbackPercentage < 98;
    let status: CollectorAuction["status"] = "WATCH";
    let decision: string;
    if (cents(listing.price!) >= cents(market.price)) {
        status = "PASS";
        decision = "Pass. The current item price has already reached the matched sold value.";
    } else if (max === null || next === null || total === null) {
        decision = max === null ? "Wait for an eBay shipping quote for your destination." : "Wait for a fresh minimum bid from eBay.";
    } else if (cents(next) > cents(max)) {
        status = "PASS";
        decision = `Pass. The next bid of ${dollars(next)} costs ${dollars(total)} delivered, above your ${dollars(budget)} all-in ceiling.`;
    } else if (poorFeedback || !e.underwriting || e.underwriting.verdict === "NEEDS_REVIEW" || e.frontPhotoStop) {
        decision = poorFeedback ? "Wait. The seller has limited or low feedback." : "Wait. The checks on this copy are incomplete or raised a concern.";
    } else {
        status = "BID";
        decision = `Bid up to ${dollars(max)} before shipping and tax for your collection. The next bid of ${dollars(next)} costs ${dollars(total)} delivered.`;
    }
    const count = market.count === 1 ? "1 matching sale" : `${market.count} matching sales`;
    const evidence = `The ${market.label} sold estimate is ${dollars(market.price)} from ${count}.`;
    const validity = [Date.parse(listing.endTime!), Date.parse(listing.termsCheckedAt!) + BEST_BUY_TERMS_MAX_AGE_MS,
        Date.parse(e.pricesCheckedAt!) + maxPriceEvidenceAge(e)];
    const summary = e.slabPricing!.summary!;
    const saleWindow = (summary.windowDays === 180 ? 180 : 90) * 86_400_000;
    for (const sale of summary.sales) validity.push(Date.parse(sale.soldAt) + saleWindow);
    if (next !== null) validity.push(Date.parse(listing.auctionQuote!.checkedAt) + BEST_BUY_TERMS_MAX_AGE_MS);
    return { listingId: listing.id, endsAt: listing.endTime!, validUntil: Math.min(...validity), status,
        marketValue: market.price, sampleSize: market.count, nextBid: next, nextTotal: total, maxBid: max,
        reason: `${decision} ${evidence}` };
}
