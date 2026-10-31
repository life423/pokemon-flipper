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
    for (const step of ["comp_check", "title_readings", "search_intent", "photo_card"]) assert.equal(aiPolicy(step).model, TEXT_MODEL);
    assert.ok(aiPolicy("photo_check").maxOutputTokens >= 8192);
});

test("AI telemetry records each transport attempt and token usage without recording paid inputs or keys", async t => {
    const lines: string[] = [];
    t.mock.method(fs, "mkdir", async () => undefined);
    t.mock.method(fs, "appendFile", async (_path, content) => { lines.push(String(content)); });
    t.mock.method(fs, "readFile", async () => lines.join(""));
    let attempt = 0;
    t.mock.method(globalThis, "fetch", async () => ++attempt === 1 ? new Response('{}', { status: 429 }) : new Response(JSON.stringify({ usage: { input_tokens: 300, output_tokens: 100, input_tokens_details: { cached_tokens: 200 } } }), { status: 200 }));
    const init = { headers: { Authorization: "Bearer secret-key" }, body: JSON.stringify({ model: "test-model", metadata: { app_step: "photo_check" }, input: [{ content: [{ type: "input_image", image_url: "https://private-photo" }, { type: "input_text", text: "private seller text" }] }] }) };
    await trackedAiFetch("https://api.openai.com/v1/responses", init);
    await trackedAiFetch("https://api.openai.com/v1/responses", init);
    assert.equal(lines.length, 2);
    assert.doesNotMatch(lines.join(""), /secret-key|private-photo|private seller/);
    const total = await aiUsageToday();
    assert.equal(total.calls, 2); assert.equal(total.stages[0].failed, 1);
    assert.equal(total.stages[0].images, 2); assert.equal(total.stages[0].inputTokens, 300); assert.equal(total.stages[0].cachedInputTokens, 200);
});
