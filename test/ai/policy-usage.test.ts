import "../fixtures/mock-ai-spending.ts";
import { isolatedDataDir } from "../fixtures/isolated-data.ts";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { aiPolicy, TEXT_MODEL, VISION_MODEL } from "../../server/ai/policy.ts";
import { trackedAiFetch, aiUsageToday } from "../../server/ai/usage.ts";

test("vision assessments receive the assessment model and room for structured photo reports; extraction stays light", () => {
    for (const step of ["photo_check", "card_condition", "focused_photo_review", "shadowless_confirmation"]) {
        assert.equal(aiPolicy(step).model, VISION_MODEL);
        assert.equal(aiPolicy(step).effort, "medium");
    }
    for (const step of ["comp_check", "marketplace_query_assistance", "listing_text_priority"]) assert.equal(aiPolicy(step).model, TEXT_MODEL);
    assert.ok(aiPolicy("photo_check").maxOutputTokens >= 8192);
});

test("AI telemetry records each transport attempt and token usage without recording paid inputs or keys", async t => {
    let attempt = 0;
    t.mock.method(globalThis, "fetch", async () => ++attempt === 1 ? new Response('{}', { status: 429 }) : new Response(JSON.stringify({ usage: { input_tokens: 300, output_tokens: 100, input_tokens_details: { cached_tokens: 200 } } }), { status: 200 }));
    const init = { headers: { Authorization: "Bearer secret-key" }, body: JSON.stringify({ model: "test-model", metadata: { app_step: "photo_check" }, input: [{ content: [{ type: "input_image", image_url: "https://private-photo" }, { type: "input_text", text: "private seller text" }] }] }) };
    await trackedAiFetch("https://api.openai.com/v1/responses", init);
    await trackedAiFetch("https://api.openai.com/v1/responses", init);
    const log = path.join(isolatedDataDir, 'ai-usage', new Date().toISOString().slice(0, 10) + '.ndjson');
    const lines = (await fs.readFile(log, 'utf8')).trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.doesNotMatch(lines.join(""), /secret-key|private-photo|private seller/);
    const total = await aiUsageToday();
    assert.equal(total.calls, 2); assert.equal(total.stages[0].failed, 1);
    assert.equal(total.stages[0].images, 2); assert.equal(total.stages[0].inputTokens, 300); assert.equal(total.stages[0].cachedInputTokens, 200);
});

test("concurrent usage polls count partial appends once and recover after log replacement", async () => {
    const log = path.join(isolatedDataDir, "ai-usage", new Date().toISOString().slice(0, 10) + ".ndjson");
    const row = JSON.stringify({ model: "fixture", step: "sales", status: 200, searchId: "fixture-owner" });
    await fs.mkdir(path.dirname(log), { recursive: true });
    await fs.writeFile(log, row + "\n" + row.slice(0, 15));
    const snapshot = () => aiUsageToday("fixture-owner");
    assert.deepEqual((await Promise.all([snapshot(), snapshot()])).map(s => s.calls), [1, 1]);
    await fs.appendFile(log, row.slice(15));
    assert.equal((await snapshot()).calls, 2);
    await fs.appendFile(log, "\n" + row + "\n");
    assert.deepEqual((await Promise.all([snapshot(), aiUsageToday()])).map(s => s.calls), [3, 3]);
    await fs.rename(log, log + ".previous");
    await fs.writeFile(log, row + "\n");
    assert.equal((await snapshot()).calls, 1);
});
