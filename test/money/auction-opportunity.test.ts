import assert from "node:assert/strict";
import test from "node:test";
import { auctionOpportunity, withinOpportunityWindow } from "../../shared/auction-opportunity.ts";
import { collectorAuction } from "../../shared/collector-auction.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import type { CompSummary, Evaluation } from "../../shared/types.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";
import { tcgplayerRawEstimate } from "../fixtures/tcgplayer-raw-estimate.ts";

const now = Date.now(), stamp = new Date(now).toISOString(), targets = {minProfit: 5, minRoi: 0};
const end = (ms: number) => new Date(now + ms).toISOString();
function sales(grader: string, grade: string | number, prices: number[]) {
    const s = salesSummary(grader, grade, prices);
    s.sales.forEach((sale, i) => Object.assign(sale, { saleType: "fixed_price", url: `https://www.ebay.com/itm/${320000001000 + i + (grader === "RAW" ? 0 : Number(grade) * 100)}` },
        grader === "RAW" ? { photoCondition: grade, conditionEvidence: ["Edge wear."] } : {}));
    return s;
}
function raw() {
    const e = cardEvaluation(targets);
    Object.assign(e, { pricesCheckedAt: stamp, pricingVersion: PRICING_VERSION, assessmentVersion: "vendor/bounded-prompts-4",
        conditionVersion: "provider/bounded-condition-1/prompts-1", gradedPricing: null });
    Object.assign(e.listing, {price: 35, shipping: 5, bids: 1, endTime:end(3600000), availability: "ACTIVE", termsCheckedAt: stamp,
        auctionQuote: {currentBid: 35, minimumBid: 36, checkedAt: stamp}});
    e.photoCheck!.cardCount = "ONE";
    e.rawPricing = {status:"PRICED", printing:"UNLIMITED", variant:"Holofoil", finish:"HOLO", conditionEvidence:"AI_PHOTOS",
        prices:[{basis:"EBAY_SOLD", condition:"LIGHTLY_PLAYED", price:100, updatedAt:stamp, comps:sales("RAW","LIGHTLY_PLAYED",[95,100,105])}]};
    return e;
}
const receipt = (e: Evaluation, budget?: number) => auctionOpportunity(retargetEvaluation(e, targets), targets, now, budget);

test("a raw auction can use an exact TCGplayer estimate while sixty-day sale activity stays separate", () => {
    const e = raw();
    e.rawPricing!.conditionEvidence = "TCGPLAYER";
    e.rawPricing!.prices = [tcgplayerRawEstimate(100, stamp)];
    const opportunity = receipt(e)!;
    assert.equal(opportunity.status, "BID");
    assert.equal(opportunity.marketValue, 100);
    assert.equal(opportunity.sales60, 0); assert.equal(opportunity.exitSales60, 0); assert.equal(opportunity.sampleSize, 0);
    assert.ok(opportunity.maxBid! < 100, "fees, shipping and tax still constrain the bid");
    const summary = sales("RAW", "LIGHTLY_PLAYED", [100]);
    summary.sales[0].soldAt = new Date(now - 45 * 86_400_000).toISOString();
    delete summary.sales[0].photoCondition; delete summary.sales[0].conditionEvidence;
    e.rawPricing!.sellerConditionComps = summary;
    assert.equal(receipt(e)?.sales60, 1); assert.equal(receipt(e)?.sales30, 0);
    assert.equal(receipt(e)?.status, "BID");
    e.listing.endTime = end(10 * 3_600_000);
    assert.equal(receipt(e), null, "the strict ten-hour auction window is preserved");
});

test("only active auctions strictly under ten hours and under the matching as-listed price qualify", () => {
    for (const ms of [-1, 0, 10 * 3600000, 10 * 3600000 + 1]) assert.equal(withinOpportunityWindow(end(ms), now), false);
    for (const ms of [1, 10 * 3600000 - 1]) assert.ok(withinOpportunityWindow(end(ms), now));
    const e = raw(); assert.equal(receipt(e)?.status, "BID");
    for (const price of [100, 105]) { e.listing.price = price; assert.equal(receipt(e), null); }
    e.listing.price = 35;
    e.listing.buyingOption = "FIXED_PRICE"; assert.equal(receipt(e),null);
    e.listing.buyingOption = "AUCTION"; e.listing.termsCheckedAt = end(-BEST_BUY_TERMS_MAX_AGE_MS); assert.equal(receipt(e),null);
});

test("next bid, delivery and the buyer’s budget control the recommendation while the market opportunity survives", () => {
    const e = raw(), first = receipt(e)!;
    assert.equal(first.nextTotal,44.38);
    assert.equal(first.status,"BID"); assert.equal(first.routeKind,"RAW");
    assert.ok(first.maxBid! > first.nextBid! && first.maxBid! < 100);
    assert.equal(receipt(e,44.38)?.maxBid,36); assert.equal(receipt(e,44.37)?.status,"PASS");
    e.listing.shipping = 80; assert.equal(receipt(e)?.status,"PASS");
    e.listing.shipping = null; assert.equal(receipt(e)?.status,"WATCH"); assert.equal(receipt(e)?.nextTotal,null);
    e.listing.shipping = 5; e.listing.auctionQuote!.minimumBid = 99;
    assert.equal(receipt(e)?.status,"PASS"); assert.ok(receipt(e)!.profitAtNext! < 0);
    e.listing.auctionQuote!.currentBid = 25; assert.equal(receipt(e)?.status,"WATCH");
    e.listing.bids = 0; e.listing.auctionQuote = {currentBid:null, minimumBid:35, checkedAt:stamp};
    assert.equal(receipt(e)?.status,"BID");
});

