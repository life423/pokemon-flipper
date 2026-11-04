import { isolatedDataDir } from "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { validateComparisonManifest, prepareComparisonInputs, compareManualFields, compareSavedModels, type ComparisonCase, type PreparedCase } from "../../scripts/compare-saved-models.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

function item(index = 0): ComparisonCase {
    const evaluation = cardEvaluation(), id = `v1|${123456789012 + index}|0`, searchId = "12345678-1234-4234-8234-123456789012";
    return { caseId: `offline-${index}`, listingId: id, originalSearchId: searchId, listingDetails: { id } as any, sourceImages: [], crops: [],
        baseline: { derivedAcceptedCacheKey: "bounded-assessment:offline", savedPhotoCheck: evaluation.photoCheck!, sourceFile: "offline.json", jsonPointer: "/evaluation",
            requestTelemetry: [{ searchId, listingId: id, status: 200, at: "2026-11-03T20:00:00.000Z", model: "gpt-5.6-luna", inputHash: "a".repeat(64) }] },
        manualLabels: { holder: "GRADED_SLAB", gradeLabel: "NM", gradeQualifier: null, grade: "7", cardNumber: "4/102",
            resolvableFields: ["gradeLabel", "gradeQualifier", "grade", "cardNumber"] },
        experimentAdmission: { searchId, useOriginalSearchOnly: true } };
}
const prepared = (source: ComparisonCase): PreparedCase => ({ caseId: source.caseId, kind: "SLAB_LABEL", images: [{ number: 1, url: "https://example.invalid/front.jpg", localFile: "offline.jpg", sha256: "b".repeat(64) }] });

test("comparison manifests admit one through twelve cases and reject oversized, duplicate or borrowed scopes", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("manifest validation is local"));
    for (const count of [1, 2, 8, 12]) assert.doesNotThrow(() => validateComparisonManifest({ version: 1, cases: Array.from({ length: count }, (_, index) => item(index)) }));
    for (const cases of [[], Array.from({ length: 13 }, (_, index) => item(index)), [item(), item()]]) assert.throws(() => validateComparisonManifest({ version: 1, cases }), /1–12 distinct/);
    for (const change of [
        (source: ComparisonCase) => { source.originalSearchId = "not-a-uuid"; },
        (source: ComparisonCase) => { source.experimentAdmission.searchId = "12345678-1234-4234-8234-123456789013"; },
        (source: ComparisonCase) => { source.baseline.requestTelemetry[0].listingId = "another-listing"; },
        (source: ComparisonCase) => { source.baseline.requestTelemetry[0].searchId = "12345678-1234-4234-8234-123456789013"; },
        (source: ComparisonCase) => { source.baseline.requestTelemetry = []; },
    ]) {
        const source = item(); change(source);
        assert.throws(() => validateComparisonManifest({ version: 1, cases: [source] }), /original paid listing\/search history/);
    }
    await assert.rejects(compareSavedModels(["--live", "--replay"]), /exactly one/);
});

test("ordinary slab grade wording is unmeasured while raw and normalized qualifier disagreements remain visible", () => {
    const source = item(), evaluation = cardEvaluation();
    evaluation.photoCheck!.slab = { present: true, grader: "PSA", grade: "7", gradeQualifier: "NM", certNumber: "12345678", labelText: "PSA NM 7",
        caseCondition: "INTACT", authenticity: "NONE_SEEN", concerns: [] };
    evaluation.photoCheck!.cardIdentity = { name: "Charizard", set: "Base Set", cardNumber: "004/102", language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Offline readable name"] };
    const raw = compareManualFields(source, evaluation, "SLAB_LABEL"), normalized = compareManualFields(source, evaluation, "SLAB_LABEL", true);
    assert.deepEqual(raw.find(row => row.field === "gradeLabel"), { field: "gradeLabel", expected: "NM", actual: null, measurement: "UNMEASURED", matches: null });
    assert.equal(raw.find(row => row.field === "gradeQualifier")?.matches, false);
    assert.equal(normalized.find(row => row.field === "gradeQualifier")?.matches, true);
    assert.equal(normalized.find(row => row.field === "cardNumber")?.matches, true);
    assert.equal(evaluation.photoCheck!.slab.gradeQualifier, "NM", "diagnostic normalization cannot alter the retained model transcription");
    evaluation.photoCheck!.slab.gradeQualifier = "OC";
    assert.equal(compareManualFields(source, evaluation, "SLAB_LABEL", true).find(row => row.field === "gradeQualifier")?.matches, false, "real qualifiers cannot disappear into ordinary wording");
});

test("focused stamp comparisons never score unrelated manual label fields", () => {
    const source = item(); source.manualLabels.firstEditionStamp = "VISIBLE";
    assert.deepEqual(compareManualFields(source, { stamp: "VISIBLE" }, "STAMP"), [{ field: "firstEditionStamp", expected: "VISIBLE", actual: "VISIBLE", measurement: "MEASURED", matches: true }]);
});

test("interrupted input preparation retains finished cases and resumes without preparing them twice", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("the checkpoint workflow must use injected preparation only"));
    const file = path.join(isolatedDataDir, "partial-comparison.json"), cases = [item(), item(1), item(2)], calls: string[] = [];
    let interrupted = true;
    const prepare = async (source: ComparisonCase) => { calls.push(source.caseId); if (source.caseId === cases[1].caseId && interrupted) throw new Error("Offline preparation interrupted"); return prepared(source); };
    await assert.rejects(prepareComparisonInputs(file, cases, "a".repeat(64), { replay: false, prepare, validate: async () => {} }), /interrupted/);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).cases.map((row: PreparedCase) => row.caseId), [cases[0].caseId]);
    interrupted = false;
    const result = await prepareComparisonInputs(file, cases, "a".repeat(64), { replay: false, prepare, validate: async () => {} });
    assert.equal(result.cases.length, 3); assert.equal(calls.filter(id => id === cases[0].caseId).length, 1);
    const original = await fs.readFile(file, "utf8");
    await prepareComparisonInputs(file, cases, "a".repeat(64), { replay: true, prepare: async () => assert.fail("replay cannot prepare images"), validate: async () => {} });
    assert.equal(await fs.readFile(file, "utf8"), original, "replay does not rewrite prepared inputs");
});

test("replay rejects partial or changed manifests before any image preparation", async () => {
    const file = path.join(isolatedDataDir, "incomplete-comparison.json"), cases = [item(), item(1)];
    await fs.writeFile(file, JSON.stringify({ version: 1, manifestSha256: "a".repeat(64), cases: [prepared(cases[0])] }));
    const options = { replay: true, prepare: async () => assert.fail("replay cache miss cannot download or dispatch"), validate: async () => {} };
    await assert.rejects(prepareComparisonInputs(file, cases, "a".repeat(64), options), /complete prepared inputs/);
    await assert.rejects(prepareComparisonInputs(file, cases, "c".repeat(64), options), /do not match/);
});
