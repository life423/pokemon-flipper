import assert from "node:assert/strict";
import { test } from "node:test";
import type { DealHuntAction } from "../../shared/deal-hunt.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import { dealHuntCandidate } from "../../server/analysis/deal-hunt-evidence.ts";
import { rankHuntMarkets } from "../../server/analysis/same-set-markets.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";
import { tcgplayerRawEstimate } from "../fixtures/tcgplayer-raw-estimate.ts";

const now = Date.now();
const stamp = new Date(now).toISOString();
const checked = new Set<DealHuntAction>(["check_listing", "inspect_photos", "check_sales", "calculate_grading"]);

function rawCard(lowerPrice = 250) {
    const e = cardEvaluation({ minProfit: 0, minRoi: 0 });
    Object.assign(e, { pricesCheckedAt: stamp, pricingVersion: PRICING_VERSION, assessmentVersion: "offline/bounded-prompts-4", conditionVersion: "offline/bounded-condition-1/prompts-1" });
    Object.assign(e.listing, { availability: "ACTIVE", buyingOption: "FIXED_PRICE", price: 60, shipping: 0, termsCheckedAt: stamp });
    e.photoCheck!.cardCount = "ONE";
    e.rawPricing = null;
    const byGrade = [lowerPrice, 425, 450].map((p, i) => {
        const s = salesSummary("PSA", 6 + i, [p, p, p]);
        s.sales.forEach(sale => { sale.saleType = "fixed_price"; });
        return s;
    });
    e.gradedPricing = { PSA: { status: "PRICED", source: "pkmnprices", printing: "UNLIMITED", variant: "holo", byGrade } };
    e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets: { minProfit: 0, minRoi: 0 } });
    return e;
}

test("a matched TCGplayer raw estimate supports buying without fabricating completed-sales activity", () => {
    const e = rawCard();
    e.gradedPricing = null;
    e.rawPricing = { status: "PRICED", source: "pkmnprices", printing: "UNLIMITED", variant: "Unlimited Holofoil", finish: "HOLO",
        conditionEvidence: "TCGPLAYER", prices: [tcgplayerRawEstimate(175, stamp)] };
    e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets: { minProfit: 0, minRoi: 0 } });
    assert.equal(e.underwriting.verdict, "BUY_RAW");
    const result = dealHuntCandidate(e, "resell", now)!.outcome(checked)!;
    assert.equal(result.decision, "BUY");
    assert.match(result.reason, /0 observed matching Lightly Played raw sales in the last 60 days/);
    assert.match(result.reason, /quote alone does not establish sales activity/);
    assert.match(String(dealHuntCandidate(e, "resell", now)!.read("check_sales")), /TCGplayer estimate/);
    const [market] = rankHuntMarkets([e], null, "resell", "any_card", now);
    assert.equal(market.sales60, 0); assert.equal(market.sales30, 0); assert.equal(market.latestSaleAt, "");
    assert.equal(market.quoteAsOf, stamp); assert.equal(market.valueBasis, "TCGPLAYER_MARKET");

    const sellers = salesSummary("RAW", "LIGHTLY_PLAYED", [160]);
    Object.assign(sellers.sales[0], { saleType: "fixed_price", soldAt: new Date(now - 45 * 86_400_000).toISOString(),
        url: "https://www.ebay.com/itm/123111111111", sellerCondition: "LIGHTLY_PLAYED" });
    e.rawPricing.sellerConditionComps = sellers;
    const observed = dealHuntCandidate(e, "resell", now)!.outcome(checked)!;
    assert.equal(observed.decision, "BUY");
    assert.match(observed.reason, /1 observed matching Lightly Played raw sale in the last 60 days/);
    assert.equal(rankHuntMarkets([e], null, "resell", "any_card", now)[0].activityScope, "SELLER_CONDITION");
});

