import { test } from "node:test";
import assert from "node:assert/strict";
import { photoEvidence } from "../shared/photo-evidence.ts";
import { cardEvaluation } from "./fixtures/card-evaluation.ts";

test("upper-end potential is distinguished from the likely grade and photo confidence", () => {
    const evaluation = {
        condition: { confidence: "MEDIUM", gradeRange: { low: 4, likely: 5, high: 7 } },
        photoCheck: { images: [
            { view: "FRONT", usable: true, isStockImage: false, issues: ["White background obscures edge contrast"], obscuresCondition: true },
            { view: "BACK", usable: true, isStockImage: false, issues: [] },
            { view: "BACK", usable: false, isStockImage: true, issues: [] },
        ] },
    };
    const evidence = photoEvidence(evaluation, 7);
    assert.equal(evidence.optimistic, true);
    assert.match(evidence.target, /upper-end possibility/);
    assert.match(evidence.target, /5 is the likely estimate/);
    assert.equal(evidence.coverage, "2 usable photos: 1 front, 1 back, 0 close-ups");
    assert.equal(evidence.confidence, "MEDIUM");
    assert.match(evidence.issues[0], /White background/);
});

test("slab photo confidence survives separate review holds and never becomes raw grading confidence", () => {
    const evaluation = cardEvaluation();
    const originalCondition = structuredClone(evaluation.condition);
    evaluation.condition = null;
    evaluation.photoCheck!.holder = "GRADED_SLAB";
    evaluation.photoCheck!.confidence = "HIGH";
    evaluation.slab = { status: "NEEDS_REVIEW", grader: "PSA", grade: "5", gradeQualifier: null, certNumber: "123", certUrl: null,
        labelText: "PSA 5", caseCondition: "INTACT", reasons: ["A material label conflict remains."], concerns: [] };
    assert.equal(photoEvidence(evaluation).confidence, "HIGH");
    assert.equal(evaluation.condition, null, "reading a certified grade cannot create a raw-condition assessment");
    evaluation.slab = null;
    evaluation.photoCheck!.holder = "NONE";
    assert.equal(photoEvidence(evaluation).confidence, "UNKNOWN", "raw identity-only photos cannot imply condition confidence");
    evaluation.condition = originalCondition;
    evaluation.condition!.confidence = "LOW";
    assert.equal(photoEvidence(evaluation).confidence, "LOW", "raw condition confidence stays distinct from high photo identification confidence");
});
