import assert from "node:assert/strict";
import test from "node:test";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";
import { rawBuyGuidance } from "../../shared/money/raw-buy-guidance.ts";
import { PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import type { CompSummary, Evaluation } from "../../shared/types.ts";

const now = Date.now();
function summary(grader: string, grade: string | number, prices: number[]) {
    const value = salesSummary(grader, grade, prices);
    return { ...value, median: prices[Math.floor(prices.length / 2)], sales: value.sales.map(s => ({ ...s, saleType: "fixed_price" as const })) };
}
function example(): Evaluation {
    const e = cardEvaluation();
    Object.assign(e, { pricesCheckedAt: new Date(now).toISOString(), pricingVersion: PRICING_VERSION,
        assessmentVersion: "test/bounded-prompts-3", conditionVersion: "test/bounded-condition-1/prompts-1" });
    Object.assign(e.listing, { availability: "ACTIVE", termsCheckedAt: new Date(now).toISOString(), price: 89.95, shipping: 8, buyingOption: "FIXED_PRICE", endTime: null });
    Object.assign(e.photoCheck!, { cardCount: "ONE", cardMatch: { verdict: "MATCH", problems: [] } });
    Object.assign(e.condition!, { rawCondition: "HEAVILY_PLAYED", gradeRange: { low: 2, likely: 3, high: 4 } });
    e.underwriting = { verdict: "CANT_PRICE", reasons: ["There is only a worse-condition resale floor."], paths: [], assumptions: [] };
    const exact = summary("RAW", "HEAVILY_PLAYED", [16, 17.5, 19.5, 21]), cleaner = summary("RAW", "MODERATELY_PLAYED", [39.25]);
    for (const sale of exact.sales) sale.sellerCondition = "HEAVILY_PLAYED";
    for (const sale of cleaner.sales) { sale.photoCondition = "MODERATELY_PLAYED"; sale.conditionEvidence = ["Visible edge wear"]; }
    e.rawPricing = { source: "pkmnprices", variant: "Holofoil", printing: "UNLIMITED", finish: "HOLO", status: "PRICED",
        conditionEvidence: "AI_PHOTOS", ebayComps: [cleaner], sellerConditionComps: exact, prices: [{ condition: "DAMAGED", price: 19, basis: "EBAY_SOLD", updatedAt: new Date(now).toISOString() }] };
    e.gradedPricing = { PSA: { source: "pkmnprices", variant: "Holofoil", printing: "UNLIMITED", status: "PRICED", byGrade: [
        summary("PSA", 2, [55.74]), summary("PSA", 3, [39.38, 52, 71, 89]), summary("PSA", 4, [62.5, 75])] } };
    return e;
}

test("worse-condition floor with corroborated seller-described sales and slab economics gives a conditional pass at each saved purchase total", () => {
    const first = example(), advice = rawBuyGuidance(first, now)!;
    assert.equal(advice.decision, "PASS"); assert.match(advice.headline, /106.03/);
    assert.match(advice.details.join(" "), /131.79.*16.00–\$21.00.*39.25.*74.99.*222.03/);
    const second = example();
    Object.assign(second.listing, { price: 63.55, shipping: 5.65, termsCheckedAt: new Date(now - 5 * 60_000).toISOString() });
    second.provisionalGradeRange = second.condition!.gradeRange!;
    second.condition!.gradeRange = null;
    const psa = second.gradedPricing!.PSA!;
    psa.referenceByGrade = psa.byGrade; psa.referenceGradeComps = psa.byGrade![1]; delete psa.byGrade;
    const tentative = rawBuyGuidance(second, now)!;
    assert.equal(tentative.decision, "PASS"); assert.match(tentative.headline, /74.91/);
    assert.match(tentative.details.join(" "), /Last checked.*95.31.*185.55/);
    assert.equal(second.underwriting!.verdict, "CANT_PRICE");
});

test("profitable upper grade, potential CGC exit, stronger raw sale, or missing corroboration keeps the recommendation open", () => {
    const strong = example();
    const valuable = (grader: string, grade: number): CompSummary => summary(grader, grade, [210, 222, 310]);
    strong.gradedPricing!.PSA!.byGrade!.push(valuable("PSA", 4));
    assert.equal(rawBuyGuidance(strong, now)?.decision, "WAIT");
    const cgc = example();
    cgc.gradedPricing!.CGC = { ...cgc.gradedPricing!.PSA!, byGrade: [valuable("CGC", 3)] };
    assert.equal(rawBuyGuidance(cgc, now)?.decision, "WAIT");
    const betterRaw = example();
    betterRaw.rawPricing!.sellerConditionComps!.sales[0].price = 140;
    assert.equal(rawBuyGuidance(betterRaw, now)?.decision, "WAIT");
    const floorOnly = example();
    delete floorOnly.rawPricing!.ebayComps;
    assert.equal(rawBuyGuidance(floorOnly, now)?.decision, "WAIT");
});

test("raw purchase guidance respects quote, source, freshness, identity and availability checks", () => {
    const failed = example(); failed.listing.shipping = null;
    assert.equal(rawBuyGuidance(failed, now)?.decision, "WAIT");
    const stale = example();
    assert.equal(rawBuyGuidance(stale, now + 7 * 3_600_000)?.decision, "WAIT");
    const mismatch = example(); mismatch.rawPricing!.printing = "FIRST_EDITION";
    assert.equal(rawBuyGuidance(mismatch, now)?.decision, "WAIT");
    const noPhotos = example(); noPhotos.photoCheck = null;
    assert.equal(rawBuyGuidance(noPhotos, now), null);
    const inactive = example(); inactive.listing.availability = "UNAVAILABLE";
    assert.equal(rawBuyGuidance(inactive, now), null);
});

test("the buyer sees distinct condition-matched PKMNPrices and cited sales, a target-adjusted all-in limit, and separate cleaner market context", () => {
    const e = example(), id = e.identity!;
    id.recordId = 10;
    const first = e.rawPricing!.sellerConditionComps!.sales[0];
    first.url = "https://www.ebay.com/itm/123456789000";
    const market = { cardName: id.name!, cardNumber: id.cardNumber!, setName: id.set!, printingLabel: id.printingLabel!,
        finish: id.finish, language: id.language!, grader: "RAW", grade: "Heavily Played" };
    const sold = { title: "Seller-described HP", kind: "SOLD" as const, date: first.soldAt.slice(0, 10), priceUsd: first.price, url: first.url };
    e.webPriceResearch = { checkedAt: new Date(now).toISOString(), market, observations: [sold,
        { ...sold, url: "https://www.pricecharting.com/game/pokemon-base-set/venusaur-15" },
        { ...sold, kind: "ASK", url: "https://www.ebay.com/itm/123456789001", priceUsd: 600 },
        { ...sold, date: "2000-01-01", url: "https://www.ebay.com/itm/123456789002", priceUsd: 1000 },
        { ...sold, url: "https://www.ebay.com/itm/123456789003", priceUsd: 22 }] };
    e.trackerRawReference = { source: "TCGPLAYER_MARKET", recordId: "10", tcgPlayerId: 11, printing: "UNLIMITED", finish: "HOLO",
        condition: "NEAR_MINT", priceUsd: 95, updatedAt: new Date(now).toISOString() };
    const advice = rawBuyGuidance(e, now)!;
    assert.match(advice.explanation, /5 seller-described Heavily Played sales at \$16.00–\$22.00/);
    assert.match(advice.explanation, /\$19.50 median/);
    assert.match(advice.details.join(" "), /TCGplayer market estimate of \$95.00 for Near Mint/);
    assert.doesNotMatch(advice.explanation, /95.00|600|1,000/);
    assert.match(rawBuyGuidance(e, now, { minProfit: 100, minRoi: 0 })!.explanation, /too little/);
    e.webPriceResearch.market!.printingLabel = "First Edition";
    assert.match(rawBuyGuidance(e, now)!.explanation, /4 seller-described/);
});

test("condition-specific outside evidence can supply a conditional valuation when the primary provider has no usable prices", () => {
    const e = example(), id = e.identity!;
    id.recordId = 12;
    e.rawPricing = { status: "PRICE_UNAVAILABLE" };
    e.gradedPricing = null;
    e.trackerRawReference = { source: "TCGPLAYER_MARKET", recordId: "12", tcgPlayerId: 55, printing: "UNLIMITED", finish: "HOLO",
        condition: "HEAVILY_PLAYED", updatedAt: new Date(now).toISOString(), priceUsd: 42 };
    assert.match(rawBuyGuidance(e, now)!.explanation, /TCGplayer market estimate for Heavily Played.*raw-flip limit/);
    e.trackerRawReference.printing = "FIRST_EDITION";
    assert.doesNotMatch(rawBuyGuidance(e, now)!.explanation, /42.00|raw-flip limit/);
    assert.equal(e.underwriting?.verdict, "CANT_PRICE");
});