test("grade research uses photo and sales observations and distinguishes likely and lower grade after-cost returns", () => {
    const e = rawCard(), candidate = dealHuntCandidate(e, "grade_raw", now)!;
    assert.equal(dealHuntCandidate(e, "collect_slab", now), null);
    assert.ok(!candidate.available(new Set()).includes("calculate_grading"));
    assert.ok(candidate.available(new Set(["inspect_photos", "check_sales"])).includes("calculate_grading"));
    assert.equal(candidate.outcome(new Set(["check_sales", "inspect_photos", "check_listing"])), null);
    assert.match(String(candidate.read("calculate_grading")), /likely grade \(PSA 7\), the projected profit is \$[\d,.]+ after all costs. One grade lower \(PSA 6\), the projected profit/);
    assert.equal(candidate.outcome(checked)?.decision, "BUY");
    assert.equal(candidate.outcome(checked)?.section, "grading");
    assert.deepEqual(candidate.outcome(checked)?.alternateSections, ["sales"]);

    const downside = dealHuntCandidate(rawCard(15), "grade_raw", now)!;
    assert.match(String(downside.read("calculate_grading")), /PSA 6\), the projected loss is \$/);
    assert.equal(downside.outcome(checked)?.decision, "WAIT");
    let clock = now;
    const expired = dealHuntCandidate(e, "grade_raw", () => clock)!;
    assert.equal(expired.outcome(checked)?.decision, "BUY");
    clock += 120_001;
    assert.equal(expired.outcome(checked)?.decision, "WAIT");
    assert.match(expired.outcome(checked)!.reason, /fresh availability/);

    e.gradedPricing!.PSA!.byGrade![0].sales.forEach(sale => { delete sale.saleType; });
    assert.equal(dealHuntCandidate(e, "grade_raw", now)!.outcome(checked)?.decision, "WAIT");
});

test("the resale hunt reads seller-described sales when the sold photos have yet to establish a raw price", () => {
    const e = rawCard();
    e.photoCheck!.cardMatch = { verdict: "MATCH", problems: [] };
    e.gradedPricing = null;
    e.listing.price = 95;
    const sales = salesSummary("RAW", "LIGHTLY_PLAYED", [48, 59, 69]);
    sales.sales.forEach((sale, i) => Object.assign(sale, { saleType: "fixed_price", sellerCondition: "LIGHTLY_PLAYED",
        url: `https://www.ebay.com/itm/${125000000000 + i}` }));
    e.rawPricing = { status: "PRICE_UNAVAILABLE", source: "pkmnprices", variant: "Holofoil", printing: "UNLIMITED",
        finish: "HOLO", conditionEvidence: "AI_PHOTOS", sellerConditionComps: sales };
    e.underwriting = underwrite(e);
    const hunt = dealHuntCandidate(e, "resell", now)!;
    assert.match(String(hunt.read("check_sales")), /\$48\.00.*\$69\.00/);
    assert.match(hunt.outcome(checked)!.reason, /\$48\.00.*\$69\.00/);
    assert.equal(hunt.outcome(checked)!.decision, "WAIT");
});

function slabCard() {
    const e = rawCard();
    e.condition = null; e.rawPricing = null; e.gradedPricing = null;
    e.listing.price = 999;
    Object.assign(e.identity!, { name: "Dark Gengar", set: "Neo Destiny", cardNumber: "6/105", hasEditions: true });
    e.listing.title = "Dark Gengar 6/105 CGC 8.5";
    e.slab = { status: "OK", grader: "CGC", grade: "8.5", gradeQualifier: null, certNumber: null, certUrl: null,
        labelText: e.listing.title, caseCondition: "INTACT", concerns: [], reasons: [] };
    Object.assign(e.photoCheck!, { holder: "GRADED_SLAB", slab: { ...e.slab, present: true, authenticity: "NONE_SEEN" } });
    e.underwriting = { verdict: "CANT_PRICE", best: null, paths: [], reasons: [], assumptions: [] };
    e.trackerPriceReference = { source: "POKEMON_PRICE_TRACKER", tcgPlayerId: 1, printingLabel: "Unlimited Holofoil", caveat: "",
        gradedMarket: { grader: "CGC", grade: "8.5", priceUsd: 925, statistic: "7_DAY_MEDIAN", reportedSales: 8, lastSaleAt: stamp, marketplaces: ["eBay"] } };
    return e;
}

