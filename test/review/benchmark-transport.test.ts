import { test } from "node:test";
import assert from "node:assert/strict";
import { BENCHMARK_TRANSPORT_LIMITS, BenchmarkTransportBlockedError, createBenchmarkTransport } from "../../scripts/review/benchmark-transport.ts";

const generation = "https://api.openai.com/v1/responses";
const preflight = generation + "/input_tokens";
const browse = "https://api.ebay.com/buy/browse/v1/item_summary/search?q=secret-query";
const prices = "https://api.pkmnprices.com/v1/cards/private-card-id/listings/ebay?limit=20&api_key=private-query";
const aiBody = (schema = "bounded_card_assessment") => JSON.stringify({ model: "gpt-5.6-luna", text: { format: { type: "json_schema", name: schema, schema: { privatePrompt: "DO-NOT-RECORD" } } }, input: [{ role: "user", content: [{ type: "input_text", text: "PRIVATE-SELLER-TEXT" }, { type: "input_image", image_url: "data:image/jpeg;base64,PRIVATE-PHOTO" }] }] });
const ok: typeof fetch = async () => Response.json({ data: [] });

test("benchmark transport defaults to offline and blocks before the delegate, including photos and unknown hosts", async () => {
    let sent = 0;
    const observer = createBenchmarkTransport({ fetch: async () => { sent++; return Response.json({}); } });
    for (const input of [browse, prices, generation, preflight, "https://i.ebayimg.com/images/private.jpg", "https://example.com/secret"]) {
        await assert.rejects(observer.fetch(input), BenchmarkTransportBlockedError);
    }
    assert.equal(sent, 0);
    assert.equal(observer.records.length, 6);
    assert.equal(observer.snapshot().actual.unknown, 0);
    assert.throws(() => observer.assertNoBlock(), /request was not sent/);
});

test("each hard cap reserves only real attempts and cannot be loosened", async () => {
    for (const [service, maximum] of Object.entries(BENCHMARK_TRANSPORT_LIMITS)) {
        let sent = 0;
        const observer = createBenchmarkTransport({ live: true, fetch: async () => { sent++; return Response.json({}); } });
        const url = service === "ebayBrowse" ? browse : service === "prices" ? prices : service === "aiPreflight" ? preflight : generation;
        const init = service.startsWith("ai") ? { method: "POST", body: aiBody() } : undefined;
        await Promise.all(Array.from({ length: maximum }, () => observer.fetch(url, init)));
        await assert.rejects(observer.fetch(url, init), (error: any) => error instanceof BenchmarkTransportBlockedError && error.reason === "limit");
        assert.equal(sent, maximum);
        assert.equal(observer.snapshot().actual[service], maximum);
        assert.equal(observer.snapshot().blocked[service], 1);
    }
    assert.throws(() => createBenchmarkTransport({ limits: { prices: BENCHMARK_TRANSPORT_LIMITS.prices + 1 } }), /only stricter/);
    assert.throws(() => createBenchmarkTransport({ limits: { aiGeneration: -1 } }), /only stricter/);
});

test("Request bodies and init overrides remain usable while count preflights stay separate from generations", async () => {
    const bodies: any[] = [];
    const observer = createBenchmarkTransport({ live: true, context: () => ({ searchId: "search-id", listingId: "123", phase: "assessment" }), fetch: async (input, init) => {
        const request = new Request(input, init);
        bodies.push(JSON.parse(await request.text()));
        assert.equal(request.redirect, "error");
        assert.equal(request.headers.get("authorization"), "Bearer PRIVATE-KEY");
        return request.url.endsWith("input_tokens") ? Response.json({ object: "response.input_tokens", input_tokens: 101 })
            : Response.json({ usage: { input_tokens: 101, output_tokens: 25, input_tokens_details: { cached_tokens: 9, cache_write_tokens: 0, cache_write_tokens_details: { ttl_30m_tokens: 0, ttl_12h_tokens: 0 } }, output_tokens_details: { reasoning_tokens: 3 } }, output: [{ text: "PRIVATE-RESPONSE" }] });
    } });
    const original = new Request(preflight, { method: "POST", body: aiBody(), headers: { authorization: "Bearer PRIVATE-KEY" } });
    const counted = await observer.fetch(original);
    assert.equal(original.bodyUsed, false);
    assert.equal((await counted.json()).input_tokens, 101);
    const second = new Request(generation, { method: "POST", body: "invalid", headers: { authorization: "Bearer PRIVATE-KEY" } });
    const answer = await observer.fetch(second, { body: aiBody("bounded_slab_label_assessment") });
    assert.equal((await answer.json()).usage.output_tokens, 25);
    assert.equal(bodies[1].text.format.name, "bounded_slab_label_assessment");
    assert.equal(observer.snapshot().actual.aiPreflight, 1);
    assert.equal(observer.snapshot().actual.aiGeneration, 1);
    assert.equal(observer.records[0].inputTokens, 101);
    assert.equal(observer.records[0].outputTokens, undefined);
    assert.equal(observer.records[1].cachedInputTokens, 9);
    assert.equal(observer.records[1].reasoningOutputTokens, 3);
    assert.equal(observer.records[1].phase, "assessment");
    observer.assertNoBlock();
    const report = JSON.stringify({ records: observer.records, summary: observer.snapshot() });
    for (const secret of ["PRIVATE-KEY", "PRIVATE-SELLER-TEXT", "PRIVATE-PHOTO", "PRIVATE-RESPONSE", "privatePrompt", "DO-NOT-RECORD"]) assert.equal(report.includes(secret), false);
});

