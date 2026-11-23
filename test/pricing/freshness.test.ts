import { test } from "node:test";
import assert from "node:assert/strict";
import { PRICING_VERSION, PHOTO_REVIEW_REVISION, CONDITION_ASSESSMENT_REVISION, currentPriceEvidence } from "../../shared/pricing-freshness.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { CONDITION_RULES_VERSION } from "../../shared/conditions.ts";
import { usableSoldReference } from "../../shared/sold-evidence.ts";
test("saved photos do not make legacy or expired price evidence current", () => {
    const now = Date.parse("2026-10-30T20:00:00Z");
    const evaluation = cardEvaluation();
    assert.equal(currentPriceEvidence(evaluation, now), false);
    evaluation.pricingVersion = PRICING_VERSION;
    evaluation.pricesCheckedAt = new Date(now).toISOString();
    assert.equal(currentPriceEvidence(evaluation, now), false, "an older photo prompt cannot remain fresh solely because prices were recent");
    evaluation.assessmentVersion = `test/prompts-${PHOTO_REVIEW_REVISION}`;
    evaluation.conditionVersion = `test/condition-${CONDITION_RULES_VERSION}/prompts-${CONDITION_ASSESSMENT_REVISION}`;
    assert.equal(currentPriceEvidence(evaluation, now), true);
    evaluation.rawPricing!.printing = "FIRST_EDITION";
    assert.equal(currentPriceEvidence(evaluation, now), false, "recent prices need rechecking after a printing correction");
    evaluation.rawPricing!.printing = "UNLIMITED";
    assert.equal(currentPriceEvidence(evaluation, now), true);
    assert.equal(currentPriceEvidence(evaluation, now + 6 * 3600000), false);
    assert.equal(currentPriceEvidence(evaluation, now - 1), false);
    assert.equal(evaluation.reusedSteps.length, 0, "the marker does not alter saved photo work");
});

test("legacy raw condition prompts expire without invalidating slabs or historical condition categories", () => {
    const now = Date.parse("2026-11-01T20:00:00Z");
    const evaluation = cardEvaluation();
    Object.assign(evaluation, { pricingVersion: PRICING_VERSION, pricesCheckedAt: new Date(now).toISOString(), assessmentVersion: `test/prompts-${PHOTO_REVIEW_REVISION}`, conditionVersion: `test/condition-${CONDITION_RULES_VERSION}` });
    assert.equal(currentPriceEvidence(evaluation, now), false);
    evaluation.conditionVersion += `/prompts-${CONDITION_ASSESSMENT_REVISION}`;
    assert.equal(currentPriceEvidence(evaluation, now), true);
    delete evaluation.condition;
    evaluation.conditionVersion = "legacy-unused-for-slab";
    assert.equal(currentPriceEvidence(evaluation, now), true);
    assert.equal(CONDITION_RULES_VERSION, 1, "historical sold-category definitions did not change");
});

test("only retained special-tier graded evidence invalidates otherwise current pricing", () => {
    const now = Date.parse("2026-11-05T20:00:00Z"), evaluation = cardEvaluation();
    Object.assign(evaluation, { pricingVersion: PRICING_VERSION, pricesCheckedAt: new Date(now).toISOString(),
        assessmentVersion: `test/prompts-${PHOTO_REVIEW_REVISION}`,
        conditionVersion: `test/condition-${CONDITION_RULES_VERSION}/prompts-${CONDITION_ASSESSMENT_REVISION}` });
    const summary = evaluation.gradedPricing!.CGC!.byGrade![0];
    summary.sales[0].title = "Venusaur Base Set 15/102 CGC 6 Pristine";
    assert.equal(currentPriceEvidence(evaluation, now), false, "raw-to-grade projections must not reuse special tiers either");
    summary.sales[0].title = "Venusaur Base Set 15/102 CGC 6 EX/NM OC123";
    assert.equal(currentPriceEvidence(evaluation, now), true, "ordinary descriptions and inventory suffixes stay reusable");
    evaluation.rawPricing!.prices![0].comps = { ...summary, grader: "RAW", grade: "LIGHTLY_PLAYED",
        sales: [{ ...summary.sales[0], title: "Venusaur Base Set 15/102 Pristine raw LP" }] };
    assert.equal(currentPriceEvidence(evaluation, now), true, "raw sale-title behavior is unchanged");
});

test("saved Base Set Fourth Print evidence needs repricing even within its normal reuse window", () => {
    const now = Date.parse("2026-11-05T20:00:00Z"), evaluation = cardEvaluation();
    Object.assign(evaluation, { pricingVersion: PRICING_VERSION, pricesCheckedAt: new Date(now).toISOString(),
        assessmentVersion: `test/prompts-${PHOTO_REVIEW_REVISION}`,
        conditionVersion: `test/condition-${CONDITION_RULES_VERSION}/prompts-${CONDITION_ASSESSMENT_REVISION}` });
    const source = evaluation.gradedPricing!.CGC!.byGrade![0];
    const summary = { ...source, windowDays: 90 };
    evaluation.slabPricing = { status: "PRICED", summary };
    const reference = { recordId: 1, name: "Venusaur", set: "Base Set", cardNumber: "15/102", printing: "UNLIMITED" as const,
        finish: "HOLO" as const, grader: "CGC", grade: "6", condition: null, summary };
    assert.equal(currentPriceEvidence(evaluation, now), true);
    assert.equal(usableSoldReference(reference, true), true);
    const sale = summary.sales[0];
    sale.title = "Venusaur Base Set 15/102 CGC 6 1999–2000";
    assert.equal(currentPriceEvidence(evaluation, now), false);
    assert.equal(usableSoldReference(reference, true), false);
    sale.title = "1999 Venusaur Base Set 15/102 CGC 6 UK seller";
    assert.equal(currentPriceEvidence(evaluation, now), true);
    assert.equal(usableSoldReference(reference, true), true);
});