test("a collector can buy within the exact slab market even when resale loses; estimates alone never return a buy", () => {
    const e = slabCard();
    const checked = new Set<DealHuntAction>(["check_listing", "inspect_photos", "check_sales"]);
    const reference = dealHuntCandidate(e, "collect_slab", now)!;
    assert.equal(dealHuntCandidate(e, "grade_raw", now), null);
    assert.ok(!reference.available(checked).includes("calculate_grading"));
    assert.match(String(reference.read("check_sales")), /\$925\.00/);
    assert.equal(reference.outcome(checked)?.decision, "WAIT");
    e.listing.price = 800;
    assert.equal(dealHuntCandidate(e, "collect_slab", now)!.outcome(checked)?.decision, "WAIT");

    const comp = salesSummary("CGC", 8.5, [890, 900, 910]);
    comp.sales.forEach(sale => { sale.saleType = "fixed_price"; });
    e.slabPricing = { status: "PRICED", printing: "UNLIMITED", grader: "CGC", grade: 8.5, summary: comp };
    e.underwriting = underwrite(e);
    const exact = dealHuntCandidate(e, "collect_slab", now)!;
    assert.match(String(exact.read("check_sales")), /3 matched CGC 8.5 sales/);
    assert.equal(exact.outcome(checked)?.decision, "BUY");
    assert.equal(exact.outcome(checked)?.section, "sales");
    assert.equal(dealHuntCandidate(e, "resell", now)!.outcome(checked)?.decision, "WAIT");

    e.slabPricing.printing = "FIRST_EDITION";
    assert.equal(dealHuntCandidate(e, "collect_slab", now)!.outcome(checked)?.decision, "WAIT");
});

test("a loss one grade lower can still leave an independently supported raw resale for the resale goal", () => {
    const e = rawCard(15);
    const sales = salesSummary("RAW", "LIGHTLY_PLAYED", [170, 175, 180]);
    for (const [i, sale] of sales.sales.entries()) {
        sale.saleType = "fixed_price"; sale.photoCondition = "LIGHTLY_PLAYED"; sale.conditionEvidence = ["Wear visible on the edges."];
        sale.url = `https://www.ebay.com/itm/${123000000000 + i}`;
    }
    e.rawPricing = { status: "PRICED", printing: "UNLIMITED", source: "pkmnprices", variant: "holo", conditionEvidence: "AI_PHOTOS",
        prices: [{ basis: "EBAY_SOLD", condition: "LIGHTLY_PLAYED", price: 175, updatedAt: stamp, comps: sales }] };
    e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets: { minProfit: 0, minRoi: 0 } });
    assert.equal(e.underwriting.best?.path, "GRADE");
    assert.equal(dealHuntCandidate(e, "grade_raw", now)!.outcome(checked)?.decision, "WAIT");
    const decision = dealHuntCandidate(e, "resell", now)!.outcome(checked);
    assert.equal(decision?.decision, "BUY");
    assert.equal(decision?.section, "sales");
    assert.equal(decision?.alternateSections, undefined);
    assert.match(decision!.reason, /3 observed matching Lightly Played raw sales in the last 60 days/);
    const [lead] = rankHuntMarkets([e], null, "resell", "any_card", now);
    // The matching sale histories overlap. A thin copy can reuse the exact
    // market's three distinct sales, but cannot borrow another printing's count.
    sales.sales.splice(1);
    const thin = dealHuntCandidate(e, "resell", now)!.outcome(checked);
    assert.equal(thin?.decision, "BUY");
    assert.match(thin!.reason, /1 observed matching Lightly Played raw sale/);
    assert.equal(dealHuntCandidate(e, "resell", now, lead)!.outcome(checked)?.decision, "BUY");
    const wrongPrinting = dealHuntCandidate(e, "resell", now, { ...lead, printing: "FIRST_EDITION" })!.outcome(checked)!;
    assert.equal(wrongPrinting.decision, "BUY");
    assert.match(wrongPrinting.reason, /1 observed matching Lightly Played raw sale/, "activity from another printing is never borrowed");
    assert.equal(dealHuntCandidate(e, "resell", now, { ...lead, liquidThrough: now - 1 })!.outcome(checked)?.decision, "BUY", "a legacy volume deadline is not a purchase veto");
});

