import { test } from "node:test";
import assert from "node:assert/strict";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { resultGroup } from "../../shared/analysis.ts";
import type { Grader, PricedPath } from "../../shared/types.ts";

const any = { minProfit: 0, minRoi: 0 };
function nonmonotonic(grader: Grader = "PSA", prices = [2000, 1000, 1400]) {
    const evaluation = cardEvaluation(any);
    evaluation.rawPricing = null;
    evaluation.gradedPricing = { [grader]: { status: "PRICED", byGrade: prices.map((price, i) => salesSummary(grader, 6 + i, [price, price, price])) } };
    evaluation.underwriting = underwrite(evaluation, { ...MONEY_CONFIG, targets: any });
    return evaluation;
}
function priced(evaluation: ReturnType<typeof cardEvaluation>, grader: Grader = "PSA"): PricedPath {
    const path = evaluation.underwriting?.paths.find((entry) => entry.grader === grader);
    assert.equal(path?.status, "PRICED");
    return path as PricedPath;
}

test("every grading scenario is covered by the service tier, even when a lower grade is worth more", () => {
    for (const [grader, prices, tier, fee] of [
        ["PSA", [2000, 1000, 1400], "Express", 175],
        ["CGC", [4000, 500, 900], "Express", 100],
    ] as const) {
        const path = priced(nonmonotonic(grader, [...prices]), grader);
        assert.equal(path.tier, tier, grader);
        assert.equal(path.gradingFee, fee, grader);
    }
});

test("a lower-grade value above every service cap leaves the grading route unavailable", () => {
    const evaluation = nonmonotonic();
    const grading = { ...MONEY_CONFIG.grading, PSA: [{ tier: "Capped", fee: 80, maxDeclaredValue: 1499 }] };
    const result = underwrite(evaluation, { ...MONEY_CONFIG, targets: any, grading });
    const path = result.paths.find((entry) => entry.grader === "PSA");
    assert.equal(path?.status, "UNAVAILABLE");
    assert.match(path?.status === "UNAVAILABLE" ? path.reason : "", /\$2,000\.00/);
});

test("percentage grading fees use the maximum modeled value too", () => {
    const path = priced(nonmonotonic("CGC", [500000, 500, 900]), "CGC");
    assert.equal(path.tier, "Unlimited Value");
    assert.equal(path.gradingFee, 5300);
});

test("modeled downside uses the minimum net proceeds, at both asking and the bid limit", () => {
    const path = priced(nonmonotonic());
    assert.ok(path.outlook && path.costAtMaxBid !== null);
    const minimum = Math.min(...path.outlook.map((outcome) => outcome.net));
    assert.equal(path.outlook.find((outcome) => outcome.net === minimum)?.grade, 7);
    assert.equal(path.downside, Number((minimum - path.cost).toFixed(2)));
    assert.equal(path.downsideAtMaxBid, Number((minimum - path.costAtMaxBid).toFixed(2)));
    assert.ok(path.downside <= path.profit);
});

test("the saved Umbreon pricing shape becomes a pass under Any/Any without fetching or changing the photo estimate", (t) => {
    t.mock.method(globalThis, "fetch", () => { throw new Error("regression must stay offline"); });
    const evaluation = cardEvaluation(any);
    evaluation.listing.price = 999;
    evaluation.listing.shipping = 6.56;
    evaluation.listing.buyingOption = "FIXED_PRICE";
    evaluation.condition!.gradeRange = { low: 1, likely: null, high: 5 };
    evaluation.condition!.confidence = "LOW";
    evaluation.condition!.rawCondition = "DAMAGED";
    evaluation.rawPricing = { status: "PRICED", prices: [{ condition: "DAMAGED", price: 958.5, updatedAt: null }] };
    evaluation.gradedPricing = { PSA: { status: "PRICED", byGrade: [1739.04, null, 1112.5, 1267.5, 1395].map((price, i) => ({ ...salesSummary("PSA", i + 1), median: price, count: price === null ? 0 : 3 })) } };
    const corrected = retargetEvaluation(evaluation, any);
    const path = priced(corrected);
    assert.equal(path.tier, "Express");
    assert.ok(path.profit < 0);
    assert.ok(path.downside < path.profit);
    assert.equal(corrected.underwriting?.verdict, "PASS");
    assert.equal(corrected.rating, null);
    const listing = { ...evaluation.listing, currentPrice: evaluation.listing.price, isGraded: false, images: [], bestOffer: true };
    assert.equal(resultGroup(listing, corrected, false), null);
    assert.equal(resultGroup(listing, corrected, true), "offers", "a hypothetical offer remains separate from a deal at asking");
    assert.equal(corrected.condition, evaluation.condition, "saved photos and grades are reused");
    assert.deepEqual(path.outlook?.map((outcome) => outcome.probability), [0.2, 0.2, 0.2, 0.2, 0.2]);
    assert.equal(path.outlook?.[1].filledFrom, 1, "existing sparse-price assumptions stay explicit");
});
