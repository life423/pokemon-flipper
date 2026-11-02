import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runStructured } from "../../server/ai/openai.ts";
import { aiSpending } from "../../server/ai/spending.ts";
import { withAiUsageContext } from "../../server/ai/usage-context.ts";

test("bounded SDK transport counts the exact inline schema/input before reserving, bills one request and rejects an over-budget follow-up", async t => {
    for (const [key, value] of Object.entries({ OPENAI_API_KEY: "offline-bounded", OPENAI_BASE_URL: "https://unverified.invalid/v1", POKEMON_FLIPPER_STORAGE: "file" })) {
        const old = process.env[key]; process.env[key] = value;
        t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    }
    await aiSpending.configure({ paused: false, perSearchCapUsd: 0.02 });
    const searchId = randomUUID();
    let counts = 0, generations = 0, imageDownloads = 0;
    let counted: any;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC", "base64");
    t.mock.method(globalThis, "fetch", async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === "i.ebayimg.com") { imageDownloads++; return new Response(png, { headers: { "content-type": "image/png" } }); }
        assert.equal(url.origin, "https://api.openai.com", "counting and generation must use the verified origin despite an alternate SDK environment setting");
        const body = JSON.parse(String(init?.body));
        if (url.pathname.endsWith("/input_tokens")) {
            counts++; counted = body;
            assert.match(body.input[0].content.find((part: { type: string }) => part.type === "input_image").image_url, /^data:image\/png;base64,/);
            assert.equal(body.instructions, "Visible evidence only.");
            assert.equal(body.text.format.name, "bounded_transport_fixture");
            return Response.json({ object: "response.input_tokens", input_tokens: counts === 1 ? 1024 : 120000 });
        }
        assert.equal(url.pathname, "/v1/responses");
        generations++;
        for (const key of ["model", "input", "instructions", "text", "reasoning"]) assert.deepEqual(body[key], counted[key]);
        assert.equal(body.service_tier, "default"); assert.equal(body.prompt_cache_retention, undefined);
        assert.deepEqual(body.prompt_cache_options, { mode: "explicit", ttl: "30m" });
        assert.equal(body.max_output_tokens, 2200); assert.equal(body.reasoning.effort, "none");
        return Response.json({ id: "offline-bounded-answer", model: body.model, service_tier: "default", status: "completed", object: "response",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }] }],
            usage: { input_tokens: 1024, output_tokens: 150, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
    });
    const request = (prompt: string) => withAiUsageContext({ searchId }, () => runStructured<{ ok: boolean }>({ bounded: true, step: "Bounded transport fixture", prompt,
        instructions: "Visible evidence only.", photos: [{ url: "https://i.ebayimg.com/images/g/offline-bounded/s-l1600.png" }],
        schemaName: "bounded_transport_fixture", schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } }));
    assert.deepEqual((await request("Assess the card.")).result, { ok: true });
    let budget = await aiSpending.summary(searchId);
    assert.equal(budget.attempts, 1); assert.equal(budget.heldUsd, 0);
    assert.ok(budget.settledUsd > 0 && budget.settledUsd < 0.001);
    await assert.rejects(request("Additional evidence is too large."), error => (error as { code?: string }).code === "AI_BUDGET");
    budget = await aiSpending.summary(searchId);
    assert.equal(counts, 2); assert.equal(generations, 1); assert.equal(imageDownloads, 2);
    assert.equal(budget.attempts, 1, "an oversized proof cannot authorize or reserve a second generation");
    assert.ok(budget.committedUsd <= 0.02);
});

test("a bounded image error cannot enter the legacy image-download retry and buy another generation", async t => {
    const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "offline-no-fallback";
    t.after(() => { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; });
    await aiSpending.configure({ paused: false, perSearchCapUsd: 0.02 });
    let images = 0, counts = 0, generations = 0;
    t.mock.method(globalThis, "fetch", async input => {
        const url = new URL(String(input));
        if (url.hostname === "i.ebayimg.com") { images++; return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }); }
        if (url.pathname.endsWith("/input_tokens")) { counts++; return Response.json({ object: "response.input_tokens", input_tokens: 1024 }); }
        generations++;
        return Response.json({ error: { message: "Unable to download image content.", type: "invalid_request_error" } }, { status: 400 });
    });
    await assert.rejects(withAiUsageContext({ searchId: randomUUID() }, () => runStructured({ bounded: true, step: "No image retry", prompt: "Inspect this card.",
        photos: [{ url: "https://i.ebayimg.com/images/g/offline-no-retry/s-l1600.png" }], schemaName: "no_image_retry", schema: { type: "object", additionalProperties: false, required: [], properties: {} } })), /Unable to download/);
    assert.equal(images, 1); assert.equal(counts, 1); assert.equal(generations, 1);
});
