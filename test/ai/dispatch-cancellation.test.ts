import "../fixtures/mock-ai-spending.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The real SDK and limiter use a mocked transport and isolated temporary data.
// No provider request or user usage-log write is allowed in these regressions.
test("dispatch cancellation skips queued paid calls and preserves accepted answers", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-dispatch-stop-"));
    for (const [name, value] of Object.entries({ POKEMON_FLIPPER_DATA_DIR: directory, OPENAI_API_KEY: "offline-stop" })) {
        const old = process.env[name]; process.env[name] = value;
        t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
    }
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const { runStructured } = await import("../../server/ai/openai.ts");
    const { AI_REQUEST_CONCURRENCY } = await import("../../server/ai/policy.ts");
    const task = { step: "Offline cancellation fixture", prompt: "offline", photos: [], schemaName: "offline_dispatch_stop", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } };
    let calls = 0, release!: () => void, started!: () => void;
    const accepted = new Promise<void>(resolve => { started = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(globalThis, "fetch", async input => {
        assert.equal(String(input), "https://api.openai.com/v1/responses");
        if (++calls === AI_REQUEST_CONCURRENCY) started();
        await finish;
        return Response.json({ id: "offline-response", object: "response", output_text: '{"ok":true}', status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const stopAccepted = new AbortController();
    const running = Array.from({ length: AI_REQUEST_CONCURRENCY }, () => runStructured<{ ok: boolean }>({ ...task, dispatchSignal: stopAccepted.signal }));
    await accepted;
    const stopQueued = new AbortController();
    const queued = runStructured({ ...task, dispatchSignal: stopQueued.signal });
    const rejected = assert.rejects(queued, { name: "AbortError" });
    stopAccepted.abort(); stopQueued.abort(); release();
    assert.ok((await Promise.all(running)).every(answer => answer.result.ok), "accepted responses remain available for caller checkpoints");
    await rejected;
    assert.equal(calls, AI_REQUEST_CONCURRENCY, "the queued stopped request never reaches transport");

    const stoppedRetry = new AbortController(); let retries = 0;
    t.mock.method(globalThis, "fetch", async () => {
        retries++; stoppedRetry.abort();
        return Response.json({ error: { message: "offline temporary failure", type: "server_error" } }, { status: 503 });
    });
    await assert.rejects(runStructured({ ...task, dispatchSignal: stoppedRetry.signal }), { name: "AbortError" });
    assert.equal(retries, 1, "Stop prevents another paid dispatch after a temporary failure");
});


test("Stop during a pending spending reservation prevents native provider dispatch", async t => {
    const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "offline-reservation-stop";
    t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
    const { runStructured } = await import("../../server/ai/openai.ts");
    const { aiSpending } = await import("../../server/ai/spending.ts");
    const { getAiUsageContext } = await import("../../server/ai/usage-context.ts");
    let entered!: () => void, release!: () => void, providerCalls = 0, reservations = 0;
    const reserving = new Promise<void>(resolve => { entered = resolve; });
    const finishReservation = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(aiSpending, "reserve", async () => {
        reservations++; entered(); await finishReservation;
        return { ledgerId: "offline-held", searchId: "offline-held", attemptId: "offline-held" };
    });
    t.mock.method(globalThis, "fetch", async () => { providerCalls++; throw new Error("A stopped reservation must not dispatch"); });
    const stopped = new AbortController();
    const result = runStructured({ step: "Offline reservation cancellation", prompt: "Offline", photos: [],
        schemaName: "offline_reservation_stop", schema: { type: "object", properties: {}, additionalProperties: false }, dispatchSignal: stopped.signal });
    const rejected = assert.rejects(result, { name: "AbortError" });
    await reserving; stopped.abort(); release(); await rejected;
    assert.equal(providerCalls, 0); assert.equal(reservations, 1);
    assert.deepEqual(getAiUsageContext(), {}, "dispatch cancellation must not leak into usage attribution");
});
