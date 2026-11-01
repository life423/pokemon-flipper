import { test } from "node:test";
import assert from "node:assert/strict";
import { PRICING_VERSION, PHOTO_REVIEW_REVISION, CONDITION_ASSESSMENT_REVISION, currentPriceEvidence } from "../../shared/pricing-freshness.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { CONDITION_RULES_VERSION } from "../../shared/conditions.ts";
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