test("slab resale reports activity at that holder grade without a sales quota", () => {
    const e = slabCard();
    e.listing.price = 100;
    const summary = salesSummary("CGC", 8.5, [890, 900, 910]);
    summary.sales.forEach((sale, i) => Object.assign(sale, { saleType: "auction", url: `https://www.ebay.com/itm/${123450000000 + i}` }));
    e.slabPricing = { status: "PRICED", source: "pkmnprices", variant: "Holofoil", printing: "UNLIMITED", grader: "CGC", grade: 8.5, summary };
    e.underwriting = underwrite(e);
    const [liquid] = rankHuntMarkets([e], null, "resell", "any_card", now);
    assert.equal(dealHuntCandidate(e, "resell", now)!.outcome(checked)?.decision, "BUY");
    summary.sales.splice(1);
    assert.equal(dealHuntCandidate(e, "collect_slab", now)!.outcome(checked)?.decision, "BUY");
    assert.equal(dealHuntCandidate(e, "resell", now, { ...liquid, grade: 9 })!.outcome(checked)?.decision, "BUY");
    assert.match(dealHuntCandidate(e, "resell", now, { ...liquid, grader: "PSA" })!.outcome(checked)!.reason, /1 observed matching CGC 8.5 sale/);
    e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets: { minProfit: 3000, minRoi: 0 } });
    assert.match(dealHuntCandidate(e, "resell", now, liquid)!.outcome(checked)!.reason, /falls short of your profit or ROI target/);
});

test("a profitable grading exit remains eligible with sparse activity", () => {
    const e = rawCard();
    const sales = salesSummary("RAW", "LIGHTLY_PLAYED", [170, 175, 180]);
    for (const [i, sale] of sales.sales.entries()) {
        Object.assign(sale, { saleType: "auction", photoCondition: "LIGHTLY_PLAYED", url: `https://www.ebay.com/itm/${321000000000 + i}` });
    }
    e.rawPricing = { status: "PRICED", printing: "UNLIMITED", source: "pkmnprices", variant: "holo",
        prices: [{ basis: "EBAY_SOLD", condition: "LIGHTLY_PLAYED", price: 175, updatedAt: stamp, comps: sales }] };
    e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets: { minProfit: 0, minRoi: 0 } });
    assert.equal(e.underwriting.best?.path, "GRADE");
    const candidate = dealHuntCandidate(e, "resell", now)!;
    assert.equal(candidate.outcome(checked)?.decision, "BUY");
    assert.equal(candidate.outcome(checked)?.section, "grading");
    const likely = e.gradedPricing!.PSA!.byGrade!.find(s => Number(s.grade) === 7)!;
    likely.sales.forEach((sale, i) => sale.url = `https://www.ebay.com/itm/${321111000000 + i}`);
    const graded = candidate.outcome(checked);
    assert.equal(graded?.decision, "BUY");
    assert.match(graded!.reason, /3 observed matching PSA 7 sales in the last 60 days/);
    assert.equal(graded?.section, "grading");
});

test("a raw auction with only graded sales cannot claim a discount against its raw market", () => {
    const e = rawCard();
    Object.assign(e.listing, { buyingOption: "AUCTION", bids: 1, price: 10, shipping: 2, endTime: new Date(now + 3_600_000).toISOString(),
        auctionQuote: {currentBid: 10, minimumBid: 11, checkedAt: stamp} });
    assert.equal(e.rawPricing, null);
    const outcome = dealHuntCandidate(e, "resell", now)!.outcome(checked);
    assert.equal(outcome?.decision, "WAIT");
    assert.match(outcome!.reason, /did not establish a current below-market auction/);
});

