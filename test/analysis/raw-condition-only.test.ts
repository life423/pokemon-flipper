import { test } from "node:test";
import assert from "node:assert/strict";
import { applyConditionRules, moreCautious, selectConditionAssessment } from "../../server/analysis/rules.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { photoReviewStatus } from "../../shared/photo-review.ts";
import { photoEvidence } from "../../shared/photo-evidence.ts";
import { describeRange } from "../../shared/format.ts";
import { gradingRoutes } from "../../shared/card-presentation.ts";
import { meetsMinimumGrade, resultGroup } from "../../shared/analysis.ts";
import type { Condition, Evaluation } from "../../shared/types.ts";

function rawOnly(rawCondition: "DAMAGED" | "NEAR_MINT", price: number, resale: number): Evaluation {
    const evaluation = cardEvaluation();
    evaluation.listing.price = price;
    evaluation.listing.shipping = 0;
    evaluation.listing.buyingOption = "FIXED_PRICE";
    evaluation.listing.endTime = null;
    evaluation.condition!.rawCondition = rawCondition;
    evaluation.condition!.gradeRange = null;
    evaluation.rawPricing = { status: "PRICED", prices: [{ condition: rawCondition, price: resale, updatedAt: null }] };
    evaluation.gradeStatus = "RAW_CONDITION_ONLY";
    evaluation.underwriting = underwrite(evaluation, MONEY_CONFIG);
    return evaluation;
}

test("raw-condition evidence remains valid when the model explicitly cannot estimate a numeric grade", () => {
    const input = rawOnly("DAMAGED", 75.46, 15).condition!;
    input.creases = "PRESENT";
    const condition = applyConditionRules(input, "FULL", { closeUps: true });
    assert.ok(condition);
    assert.equal(condition.rawCondition, "DAMAGED");
    assert.equal(condition.gradeRange, null);
    assert.equal(input.gradeRange, null);
});

test("limited raw-condition evidence reduces confidence without inventing a numeric grade", () => {
    const input = rawOnly("DAMAGED", 75.46, 15).condition!;
    const condition = applyConditionRules(input, "LIMITED", { closeUps: true });
    assert.ok(condition);
    assert.equal(condition.rawCondition, "DAMAGED");
    assert.equal(condition.gradeRange, null);
    assert.equal(condition.confidence, "LOW");
    assert.equal(input.confidence, "HIGH", "normalization does not overwrite saved paid evidence");
});

test("an explicit absent grade differs from a missing or invalid numeric grade report", () => {
    const source = rawOnly("DAMAGED", 75.46, 15).condition!;
    for (const gradeRange of [undefined, {}, { low: 9, likely: 8, high: 7 }, { low: 1, likely: 12, high: 3 }]) {
        assert.equal(applyConditionRules({ ...source, gradeRange } as Condition, "FULL", { closeUps: true }), null);
    }
});

test("cautious opinion selection compares actual raw condition without fabricating missing grades", () => {
    const damaged = rawOnly("DAMAGED", 75.46, 15).condition!;
    const nearMint = rawOnly("NEAR_MINT", 50, 300).condition!;
    nearMint.gradeRange = { low: 7, likely: 8, high: 9 };
    assert.equal(moreCautious(damaged, nearMint), damaged);
    assert.equal(moreCautious(nearMint, damaged), damaged);
    const selected = selectConditionAssessment([nearMint, damaged], "FULL", { closeUps: true });
    assert.equal(selected?.result.rawCondition, "DAMAGED");
    assert.equal(selected?.result.gradeRange, null);
    const unsupportedNearMint = { ...nearMint, gradeRange: null };
    assert.equal(moreCautious(nearMint, unsupportedNearMint), unsupportedNearMint);
});

