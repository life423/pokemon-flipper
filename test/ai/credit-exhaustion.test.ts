import "../fixtures/mock-ai-spending.ts";
import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AiCreditsError, createAiCreditGate, isAiCreditFailure } from "../../server/ai/errors.ts";
import { evaluationFailure } from "../../server/analysis/failure.ts";
import { ProviderError } from "../../server/lib/http.ts";
import { runStructured } from "../../server/ai/openai.ts";
import fs from "node:fs/promises";

const quota = { status: 429, code: "credit_balance_exhausted", type: "insufficient_quota" };
test("credit exhaustion survives wrapped causes and is not presented or retried as a temporary rate limit", () => {
    const wrapped = new ProviderError("Rate limited", { cause: quota });
    assert.equal(isAiCreditFailure(wrapped), true);
    const result = evaluationFailure(wrapped);
    assert.equal(result.retryable, false); assert.equal(result.code, "AI_CREDITS"); assert.match(result.error, /credits are exhausted/);
    assert.equal(evaluationFailure({ status: 429, code: "rate_limit_exceeded" }).retryable, true);
});
test("queued AI work stops at account exhaustion and can probe again after funding becomes available", () => {
    let at = 1000; const gate = createAiCreditGate(() => at);
    assert.throws(() => gate.reject(quota), AiCreditsError);
    assert.throws(() => gate.check(), AiCreditsError);
    at += 31_000; assert.doesNotThrow(() => gate.check());
    assert.doesNotThrow(() => gate.reject({ status: 429, code: "rate_limit_exceeded" }));
});
test("temporary provider throttling still retries and returns a complete structured answer", async t => {
    const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "offline-retry-test";
    t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
    t.mock.method(fs, "mkdir", async () => undefined); t.mock.method(fs, "appendFile", async () => undefined);
    let attempts = 0;
    t.mock.method(globalThis, "fetch", async () => ++attempts === 1
        ? Response.json({ error: { message: "Temporary rate limit", type: "rate_limit_exceeded", code: "rate_limit_exceeded" } }, { status: 429, headers: { "retry-after": "0.001" } })
        : Response.json({ id: "resp_offline", object: "response", status: "completed", output: [{ id: "message_offline", type: "message", role: "assistant", content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1 } }));
    const result = await runStructured<{ ok: boolean }>({ step: "Offline retry test", schemaName: "search_intent", prompt: "Offline fixture", photos: [], schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } });
    assert.equal(result.result.ok, true); assert.equal(attempts, 2);
});
test("real SDK transport never retries an exhausted balance, and subsequent queued work sends no request", async t => {
    const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "offline-credit-test";
    t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
    let attempts = 0;
    t.mock.method(fs, "mkdir", async () => undefined);
    t.mock.method(fs, "appendFile", async () => undefined);
    t.mock.method(globalThis, "fetch", async () => { attempts++; return Response.json({ error: { message: "You have no credits remaining", type: "insufficient_quota", code: "credit_balance_exhausted" } }, { status: 429 }); });
    const request = () => runStructured({ step: "Offline credit test", schemaName: "search_intent", prompt: "Offline fixture", photos: [], schema: { type: "object", properties: {}, additionalProperties: false } });
    await assert.rejects(request(), AiCreditsError);
    await assert.rejects(request(), AiCreditsError);
    assert.equal(attempts, 1);
});
