import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateEvaluationStore, evaluationContextKey, PRIVATE_EVALUATION_PREFIX } from "../../server/analysis/private-evaluation.ts";
import { cacheScope } from "../../server/storage/repositories.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

test("financial snapshots use an owner-private namespace and keep full assessment provenance", async () => {
    const values = new Map<string, any>();
    const store = createPrivateEvaluationStore({ cached: async key => values.get(key) ?? null, save: async (key, value) => { values.set(key, value); } });
    const e = cardEvaluation(); e.assessmentVersion = "offline-model/bounded-prompts-1"; e.listing.photos = [1, 2, 3, 4].map(index => `https://i.ebayimg.com/images/g/${index}/s-l1600.jpg`);
    const contextKey = evaluationContextKey({ title: e.listing.title, images: e.listing.photos, aspects: e.listing.aspects });
    await store.save(e, { evidenceKey: "request-snapshot", contextKey });
    const key = [...values.keys()][0];
    assert.ok(key.startsWith(PRIVATE_EVALUATION_PREFIX));
    assert.equal(cacheScope(key, "alice"), "owner:alice"); assert.equal(cacheScope(key, "bob"), "owner:bob");
    const restored = (await store.load(e.listing.id))!;
    assert.equal(restored.evaluation.assessmentVersion, e.assessmentVersion);
    assert.equal(restored.evaluation.photoReviewKey, undefined);
    assert.deepEqual(restored.evaluation.underwriting, e.underwriting);
    restored.evaluation.listing.price = 999;
    assert.notEqual((await store.load(e.listing.id))!.evaluation.listing.price, 999);
});

test("private context distinguishes changed evidence and seller facts while accepting equivalent image URLs", () => {
    const input = { title: "Venusaur", images: ["https://i.ebayimg.com/images/g/front/s-l1600.jpg"], aspects: { Grade: "7" } };
    const key = evaluationContextKey(input);
    assert.equal(evaluationContextKey({ ...input, images: [input.images[0].replace("1600", "500")] }), key);
    assert.notEqual(evaluationContextKey({ ...input, aspects: { Grade: "8" } }), key);
    assert.notEqual(evaluationContextKey({ ...input, images: [] }), key);
    assert.notEqual(evaluationContextKey({ ...input, title: "Blastoise" }), key);
});

test("corrupt private records fail closed rather than becoming provider-cache misses", async () => {
    const store = createPrivateEvaluationStore({ cached: async () => ({ version: 1, evaluation: { listing: { id: "wrong-item" } } }) });
    await assert.rejects(store.load("expected-item"), StorageUnavailableError);
});
