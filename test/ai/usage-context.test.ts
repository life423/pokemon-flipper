import "../fixtures/mock-ai-spending.ts";
import { isolatedDataDir } from "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../../server/lib/paths.ts";
import { trackedAiFetch, aiUsageToday, type AiAttempt } from "../../server/ai/usage.ts";
import { withAiUsageContext, getAiUsageContext } from "../../server/ai/usage-context.ts";

const dayFile = () => path.join(DATA_DIR, "ai-usage", `${new Date(Date.now()).toISOString().slice(0, 10)}.ndjson`);
const request = { headers: { Authorization: "Bearer private-key" }, body: JSON.stringify({ model: "requested-model", metadata: { app_step: "Photo assessment" },
    input: [{ content: [{ type: "input_text", text: "private-seller-text" }, { type: "input_image", image_url: "https://private-photo.invalid" }] }] }) };
const responseBody = () => ({ id: "resp_test", model: "provider-model", status: "completed", service_tier: "default", output: [],
    usage: { input_tokens: 12000, output_tokens: 300, input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000,
        cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 } }, output_tokens_details: { reasoning_tokens: 100 } } });

async function clearUsage() {
    assert.equal(DATA_DIR, isolatedDataDir, "the test must not touch the user's data");
    await fs.rm(path.dirname(dayFile()), { recursive: true, force: true });
}

async function attempts(): Promise<AiAttempt[]> {
    return (await fs.readFile(dayFile(), "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

test("search/listing contexts stay independent through async work and transport logs exact usage without private inputs", async t => {
    await clearUsage();
    t.mock.method(globalThis, "fetch", async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        return Response.json(responseBody(), { headers: { "x-request-id": "req_test" } });
    });
    await Promise.all(["search-a", "search-b"].map(searchId => withAiUsageContext({ searchId }, async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(getAiUsageContext(), { searchId });
        await withAiUsageContext({ listingId: `${searchId}-listing` }, async () => {
            const response = await trackedAiFetch("https://api.openai.com/v1/responses", request);
            assert.equal((await response.json()).id, "resp_test", "telemetry must leave the original response readable");
        });
        assert.deepEqual(getAiUsageContext(), { searchId }, "the nested listing must not escape its own scope");
    })));
    assert.deepEqual(getAiUsageContext(), {});
    const rows = await attempts();
    assert.equal(rows.length, 2);
    for (const row of rows) {
        assert.equal(row.listingId, `${row.searchId}-listing`);
        assert.equal(row.model, "provider-model");
        assert.equal(row.requestedModel, "requested-model");
        assert.equal(row.requestId, "req_test");
        assert.equal(row.responseId, "resp_test");
        assert.equal(row.serviceTier, "default");
        assert.equal(row.responseStatus, "completed");
        assert.equal(row.hasRefusal, false);
        assert.equal(row.images, 1);
        assert.equal(row.inputTokens, 12000);
        assert.equal(row.outputTokens, 300);
        assert.equal(row.cachedInputTokens, 4000);
        assert.equal(row.cacheWriteTokens, 7000);
        assert.equal(row.cacheWrite30mTokens, 3000);
        assert.equal(row.cacheWrite12hTokens, 4000);
        assert.equal(row.reasoningOutputTokens, 100);
        assert.equal(row.usageReported, true);
        assert.match(row.inputHash!, /^[a-f0-9]{64}$/);
    }
    assert.equal(rows[0].inputHash, rows[1].inputHash, "context identifiers must not change the request fingerprint");
    assert.doesNotMatch(await fs.readFile(dayFile(), "utf8"), /private-key|private-seller-text|private-photo/);
    const search = await aiUsageToday("search-a");
    assert.equal(search.calls, 1);
    assert.equal(search.searchId, "search-a");
    assert.equal(search.stages[0].cacheWrite30mTokens, 3000);
    assert.equal(search.stages[0].cacheWrite12hTokens, 4000);
});

test("old logs remain readable, per-search totals exclude unrelated calls and service tiers stay separate", async () => {
    await clearUsage();
    const legacy = { at: new Date().toISOString(), step: "Photo assessment", model: "provider-model", images: 1, status: 200,
        durationMs: 1, inputTokens: 30, outputTokens: 10, cachedInputTokens: 20 };
    const current = { ...legacy, searchId: "search-a", serviceTier: "default", usageReported: true,
        cacheWriteTokens: 0, cacheWrite30mTokens: 0, cacheWrite12hTokens: 0, reasoningOutputTokens: 0 };
    await fs.mkdir(path.dirname(dayFile()), { recursive: true });
    await fs.writeFile(dayFile(), [legacy, current, { ...current, serviceTier: "priority" }, { ...current, searchId: "search-b" }].map(row => JSON.stringify(row)).join("\n") + "\ninvalid\nnull\n[]\n{}");
    const all = await aiUsageToday();
    assert.equal(all.calls, 4);
    assert.equal(all.unattributedCalls, 1);
    const old = all.stages.find(stage => stage.serviceTier === null)!;
    assert.equal(old.inputTokens, 30);
    assert.equal(old.unreportedUsageCalls, 0);
    assert.equal(old.cacheWriteTokens, null);
    assert.equal(old.unreportedCacheWriteCalls, 1);
    const search = await aiUsageToday("search-a");
    assert.equal(search.calls, 2);
    assert.equal(search.stages.length, 2);
    assert.deepEqual(search.stages.map(stage => stage.serviceTier).sort(), ["default", "priority"]);
    assert.equal((await aiUsageToday("missing-search")).calls, 0);
});

test("transport failures and unreadable usage remain unknown rather than becoming a claimed zero bill", async t => {
    await clearUsage();
    const failure = new Error("offline connection loss");
    let count = 0;
    t.mock.method(globalThis, "fetch", async () => { if (count++ === 0) throw failure; return new Response("not JSON"); });
    await withAiUsageContext({ searchId: "search-failed" }, async () => {
        await assert.rejects(trackedAiFetch("https://api.openai.com/v1/responses", request), error => error === failure);
        assert.equal((await trackedAiFetch("https://api.openai.com/v1/responses", request)).status, 200);
    });
    const rows = await attempts();
    assert.deepEqual(rows.map(row => row.status), [null, 200]);
    assert.ok(rows.every(row => row.usageReported === false && row.cacheWriteTokens === null && row.requestId === null));
    const usage = await aiUsageToday("search-failed");
    assert.equal(usage.calls, 2);
    assert.equal(usage.stages[0].unreportedUsageCalls, 2);
    assert.equal(usage.stages[0].cacheWriteTokens, null);
    assert.equal(usage.stages[0].cacheWrite30mTokens, null);
});

test("incomplete or refused paid responses retain their usage and count as unsuccessful work", async t => {
    await clearUsage();
    let count = 0;
    t.mock.method(globalThis, "fetch", async () => Response.json({ ...responseBody(),
        ...(++count === 1 ? { status: "incomplete" } : { output: [{ content: [{ type: "refusal", refusal: "private refusal detail" }] }] }) }));
    await trackedAiFetch("https://api.openai.com/v1/responses", request);
    await trackedAiFetch("https://api.openai.com/v1/responses", request);
    const usage = await aiUsageToday();
    assert.equal(usage.calls, 2);
    assert.equal(usage.stages[0].failed, 2);
    assert.equal(usage.stages[0].inputTokens, 24000);
    assert.equal(usage.stages[0].cacheWriteTokens, 14000);
    assert.doesNotMatch(await fs.readFile(dayFile(), "utf8"), /private refusal detail/);
});