test("a sparse auction can use a condition-specific reference for Wait after the verified next bid fits the buyer's cap", () => {
    const e = rawCard();
    Object.assign(e.listing, { buyingOption: "AUCTION", price: 35, bids: 1, auctionQuote: { checkedAt: stamp, currentBid: 35, minimumBid: 36 },
        endTime: new Date(now + 3_600_000).toISOString() });
    e.gradedPricing = null;
    e.underwriting = { verdict: "CANT_PRICE", best: null, reasons: [], paths: [], assumptions: [] };
    const checked = new Set<DealHuntAction>(["check_listing", "check_sales", "inspect_photos"]);
    const hunt = (budget?: number) => dealHuntCandidate(e, "resell", now, undefined, MONEY_CONFIG.targets, budget)!;
    assert.ok(!hunt().available(new Set(["check_sales"])).includes("check_price_references"));
    assert.ok(!hunt(35).available(checked).includes("check_price_references"));
    assert.ok(hunt(50).available(checked).includes("check_price_references"));
    e.trackerRawReference = { source: "TCGPLAYER_MARKET", tcgPlayerId: 1, recordId: String(e.identity!.recordId), printing: "FIRST_EDITION",
        finish: "HOLO", condition: "LIGHTLY_PLAYED", priceUsd: 100, updatedAt: stamp };
    assert.ok(hunt().available(checked).includes("check_price_references"));
    e.trackerRawReference.printing = "UNLIMITED";
    assert.ok(!hunt().available(checked).includes("check_price_references"));
    checked.add("check_price_references");
    const result = hunt().outcome(checked);
    assert.equal(result?.decision, "WAIT");
    assert.match(result!.reason, /\$100\.00 TCGplayer market estimate for Lightly Played/);
    e.listing.endTime = new Date(now + 10 * 3_600_000).toISOString();
    delete e.trackerRawReference;
    assert.ok(!hunt().available(new Set(["check_listing", "check_sales", "inspect_photos"])).includes("check_price_references"));
});

test("a price reference for a different slab printing or web grade cannot suppress a new lookup", () => {
    const e = slabCard();
    const checks = new Set<DealHuntAction>(["check_listing", "check_sales", "inspect_photos"]);
    e.trackerPriceReference!.printingLabel = "1st Edition Holofoil";
    e.webPriceResearch = { checkedAt: stamp, market: { cardName: "Dark Gengar", setName: "Neo Destiny", cardNumber: "6/105",
        printingLabel: e.identity!.printingLabel!, finish: "HOLO", language: e.identity!.language, grader: "PSA", grade: "9" },
        observations: [{ title: "Different slab", kind: "SOLD", priceUsd: 9999, date: stamp.slice(0, 10), url: "https://www.ebay.com/itm/123000000099" }] };
    const candidate = dealHuntCandidate(e, "collect_slab", now)!;
    assert.ok(candidate.available(checks).includes("check_price_references"));
    assert.doesNotMatch(String(candidate.read("check_sales")), /925|9,999/);
});

test("the planner can inspect a raw exit directly on both auctions and Buy It Now and still honor the grade-only goal", () => {
    const e = rawCard(15);
    const comps = salesSummary("RAW", "LIGHTLY_PLAYED", [170, 175, 180]);
    comps.sales.forEach((sale, i) => Object.assign(sale, { saleType: "auction", photoCondition: "LIGHTLY_PLAYED",
        conditionEvidence: ["Edge wear on front and back."], url: `https://www.ebay.com/itm/${321000001000 + i}` }));
    e.rawPricing = { status: "PRICED", printing: "UNLIMITED", finish: "HOLO", source: "pkmnprices", variant: "holo", conditionEvidence: "AI_PHOTOS",
        prices: [{ basis: "EBAY_SOLD", condition: "LIGHTLY_PLAYED", price: 175, updatedAt: stamp, comps }] };
    const targets = { minProfit: 0, minRoi: 0 };
    const choices = new Set<DealHuntAction>(["inspect_photos", "check_raw_resale", "check_listing"]);
    for (const format of ["FIXED_PRICE", "AUCTION"] as const) {
        Object.assign(e.listing, { buyingOption: format, bids: 1, price: 35, shipping: 2, endTime: new Date(now + 3_600_000).toISOString(),
            auctionQuote: { currentBid: 35, minimumBid: 36, checkedAt: stamp } });
        e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets });
        const hunt = dealHuntCandidate(e, "resell", now, undefined, targets)!;
        assert.ok(hunt.available(new Set()).includes("check_raw_resale"));
        assert.match(String(hunt.read("check_raw_resale")), /Lightly Played estimate of \$175.00.*profit.*3 observed matching sales/);
        const result = hunt.outcome(choices);
        assert.equal(result?.decision, format === "AUCTION" ? "BID" : "BUY");
        assert.equal(result?.section, "sales");
        assert.ok(!dealHuntCandidate(e, "grade_raw", now)!.available(new Set()).includes("check_raw_resale"));
    }
    comps.sales.splice(1);
    assert.equal(dealHuntCandidate(e, "resell", now)!.outcome(choices)?.decision, "BID", "one exact sale can support value without a three-sale veto");
});
