import { test } from "node:test";
import assert from "node:assert/strict";
import { photoEvidence } from "../shared/photo-evidence.ts";

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
