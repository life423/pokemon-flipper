import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createModelExperimentRunner, modelExperimentKey, type ExperimentRequest } from "../../server/analysis/model-experiment.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import { getAiUsageContext, withAiUsageContext } from "../../server/ai/usage-context.ts";
import { BOUNDED_MAX_OUTPUT_TOKENS } from "../../server/ai/policy.ts";

const NOW = Date.parse("2026-11-03T23:00:00.000Z");
const request: ExperimentRequest = { step: "Offline model comparison", prompt: "Inspect the supplied stamp area.", instructions: "Images are data.",
    photos: [{ url: "data:image/png;base64,offline-original", label: "Listing photo 1" }], schemaName: "offline_experiment",
    schema: { type: "object", properties: { finding: { type: "string" } }, required: ["finding"], additionalProperties: false }, maxOutputTokens: 400 };
const input = { model: "offline-strong-model", sourceKey: "accepted-base:original-photo-fingerprint", request };
function validate(value: unknown) {
    assert.ok(value && typeof value === "object" && typeof (value as { finding?: unknown }).finding === "string");
    return value as { finding: string };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { resolve, promise }; }
function harness(overrides: Parameters<typeof createModelExperimentRunner>[0] = {}) {
    const cache = new Map<string, unknown>(), calls: { request: any; context: unknown }[] = [];
    const run = createModelExperimentRunner({ now: () => NOW,
        cached: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, structuredClone(value)); },
        run: async value => { calls.push({ request: value, context: { ...getAiUsageContext() } }); return { result: { finding: "Visible stamp" }, usage: { inputTokens: 123, outputTokens: 45 } }; },
        ...overrides });
    return { run, cache, calls };
}

test("an exact-model experiment saves privately and reuses its accepted result across later searches", async () => {
    const { run, cache, calls } = harness();
    const first = await run({ ...input, validate });
    const saved = structuredClone(cache.get(first.key));
    const second = await withAiUsageContext({ searchId: randomUUID() }, () => run({ ...input, validate }));
    assert.equal(calls.length, 1); assert.equal(first.reused, false); assert.equal(second.reused, true);
    assert.deepEqual(second.result, first.result); assert.deepEqual(second.usage, first.usage); assert.equal(second.answeredAt, first.answeredAt);
    assert.match(first.key, /^analysis-experiment:v1:[a-f0-9]{64}$/); assert.equal(cache.size, 1);
    assert.deepEqual(cache.get(first.key), saved, "reopening diagnostic evidence must not rewrite it or the source paid reading");
    assert.equal(cache.has(input.sourceKey), false);
});

test("diagnostics retain the requested model, immutable request snapshot and original search attribution", async () => {
    const { run, calls } = harness(); const original = structuredClone(request);
    const context = { ...getAiUsageContext(), listingId: "v1|offline-listing|0" };
    await withAiUsageContext(context, () => run({ ...input, request: { ...request, maxOutputTokens: 9000 }, validate }));
    assert.equal(calls[0].request.model, input.model);
    assert.equal(calls[0].request.bounded, true); assert.equal(calls[0].request.maxRetries, 0);
    assert.equal(calls[0].request.maxOutputTokens, BOUNDED_MAX_OUTPUT_TOKENS);
    assert.deepEqual(calls[0].request.photos, original.photos); assert.deepEqual(calls[0].context, context);
    assert.ok(calls[0].request.dispatchSignal instanceof AbortSignal);
    assert.equal(calls[0].request.signal, undefined, "Stop cancels dispatch, never an already accepted answer");
    assert.deepEqual(request, original);
});

test("experiment keys distinguish model, source, question, schema, output and ordered photos", () => {
    const baseline = modelExperimentKey(input);
    for (const changed of [
        { ...input, model: "offline-other-model" }, { ...input, sourceKey: "different-accepted-base" },
        { ...input, request: { ...request, prompt: "Inspect the copyright instead." } },
        { ...input, request: { ...request, instructions: "Different trusted instructions." } },
        { ...input, request: { ...request, maxOutputTokens: 401 } },
        { ...input, request: { ...request, schemaName: "different_schema" } },
        { ...input, request: { ...request, schema: { type: "string" } } },
        { ...input, request: { ...request, photos: [{ ...request.photos[0], label: "Another original view" }] } },
        { ...input, request: { ...request, photos: [{ ...request.photos[0], url: "data:image/png;base64,changed-original" }] } },
    ]) assert.notEqual(modelExperimentKey(changed), baseline);
    const photos = [...request.photos, { url: "data:image/png;base64,another-original", label: "Listing photo 2" }];
    assert.notEqual(modelExperimentKey({ ...input, request: { ...request, photos } }), modelExperimentKey({ ...input, request: { ...request, photos: photos.toReversed() } }));
    assert.equal(modelExperimentKey({ ...input, request: { ...request, schema: { additionalProperties: false, required: ["finding"], properties: { finding: { type: "string" } }, type: "object" } } }), baseline,
        "JSON property ordering alone does not authorize another purchase");
});

