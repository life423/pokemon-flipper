import { test } from "node:test";
import assert from "node:assert/strict";
import { PRICING_VERSION, PHOTO_REVIEW_REVISION, currentPriceEvidence } from "../../shared/pricing-freshness.ts";
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
    evaluation.conditionVersion = `test/condition-${CONDITION_RULES_VERSION}`;
    assert.equal(currentPriceEvidence(evaluation, now), true);
    assert.equal(currentPriceEvidence(evaluation, now + 6 * 3600000), false);
    assert.equal(currentPriceEvidence(evaluation, now - 1), false);
    assert.equal(evaluation.reusedSteps.length, 0, "the marker does not alter saved photo work");
});
