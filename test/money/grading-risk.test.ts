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

test("a sparse nonmonotonic Umbreon cannot supply grading or offer advice under Any/Any", (t) => {
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
    const path = corrected.underwriting?.paths.find((entry) => entry.grader === "PSA");
    assert.equal(path?.status, "UNAVAILABLE");
    assert.match(path?.status === "UNAVAILABLE" ? path.reason : "", /No verified sales at grade 2/);
    assert.equal(corrected.underwriting?.best?.path, "RAW");
    assert.ok(corrected.underwriting!.best!.profit < 0);
    assert.equal(corrected.underwriting?.verdict, "PASS");
    assert.equal(corrected.rating, null);
    const listing = { ...evaluation.listing, currentPrice: evaluation.listing.price, isGraded: false, images: [], bestOffer: true };
    assert.equal(resultGroup(listing, corrected, false), null);
    assert.equal(resultGroup(listing, corrected, true), null, "unsupported grading cannot create a hypothetical offer");
    assert.equal(corrected.condition, evaluation.condition, "saved photos and grades are reused");
});

test("a missing grade never inherits an observed lower-grade premium to create a buy", () => {
    const evaluation = cardEvaluation(any);
    evaluation.listing.price = 1000;
    evaluation.listing.shipping = 0;
    evaluation.rawPricing = null;
    evaluation.gradedPricing = { PSA: { status: "PRICED", byGrade: [salesSummary("PSA", 6, [2000, 2000, 2000]), salesSummary("PSA", 8, [1000, 1000, 1000])] } };
    const blocked = retargetEvaluation(evaluation, any);
    assert.equal(blocked.underwriting?.verdict, "CANT_PRICE");
    assert.equal(blocked.underwriting?.best, null);
    evaluation.gradedPricing.PSA!.byGrade!.push(salesSummary("PSA", 7, [1000, 1000, 1000]));
    const supported = retargetEvaluation(evaluation, any);
    assert.equal(supported.underwriting?.verdict, "PASS");
    assert.equal(supported.underwriting?.best?.profit, -214.5);
    assert.equal(supported.underwriting?.best?.maxBid, 801);
    assert.ok(priced(supported).outlook?.every((entry) => entry.filledFrom === null));
    evaluation.rawPricing = { status: "PRICED", prices: [{ condition: "LIGHTLY_PLAYED", price: 2000, updatedAt: null }] };
    evaluation.gradedPricing.PSA!.byGrade = evaluation.gradedPricing.PSA!.byGrade!.filter((entry) => entry.grade !== 7);
    assert.equal(retargetEvaluation(evaluation, any).underwriting?.verdict, "BUY_RAW", "an independent supported raw route still works");
});