test("unapproved schema and endpoints are denied without recording their content", async () => {
    let sent = 0;
    const observer = createBenchmarkTransport({ live: true, fetch: async () => { sent++; return Response.json({}); } });
    for (const url of [generation, preflight]) await assert.rejects(observer.fetch(url, { method: "POST", body: aiBody("PRIVATE-UNBOUNDED-SCHEMA") }), /schema/);
    await assert.rejects(observer.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: aiBody() }), /endpoint/);
    await assert.rejects(observer.fetch("https://i.ebayimg.com.evil.test/private"), /endpoint/);
    await assert.rejects(observer.fetch("https://PRIVATE-USER:PRIVATE-PASS@api.ebay.com/buy/browse/v1/item/private"), /invalid-request|endpoint/);
    assert.equal(sent, 0);
    assert.equal(JSON.stringify(observer.records).includes("PRIVATE"), false);
});

test("price metadata counts returned rows and safe credit headers without storing IDs, queries, headers or response fields", async () => {
    const observer = createBenchmarkTransport({ live: true, fetch: async () => Response.json({ data: [{ id: "private-sale-one", price: 100 }, { id: "private-sale-two", price: 200 }], privateInfo: "secret-body" }, {
        headers: { "x-credits-charged": "2", "x-credits-limit": "20000", "x-credits-remaining": "19998", "x-credits-reset": "20019", "x-ratelimit-remaining": "99", "x-ratelimit-reset": "2026-11-04T00:00:00Z", "x-credits-note": "secret-note", "set-cookie": "private-cookie", authorization: "secret-auth" },
    }) });
    const response = await observer.fetch(prices, { headers: { "x-api-key": "secret-key" } });
    assert.equal((await response.json()).data.length, 2);
    assert.equal(observer.records[0].path, "/v1/cards/:id/listings/ebay");
    assert.equal(observer.records[0].returnedRows, 2);
    assert.match(observer.records[0].requestHash!, /^[a-f0-9]{64}$/);
    assert.deepEqual(observer.records[0].numericHeaders, { "x-credits-charged": 2, "x-credits-limit": 20000, "x-credits-remaining": 19998, "x-credits-reset": 20019, "x-ratelimit-remaining": 99 });
    assert.deepEqual(observer.snapshot().pricingCredits, { reportedCharged: 2, unreportedRequests: 0 });
    const report = JSON.stringify(observer.records);
    for (const secret of ["private", "secret", "20019T", "2026-11-04T", "authorization", "set-cookie"]) assert.equal(report.includes(secret), false);
    await observer.fetch(prices);
    await observer.fetch(prices.replace("limit=20", "limit=5"));
    assert.equal(observer.records[0].requestHash, observer.records[1].requestHash);
    assert.notEqual(observer.records[0].requestHash, observer.records[2].requestHash);
});

test("failed transports count once, missing credits stay unknown, and cancellation is preserved", async () => {
    let sent = 0;
    const observer = createBenchmarkTransport({ live: true, limits: { prices: 1 }, fetch: async () => { sent++; throw new Error("PRIVATE-TRANSPORT-ERROR"); } });
    await assert.rejects(observer.fetch(prices), /PRIVATE-TRANSPORT-ERROR/);
    await assert.rejects(observer.fetch(prices), /limit/);
    assert.equal(sent, 1);
    assert.equal(observer.records[0].outcome, "transport-error");
    assert.deepEqual(observer.snapshot().pricingCredits, { reportedCharged: 0, unreportedRequests: 1 });
    assert.equal(JSON.stringify(observer.records).includes("PRIVATE"), false);
    const controller = new AbortController(); controller.abort(new Error("stopped"));
    const stopped = createBenchmarkTransport({ live: true, fetch: async () => { sent++; return Response.json({}); } });
    await assert.rejects(stopped.fetch(browse, { signal: controller.signal }), /stopped/);
    assert.equal(stopped.snapshot().actual.ebayBrowse, 0);
    assert.equal(stopped.records[0].outcome, "cancelled");
    stopped.assertNoBlock();
});

test("Browse, Analytics, OAuth and photos are separate; SQL authentication requires explicit known endpoints", async () => {
    const observer = createBenchmarkTransport({ live: true, fetch: ok });
    for (const url of [browse, "https://api.ebay.com/developer/analytics/v1_beta/rate_limit", "https://api.ebay.com/identity/v1/oauth2/token", "https://i.ebayimg.com/images/private.jpg"]) await observer.fetch(url);
    const actual = observer.snapshot().actual;
    assert.equal(actual.ebayBrowse, 1); assert.equal(actual.ebayAnalytics, 1); assert.equal(actual.ebayOAuth, 1); assert.equal(actual.photos, 1);
    const azure = createBenchmarkTransport({ allowAzureAuth: true, fetch: ok });
    await azure.fetch("https://login.microsoftonline.com/private-tenant/oauth2/v2.0/token", { method: "POST", body: "private-token-request" });
    assert.equal(azure.snapshot().actual.azureAuth, 1);
    await assert.rejects(azure.fetch("https://login.microsoftonline.com/private-tenant/private-endpoint"), /endpoint/);
    await assert.rejects(azure.fetch("http://169.254.169.254/metadata/identity/oauth2/token"), /endpoint/);
    const managed = createBenchmarkTransport({ allowManagedIdentity: true, fetch: ok });
    await managed.fetch("http://169.254.169.254/metadata/identity/oauth2/token?secret=query");
    assert.equal(managed.snapshot().actual.azureAuth, 1);
    assert.equal(JSON.stringify([...azure.records, ...managed.records]).includes("private"), false);
});
