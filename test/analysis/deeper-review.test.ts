import { test } from "node:test";
import assert from "node:assert/strict";
import { ANALYSIS_VERSION } from "../../server/ai/openai.ts";
import { photoFingerprint } from "../../server/analysis/store.ts";
import { createDeeperPhotoReviewer, photoReviewKey, cleanDeeperAnswer } from "../../server/analysis/deeper-review.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import type { SavedRecord } from "../../server/analysis/types.ts";
import type { DeeperAnswer } from "../../server/ai/deeper-photo-review.ts";

function record(): SavedRecord {
    const evaluation = cardEvaluation();
    evaluation.photoCheck!.cardCount = "ONE";
    const photos = ["front", "back", "front-detail", "back-detail"].map((name) => `https://i.ebayimg.com/images/g/${name}/s-l1600.jpg`);
    return { itemId: "offline", version: ANALYSIS_VERSION, photoFingerprint: photoFingerprint(photos), answeredAt: "2026-10-26T12:00:00Z",
        reviewContext: { title: "Offline card", photos }, photoCheck: { result: evaluation.photoCheck!, usage: { inputTokens: 1, outputTokens: 1 } },
        assessment: { result: evaluation.condition!, setAside: [], mode: "FULL", photoNumbers: [1, 2, 3, 4] } };
}
const answer = (): DeeperAnswer => ({ summary: "Glare still hides fine surface wear.", findings: [{ area: "SURFACE", impact: "UNRESOLVED", observation: "Fine scratches cannot be resolved through the glare.", photoNumbers: [1, 3] }], requestedPhotos: ["Unobscured holo surface under angled light."] });
function fixture(review = async () => ({ result: answer(), usage: { inputTokens: 10, outputTokens: 10 } })) {
    let stored = record(); let calls = 0; let saves = 0;
    const run = createDeeperPhotoReviewer({ load: async () => structuredClone(stored), save: async (_id, next) => { stored = structuredClone(next); saves++; }, review: async () => { calls++; return review(); }, now: () => "2026-10-26T13:00:00Z" });
    return { run, key: () => photoReviewKey(stored), get: () => stored, set: (next: SavedRecord) => { stored = next; }, calls: () => calls, saves: () => saves };
}

test("duplicate clicks share one review; reopening the same saved review makes no model request", async (t) => {
    t.mock.method(globalThis, "fetch", () => { throw new Error("No network in regression"); });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture(async () => { await gate; return { result: answer(), usage: { inputTokens: 10, outputTokens: 10 } }; });
    const before = structuredClone(f.get());
    const first = f.run("offline", f.key()); const second = f.run("offline", f.key());
    assert.equal(first, second); release();
    const result = await first;
    assert.equal(f.calls(), 1); assert.equal(f.saves(), 1);
    assert.deepEqual(await f.run("offline", f.key()), result);
    assert.equal(f.calls(), 1);
    assert.deepEqual(f.get().assessment, before.assessment);
    assert.deepEqual(f.get().photoCheck, before.photoCheck);
    assert.equal(f.get().answeredAt, before.answeredAt);
});

test("stale inputs, missing context and insufficient photos are rejected before paying", async () => {
    const f = fixture();
    await assert.rejects(f.run("offline", "old-key"), /assessment changed/);
    const original = f.get();
    f.set({ ...original, reviewContext: undefined });
    await assert.rejects(f.run("offline", f.key()), /assessment changed/);
    f.set(original); f.get().photoCheck!.result.images.forEach((photo) => { photo.isStockImage = true; });
    await assert.rejects(f.run("offline", f.key()), /clear, unobscured front/);
    assert.equal(f.calls(), 0); assert.equal(f.saves(), 0);
});

test("failed review preserves the assessment and repeated retries are held without another paid call", async () => {
    const f = fixture(async () => { throw new Error("Provider unavailable"); });
    const before = structuredClone(f.get());
    await assert.rejects(f.run("offline", f.key()), /Provider unavailable/);
    await assert.rejects(f.run("offline", f.key()), /Wait 30 seconds/);
    assert.deepEqual(f.get(), before); assert.equal(f.calls(), 1); assert.equal(f.saves(), 0);
});

test("a failed disk write retries the saved answer without another paid request", async () => {
    let stored = record(); let calls = 0; let writes = 0;
    const before = structuredClone(stored);
    const run = createDeeperPhotoReviewer({ load: async () => structuredClone(stored), save: async (_id, next) => {
        writes++;
        if (writes === 1) throw new Error("Disk temporarily unavailable");
        stored = structuredClone(next);
    }, review: async () => { calls++; return { result: answer(), usage: { inputTokens: 10, outputTokens: 10 } }; } });
    const key = photoReviewKey(stored);
    await assert.rejects(run("offline", key), /Disk temporarily unavailable/);
    assert.deepEqual(stored, before);
    const saved = await run("offline", key);
    assert.equal(calls, 1); assert.equal(writes, 2);
    assert.deepEqual(stored.deeperPhotoReview, saved);
    assert.deepEqual(stored.assessment, before.assessment);
});

test("a newer baseline wins when a full assessment changes during a deeper review", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture(async () => { await gate; return { result: answer(), usage: { inputTokens: 10, outputTokens: 10 } }; });
    const pending = f.run("offline", f.key());
    // Let the reviewer load and enter the paid-operation stub.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const newer = structuredClone(f.get()); newer.assessment!.result.gradeRange = { low: 2, likely: 3, high: 4 }; f.set(newer);
    release(); await assert.rejects(pending, /newer assessment was kept/);
    assert.deepEqual(f.get(), newer); assert.equal(f.saves(), 0);
});

test("photo citations are mapped back to listing numbers and invalid references fail closed", () => {
    assert.deepEqual(cleanDeeperAnswer(answer(), [4, 7, 9]).findings[0].photoNumbers, [4, 9]);
    const invalid = answer(); invalid.findings[0].photoNumbers = [8];
    assert.throws(() => cleanDeeperAnswer(invalid, [4, 7, 9]), /incomplete photo review/);
    const noEvidence = answer(); noEvidence.findings[0].photoNumbers = [];
    assert.throws(() => cleanDeeperAnswer(noEvidence, [4, 7, 9]), /incomplete photo review/);
});

test("focused comparison uses code-limited prior confidence, not an optimistic raw cached answer", async () => {
    const stored = record();
    stored.photoCheck!.result.images = [stored.photoCheck!.result.images[0]];
    stored.assessment!.result.confidence = "HIGH";
    let compared = false;
    const run = createDeeperPhotoReviewer({ load: async () => structuredClone(stored), save: async () => {}, review: async (input) => {
        compared = true;
        assert.equal(input.condition?.confidence, "LOW");
        assert.equal(input.condition?.gradeRange.likely, null);
        const result = answer(); result.findings[0].photoNumbers = [1];
        return { result, usage: { inputTokens: 1, outputTokens: 1 } };
    } });
    await run("offline", photoReviewKey(stored));
    assert.equal(compared, true);
    assert.equal(stored.assessment!.result.confidence, "HIGH", "cached source is not mutated");
});

test("saved review keys track changed photos/assessment, but not the addition of their saved second opinion", async () => {
    const f = fixture(); const originalKey = f.key();
    await f.run("offline", originalKey);
    assert.equal(f.key(), originalKey);
    const baseline = structuredClone(f.get());
    f.get().assessment!.result.gradeRange.high = 9;
    assert.notEqual(f.key(), originalKey);
    f.set(baseline); f.get().photoFingerprint = "changed-photo-list";
    await assert.rejects(f.run("offline", f.key()), /assessment changed/);
    assert.equal(f.calls(), 1);
});