test("a photographed damaged raw card with no numeric grade can still be a completed priced rejection", t => {
    t.mock.method(globalThis, "fetch", () => { assert.fail("raw-only valuation must stay offline"); });
    const evaluation = rawOnly("DAMAGED", 75.46, 15);
    assert.equal(evaluation.underwriting?.verdict, "PASS");
    assert.equal(evaluation.underwriting?.best?.path, "RAW");
    assert.equal(evaluation.underwriting?.best?.profit, -75.29);
    assert.equal(evaluation.underwriting?.best?.maxBid, 0);
    assert.equal(photoReviewStatus(evaluation).needsYourReview, false, "the absent numeric estimate is a note, not a raw-resale review hold");
    assert.equal(resultGroup({ ...evaluation.listing, currentPrice: evaluation.listing.price, images: [], isGraded: false }, evaluation), null);
    assert.ok(evaluation.underwriting?.paths.filter(path => path.path === "GRADE").every(path => path.status === "UNAVAILABLE"));
});

test("a supported valuable raw resale does not require or inherit a grading estimate", () => {
    const evaluation = rawOnly("NEAR_MINT", 50, 300);
    assert.equal(evaluation.underwriting?.verdict, "BUY_RAW");
    assert.equal(evaluation.underwriting?.best?.path, "RAW");
    assert.equal(evaluation.underwriting?.best?.profit, 195.41);
    assert.equal(evaluation.condition?.gradeRange, null);
    const routes = gradingRoutes(evaluation);
    assert.equal(routes.length, 2);
    for (const route of routes) {
        assert.equal(route.range, null);
        assert.equal(route.priced, null);
        assert.match(route.reason, /not a numeric grade estimate/);
    }
    assert.equal(meetsMinimumGrade(evaluation, 0), true);
    assert.equal(meetsMinimumGrade(evaluation, 7), false, "unknown numeric quality cannot satisfy a potential-grade filter");
    assert.equal(describeRange(evaluation.condition!.gradeRange), "No numeric grade estimate");
    assert.match(photoEvidence(evaluation, 7).target, /No numeric grade estimate supports/);
});

test("known damaged raw condition keeps visibility concerns as notes while unknown condition and real conflicts need review", () => {
    const damaged = rawOnly("DAMAGED", 75.46, 15);
    damaged.photoCheck!.images = damaged.photoCheck!.images.filter(photo => photo.view !== "BACK");
    damaged.listing.photosInListing = damaged.photoCheck!.images.length;
    damaged.photoCheck!.images.filter(photo => photo.view === "FRONT").forEach(photo => { photo.obscuresCondition = true; });
    const status = photoReviewStatus(damaged);
    assert.equal(status.needsYourReview, false);
    assert.ok(status.photoNotes.includes("No usable photo shows the whole back."));
    assert.ok(status.photoNotes.includes("Every usable whole-front photo has obscured detail."));
    assert.equal(damaged.condition!.rawCondition, "DAMAGED");
    const unknown = structuredClone(damaged);
    unknown.condition!.rawCondition = "UNKNOWN";
    assert.equal(photoReviewStatus(unknown).needsYourReview, true);
    const missing = structuredClone(damaged); missing.condition = null;
    assert.equal(photoReviewStatus(missing).needsYourReview, true);
    const conflicting = structuredClone(damaged);
    conflicting.identity!.status = "NEEDS_REVIEW";
    conflicting.identity!.reasons = ["The physical collector number is unresolved."];
    assert.ok(photoReviewStatus(conflicting).reasons.includes("The physical collector number is unresolved."));
});

test("known as-is raw resale keeps additional grading visibility requests informational", () => {
    const evaluation = rawOnly("NEAR_MINT", 50, 300);
    evaluation.photoCheck!.images = evaluation.photoCheck!.images.filter(photo => photo.view !== "BACK");
    evaluation.listing.photosInListing = evaluation.photoCheck!.images.length;
    assert.equal(evaluation.underwriting?.verdict, "BUY_RAW");
    assert.equal(photoReviewStatus(evaluation).needsYourReview, false);
    assert.ok(photoReviewStatus(evaluation).photoNotes.includes("No usable photo shows the whole back."));
});
