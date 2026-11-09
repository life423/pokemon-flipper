import { test } from "node:test";
import assert from "node:assert/strict";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { rateDeal } from "../../shared/money/rating.ts";
import { priceEvidenceGap } from "../../shared/money/price-evidence.ts";
import { resultGroup } from "../../shared/analysis.ts";
import { isResearchDeferred, photoReviewStatus } from "../../shared/photo-review.ts";
import type { Evaluation, ListingSummary, RawPrice } from "../../shared/types.ts";

const any = { minProfit: 0, minRoi: 0 };
const legacyQuote = (condition: RawPrice["condition"], price: number): RawPrice =>
    JSON.parse(JSON.stringify({ condition, price, basis: "TCGPLAYER", updatedAt: null }));
function rawReference(): Evaluation {
    const evaluation = cardEvaluation(any);
    evaluation.listing.price = 380;
    evaluation.listing.shipping = 0;
    evaluation.listing.buyingOption = "FIXED_PRICE";
    evaluation.condition!.rawCondition = "MODERATELY_PLAYED";
    evaluation.condition!.gradeRange = null;
    evaluation.rawPricing = { status: "PRICED", prices: [
        legacyQuote("LIGHTLY_PLAYED", 611.27),
        legacyQuote("MODERATELY_PLAYED", 500),
        legacyQuote("HEAVILY_PLAYED", 145),
    ] };
    evaluation.gradedPricing = {};
    return evaluation;
}
function summary(evaluation: Evaluation): ListingSummary {
    return { ...evaluation.listing, currentPrice: evaluation.listing.price, isGraded: !!evaluation.slab, images: [], bestOffer: true };
}
function slabReference(): Evaluation {
    const evaluation = rawReference();
    evaluation.condition = null;
    evaluation.rawPricing = null;
    evaluation.slab = { status: "OK", grader: "PSA", grade: "9", gradeQualifier: null, certNumber: null, certUrl: null,
        labelText: "Offline verified label", caseCondition: "Intact", reasons: [], concerns: [] };
    evaluation.slabPricing = { status: "PRICED", activeReference: { checkedAt: new Date().toISOString(), grader: "PSA", grade: "9",
        lowestTotal: 1200, resalePrice: 1080, discountRate: 0.1, listings: [{ id: "offline-reference", title: "Offline PSA 9", url: "#",
            price: 1200, shipping: 0, total: 1200, seller: { username: "offline", feedbackScore: 1000, feedbackPercentage: 100 },
            certNumber: "12345678", checkedAt: new Date().toISOString() }] } };
    return evaluation;
}

test("saved market estimates disappear without discarding photos or creating a Deal", t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("retargeting must stay offline"));
    const original = rawReference();
    const result = retargetEvaluation(original, any);
    assert.equal(result.underwriting!.verdict, "CANT_PRICE");
    assert.equal(result.underwriting!.best, null);
    assert.deepEqual(result.rawPricing?.prices, []);
    assert.equal(result.rating, null);
    assert.equal(isResearchDeferred(result), true);
    assert.equal(resultGroup(summary(result), result, true), "candidates");
    assert.equal(result.condition, original.condition);
    assert.equal(original.rawPricing!.prices!.length, 3, "original evidence is left intact");
});

test("unrelated raw sold buckets do not verify a selected condition's market estimate", () => {
    const evaluation = rawReference();
    evaluation.rawPricing!.ebayComps = [salesSummary("RAW", "UNSPECIFIED", [800, 900, 1000]), salesSummary("RAW", "NEAR_MINT", [900, 1000, 1100])];
    evaluation.rawPricing!.prices!.unshift({ condition: "NEAR_MINT", price: 1000, basis: "EBAY_SOLD", updatedAt: null,
        comps: evaluation.rawPricing!.ebayComps[1] });
    assert.equal(retargetEvaluation(evaluation, any).underwriting!.verdict, "CANT_PRICE");
});

test("a saved estimate cannot mask a verified sale at a worse raw condition", () => {
    const original = rawReference();
    original.listing.price = 80;
    original.rawPricing!.prices!.push({ condition: "HEAVILY_PLAYED", price: 200, updatedAt: null, basis: "EBAY_SOLD",
        comps: salesSummary("RAW", "HEAVILY_PLAYED", [200]) });
    const result = retargetEvaluation(original, any);
    assert.equal(result.underwriting!.verdict, "BUY_RAW");
    assert.equal(result.underwriting!.best!.priceCondition, "HEAVILY_PLAYED");
    assert.equal(resultGroup(summary(result), result), "deals");
    original.listing.price = 190;
    const losing = retargetEvaluation(original, any);
    assert.equal(losing.underwriting!.verdict, "CANT_PRICE");
    assert.match(priceEvidenceGap(losing) ?? "", /lower-condition/);
});

test("a supported independent PSA or CGC grading route can reach Deals despite a richer unsupported raw estimate", () => {
    for (const grader of ["PSA", "CGC"] as const) {
        const evaluation = rawReference();
        evaluation.condition!.gradeRange = { low: 7, likely: 7, high: 7 };
        evaluation.rawPricing!.prices!.find(quote => quote.condition === "MODERATELY_PLAYED")!.price = 2000;
        evaluation.rawPricing!.prices!.find(quote => quote.condition === "LIGHTLY_PLAYED")!.price = 2000;
        evaluation.gradedPricing = { [grader]: { status: "PRICED", byGrade: [salesSummary(grader, 7, [900, 1000, 1100])] } };
        const result = retargetEvaluation(evaluation, any);
        assert.equal(result.underwriting!.verdict, "BUY_AND_GRADE");
        assert.equal(result.underwriting!.best!.grader, grader);
        assert.equal(result.underwriting!.best!.path, "GRADE");
        assert.equal(priceEvidenceGap(result), null);
        assert.equal(isResearchDeferred(result), false);
        assert.equal(resultGroup(summary(result), result), "deals");
        assert.ok(result.rating);
    }
});

