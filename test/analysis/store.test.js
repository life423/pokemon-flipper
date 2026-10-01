import { test } from "node:test";
import assert from "node:assert/strict";
import {
    photoFingerprint,
    reusableRecord,
    assessmentStillFits,
} from "../../server/analysis/store.js";

const urls = [
    "https://i.ebayimg.com/images/g/a/s-l1600.jpg",
    "https://i.ebayimg.com/images/g/b/s-l1600.jpg",
];

const current = { version: "model/prompts-1", fingerprint: photoFingerprint(urls) };

function saved(overrides = {}) {
    return {
        version: "model/prompts-1",
        photoFingerprint: photoFingerprint(urls),
        photoCheck: { result: {}, usage: {} },
        assessment: null,
        ...overrides,
    };
}

test("the same photos give the same fingerprint; changed or reordered photos don't", () => {
    assert.equal(photoFingerprint(urls), photoFingerprint([...urls]));
    assert.notEqual(photoFingerprint(urls), photoFingerprint([...urls].reverse()));
    assert.notEqual(photoFingerprint(urls), photoFingerprint([urls[0]]));
});

test("a saved answer is reused when the photos, model, and prompts match", () => {
    const record = saved();
    assert.equal(reusableRecord(record, current), record);
});

test("a saved answer is redone when the photos, model, or prompts change", () => {
    assert.equal(reusableRecord(null, current), null);
    assert.equal(reusableRecord(saved({ version: "model/prompts-2" }), current), null);
    assert.equal(reusableRecord(saved({ photoFingerprint: "different" }), current), null);
    assert.equal(reusableRecord(saved({ photoCheck: null }), current), null);
});

test("a saved condition answer fits only the same mode and photos", () => {
    const assessment = { mode: "FULL", photoNumbers: [1, 2] };

    assert.equal(assessmentStillFits(assessment, "FULL", [1, 2]), true);
    assert.equal(assessmentStillFits(assessment, "LIMITED", [1, 2]), false);
    assert.equal(assessmentStillFits(assessment, "FULL", [1]), false);
    assert.equal(assessmentStillFits(null, "FULL", [1, 2]), false);
});