test("thin sales can establish an auction opportunity while mismatched markets, currencies and condition cannot", () => {
    const e = raw(), p = e.rawPricing!, rows = p.prices![0].comps!.sales;
    rows[1].url = rows[0].url; rows[1].price = rows[0].price; rows[1].soldAt = rows[0].soldAt;
    assert.equal(receipt(e)?.status,"BID"); assert.equal(receipt(e)?.sales30,2); assert.equal(receipt(e)?.sales60,2);
    p.printing = "FIRST_EDITION"; assert.equal(receipt(e),null);
    p.printing = "UNLIMITED"; p.variant = "Reverse Holo"; assert.equal(receipt(e),null);
    p.variant = "Holofoil"; rows[0].photoCondition = "NEAR_MINT"; assert.equal(receipt(e),null);
    rows[0].photoCondition = "LIGHTLY_PLAYED"; Object.assign(rows[0],{currency:"EUR"}); assert.equal(receipt(e),null);
});

test("a slab uses its exact certified market and can qualify as a single auction", () => {
    const e = raw(); e.condition = null; e.rawPricing = null;
    e.slab = { status:"OK", grader:"CGC", grade:"8.5", gradeQualifier:null, certNumber:"123456", certUrl:null,
        labelText:"Venusaur CGC 8.5", caseCondition:"INTACT", concerns:[], reasons:[] };
    Object.assign(e.photoCheck!,{holder:"GRADED_SLAB",slab:{...e.slab,present:true,authenticity:"NONE_SEEN"}});
    e.slabPricing = {status:"PRICED", grader:"CGC", grade:"8.5", printing:"UNLIMITED", variant:"Holofoil", summary:sales("CGC","8.5",[90,99,110])};
    const s = receipt(e); assert.equal(s?.status,"BID"); assert.equal(s.routeKind,"GRADED_RESALE"); assert.equal(s.marketValue,99);
    e.slabPricing.grade="9"; assert.equal(receipt(e),null);
});

test("collector bid limits use verified fair value and the delivered budget at the exact cent", () => {
    const e = raw();
    assert.equal(collectorAuction(e, now), null);
    e.condition = null;
    e.rawPricing = null;
    e.slab = { status: "OK", grader: "CGC", grade: "8.5", gradeQualifier: null, certNumber: null, certUrl: null,
        labelText: "Venusaur CGC 8.5", caseCondition: "INTACT", concerns: [], reasons: [] };
    Object.assign(e.photoCheck!, { holder: "GRADED_SLAB", slab: { ...e.slab, present: true, authenticity: "NONE_SEEN" } });
    e.slabPricing = { status: "PRICED", grader: "CGC", grade: 8.5, printing: "UNLIMITED", variant: "Holofoil", summary: sales("CGC", "8.5", [70, 75, 79]) };
    const check = (budget?: number) => collectorAuction(retargetEvaluation(e, targets), now, budget);
    assert.equal(check(44.38)?.status, "BID");
    assert.equal(check(44.38)?.maxBid, 36);
    assert.equal(check(44.37)?.status, "PASS");
    assert.equal(check(200)?.maxBid, 64.28, "the market caps a larger budget");
    e.listing.shipping = null;
    assert.equal(check()?.status, "WATCH");
    e.listing.shipping = 5;
    e.listing.auctionQuote!.currentBid = 33;
    assert.equal(check()?.status, "WATCH");
    e.listing.auctionQuote!.currentBid = 35;
    e.listing.seller!.feedbackScore = 2;
    assert.equal(check()?.status, "WATCH");
    e.listing.seller!.feedbackScore = 50;
    e.listing.endTime = end(10 * 3600000);
    assert.equal(check(), null);
    e.listing.endTime = end(3600000);
    e.slabPricing.printing = "FIRST_EDITION";
    assert.equal(check(), null);
    e.slabPricing.printing = "UNLIMITED";
    e.slabPricing.summary!.sales[1].saleType = undefined;
    assert.equal(check(), null, "a price with unconfirmed sale provenance cannot set a bid");
});

test("a grading exit must have sales one grade lower, with a ceiling that keeps that grade profitable", () => {
    const e = raw(); const likely = e.condition!.gradeRange!.likely!;
    const atGrade = (grade: number, price: number): CompSummary => sales("PSA", grade,[price-1,price,price+1]);
    e.gradedPricing = {PSA:{status:"PRICED",grader:"PSA",variant:"Holofoil",printing:"UNLIMITED",
        byGrade:[atGrade(likely-1,185),atGrade(likely,300),atGrade(likely+1,500)]}};
    const r=receipt(e)!; assert.equal(r.routeKind,"GRADE"); assert.equal(r.marketValue,100);
    assert.equal(r.grading?.lowerGrade,likely-1); assert.ok(r.grading!.lowerProfit>0);
    e.listing.price=101; e.listing.auctionQuote={currentBid:101,minimumBid:102,checkedAt:stamp};
    assert.equal(receipt(e),null);
    e.listing.price=35; e.listing.auctionQuote={currentBid:35,minimumBid:36,checkedAt:stamp};
    const prices = e.gradedPricing.PSA!.byGrade!;
    prices[0].sales[0].url = prices[1].sales[0].url;
    assert.equal(receipt(e)?.routeKind,"RAW", "a single sale cannot support two different certified grades");
    prices.shift(); assert.equal(receipt(e)?.routeKind,"RAW");
});