test("a losing grading route does not close an unpriced raw resale route", () => {
    const evaluation = rawReference();
    evaluation.condition!.gradeRange = { low: 7, likely: 7, high: 7 };
    evaluation.gradedPricing = { PSA: { status: "PRICED", byGrade: [salesSummary("PSA", 7, [300, 320, 340])] } };
    const result = retargetEvaluation(evaluation, any);
    assert.equal(result.underwriting!.verdict, "CANT_PRICE");
    assert.ok(result.underwriting!.paths!.some(path => path.path === "GRADE" && path.status === "PRICED" && path.profit < 0));
    assert.match(priceEvidenceGap(result) ?? "", /Raw resale still needs a matched eBay sale/);
    assert.equal(resultGroup(summary(result), result), "candidates");
});

test("already supplied sparse matched raw prices and older prices without a basis remain readable", () => {
    for (const count of [1, 2]) {
        const evaluation = rawReference();
        const quote = evaluation.rawPricing!.prices!.find(price => price.condition === "MODERATELY_PLAYED")!;
        quote.basis = "EBAY_SOLD";
        quote.comps = { ...salesSummary("RAW", "MODERATELY_PLAYED", [500, 500, 500]), count, confidence: "LOW", low: 450 };
        const result = retargetEvaluation(evaluation, any);
        assert.equal(result.underwriting!.verdict, "BUY_RAW");
        assert.ok(result.underwriting!.best!.downside! < result.underwriting!.best!.profit);
        assert.equal(resultGroup(summary(result), result), "deals");
        assert.match(result.rating!.concerns.join(" "), new RegExp(`Only ${count} verified Moderately Played raw sale`));
        delete quote.basis;
        assert.equal(retargetEvaluation(evaluation, any).underwriting!.verdict, "BUY_RAW", "unknown legacy provenance is not rewritten as a new source claim");
    }
});

test("asking-only slab references retain labeled estimates with unknown downside and cannot create a Deal", () => {
    const result = retargetEvaluation(slabReference(), any);
    assert.equal(result.underwriting!.verdict, "CANT_PRICE");
    assert.equal(result.underwriting!.best!.salePrice, 1080);
    assert.ok(result.underwriting!.best!.profit > 0);
    assert.equal(result.underwriting!.best!.downside, null);
    assert.equal(result.underwriting!.best!.downsideAtMaxBid, null);
    assert.match(result.underwriting!.reasons.join(" "), /asking references.*matched sales/);
    assert.equal(result.rating, null);
    assert.equal(resultGroup(summary(result), result, true), "candidates");
    assert.equal(isResearchDeferred(result), true);
});

test("one or two LOW confidence exact slab sales still support resale even when an asking reference is also present", () => {
    for (const count of [1, 2]) {
        const evaluation = slabReference();
        evaluation.slabPricing!.summary = { ...salesSummary("PSA", "9", [900, 1000, 1100]), count, confidence: "LOW" };
        const result = retargetEvaluation(evaluation, any);
        assert.equal(result.underwriting!.verdict, "BUY_GRADED");
        assert.equal(resultGroup(summary(result), result), "deals");
        assert.match(result.rating!.concerns.join(" "), new RegExp(`Only ${count} verified PSA 9 sale`));
        assert.match(result.rating!.strengths.join(" "), /lowest recent sale/);
        assert.doesNotMatch(result.rating!.strengths.join(" "), /competing-listing/);
    }
});

test("old saved BUY and PASS fallback advice cannot re-enter Deals or offers before retargeting", () => {
    const original = rawReference();
    original.rawPricing!.prices![1].basis = "EBAY_SOLD";
    const result = retargetEvaluation(original, any);
    result.rawPricing!.prices = rawReference().rawPricing!.prices;
    for (const verdict of ["BUY_RAW", "PASS"] as const) {
        const old = { ...result, underwriting: { ...result.underwriting!, verdict } };
        assert.equal(resultGroup(summary(old), old, true), "candidates");
        assert.equal(rateDeal(old), null);
    }
    const risky = structuredClone(result);
    risky.condition!.authenticity = { concern: "POSSIBLE", reasons: ["Readable print mismatch"] };
    assert.equal(resultGroup(summary(risky), risky), "review", "material physical risks still require attention");
    assert.equal(isResearchDeferred(risky), false);
});

test("a new deeper photo concern retains the independent price gap while routing the physical risk to review", () => {
    for (const evaluation of [slabReference()]) {
        evaluation.deeperPhotoReview = { inputKey: "offline-focused-review", reviewedAt: new Date().toISOString(),
            summary: "A new physical concern", photoNumbers: [1], findings: [{ area: "IDENTITY", impact: "NEW_CONCERN",
                observation: "The visible printing mark contradicts the accepted identity.", photoNumbers: [1] }],
            requestedPhotos: [], usage: { inputTokens: 1, outputTokens: 1 } };
        const result = retargetEvaluation(evaluation, any);
        assert.equal(result.underwriting!.verdict, "NEEDS_REVIEW");
        assert.ok(result.underwriting!.best, "the reference scenario remains inspectable");
        assert.ok(priceEvidenceGap(result), "a physical concern cannot turn the estimate into supported price evidence");
        assert.equal(resultGroup(summary(result), result, true), "review");
        assert.equal(isResearchDeferred(result), false, "the material risk remains a real review request");
        assert.equal(result.rating, null);
    }
});