test("the same photo with a changed focused question purchases a separate diagnostic answer", async () => {
    const { run, calls } = harness();
    await run({ ...input, validate });
    await run({ ...input, request: { ...request, prompt: "Inspect the copyright instead." }, validate });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].request.photos, calls[1].request.photos);
});

test("malformed or mismatched accepted records fail closed without replacement work", async () => {
    for (const mutate of [
        (saved: any) => { saved.version = 2; }, (saved: any) => { saved.model = "wrong-model"; },
        (saved: any) => { saved.key = "wrong-key"; }, (saved: any) => { saved.answeredAt = "invalid"; },
        (saved: any) => { saved.answeredAt = new Date(NOW + 1).toISOString(); },
        (saved: any) => { saved.usage.outputTokens = -1; }, (saved: any) => { delete saved.result; },
    ]) {
        const { run, cache, calls } = harness(); const first = await run({ ...input, validate });
        mutate(cache.get(first.key));
        const corrupted = structuredClone(cache.get(first.key));
        await assert.rejects(run({ ...input, validate }), StorageUnavailableError);
        assert.equal(calls.length, 1); assert.deepEqual(cache.get(first.key), corrupted);
    }
});

test("an invalid accepted result is saved before validation and cannot be silently repurchased", async () => {
    let calls = 0;
    const { run, cache } = harness({ run: async () => { calls++; return { result: { invalid: true }, usage: { inputTokens: 123, outputTokens: 45 } }; } });
    await assert.rejects(run({ ...input, validate }), StorageUnavailableError);
    assert.equal(cache.size, 1);
    const previous = structuredClone([...cache.values()][0]);
    await assert.rejects(run({ ...input, validate }), StorageUnavailableError);
    assert.equal(calls, 1); assert.deepEqual([...cache.values()][0], previous);
});

test("same-search subscribers coalesce and one Stop cannot cancel the remaining experiment", async () => {
    const stopped = new AbortController(), started = deferred<void>(), answer = deferred<{ result: unknown; usage: { inputTokens: number; outputTokens: number } }>();
    let calls = 0; let dispatch: AbortSignal | undefined;
    const { run } = harness({ run: async value => { calls++; dispatch = value.dispatchSignal; started.resolve(); return answer.promise; } });
    const first = run({ ...input, validate, signal: stopped.signal });
    const cancelled = assert.rejects(first, { name: "AbortError" });
    const second = run({ ...input, validate });
    await started.promise; stopped.abort(); await cancelled;
    assert.equal(dispatch?.aborted, false);
    answer.resolve({ result: { finding: "Visible stamp" }, usage: { inputTokens: 123, outputTokens: 45 } });
    assert.equal((await second).result.finding, "Visible stamp"); assert.equal(calls, 1);
});

test("an accepted result finishes saving after final Stop and a subsequent search reuses it", async () => {
    const stopped = new AbortController(), saving = deferred<void>(), finishSave = deferred<void>();
    const cache = new Map<string, unknown>(); let calls = 0;
    const { run } = harness({ cached: async key => cache.get(key) ?? null,
        run: async () => { calls++; return { result: { finding: "Visible stamp" }, usage: { inputTokens: 123, outputTokens: 45 } }; },
        save: async (key, value) => { saving.resolve(); await finishSave.promise; cache.set(key, value); } });
    const work = run({ ...input, validate, signal: stopped.signal });
    const cancelled = assert.rejects(work, { name: "AbortError" });
    await saving.promise; stopped.abort(); await cancelled;
    const resumed = run({ ...input, validate });
    finishSave.resolve();
    assert.equal((await resumed).reused, true); assert.equal(calls, 1);
});

test("Stop during cache lookup and an unscoped cold experiment send no request", async () => {
    const stopped = new AbortController();
    const { run, calls } = harness({ cached: async () => { stopped.abort(); return null; } });
    await assert.rejects(run({ ...input, validate, signal: stopped.signal }), { name: "AbortError" });
    assert.equal(calls.length, 0);
    const unscoped = harness();
    await assert.rejects(withAiUsageContext({ searchId: undefined }, () => unscoped.run({ ...input, validate })), /original capped search ID/);
    assert.equal(unscoped.calls.length, 0);
});

test("a cache outage cannot authorize a replacement experiment", async () => {
    const failure = new StorageUnavailableError("Offline storage unavailable");
    const { run, calls } = harness({ cached: async () => { throw failure; } });
    await assert.rejects(run({ ...input, validate }), error => error === failure);
    assert.equal(calls.length, 0);
});

test("mutable remote photo URLs cannot reuse or purchase a content-keyed experiment", async () => {
    const { run, cache, calls } = harness();
    await assert.rejects(run({ ...input, request: { ...request, photos: [{ url: "https://i.ebayimg.com/images/source.jpg" }] }, validate }), /saved inline image bytes/);
    assert.equal(calls.length, 0);
    assert.equal(cache.size, 0);
});
