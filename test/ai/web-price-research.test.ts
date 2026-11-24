import "../fixtures/isolated-data.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { searchWebPrices, createWebPriceSearch } from "../../server/ai/web-price-research.ts";
import { webSearchSources } from "../../server/ai/openai.ts";
import { withSavedProviderEvidence } from "../../server/lib/saved-provider-evidence.ts";
import type { WebPriceResearch } from "../../shared/web-price-research.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";

const target = { cardName: "Mewtwo", setName: "Base Set", cardNumber: "10/102", printingLabel: "Unlimited", finish: "HOLO", grader: "RAW", grade: "Lightly Played" };
const asOf = "2026-11-24";
const url = (id: number) => `https://www.ebay.com/itm/12345678900${id}`;
const row = { title: "Mewtwo 10/102 Base Set Unlimited Holo LP", details: "English", priceEvidence: "Sold for US $45.00", kind: "SOLD", currency: "USD",
    priceUsd: 45, date: "2026-11-19", url: url(1) };
function fixture(rows: unknown[], sources: string[]) {
    const cache = new Map<string, WebPriceResearch>();
    let charged = 0;
    const search = createWebPriceSearch({ read: async key => cache.get(key) ?? null, write: async (key, value) => { cache.set(key, value as WebPriceResearch); },
        search: async () => { charged++; return { result: { observations: rows }, sourceUrls: sources }; } });
    return { search, charged: () => charged };
}

test("web sale and ask stay distinct, link to actual search sources, and replay with zero additional calls", async () => {
    const rows = [row, { ...row, kind: "ASK", priceEvidence: "Buy It Now $45.00", url: url(2), date: null }, { ...row, url: url(3) }, { ...row, url: "https://www.ebay.com/sch/i.html" }];
    const { search, charged } = fixture(rows, [url(1) + "?utm_source=openai", url(2), "https://www.ebay.com/sch/i.html"]);
    assert.equal(await search(target, { asOf, cacheOnly: true }), null);
    const results = await Promise.all([search(target, { asOf }), search(target, { asOf })]);
    assert.deepEqual(results[0]?.observations.map(r => [r.kind, r.priceUsd, r.url]), [["SOLD", 45, url(1)], ["ASK", 45, url(2)]]);
    assert.deepEqual(results[1], results[0]); assert.equal(charged(), 1);
    await withSavedProviderEvidence(() => assert.fail("replay tried a provider"), async () => {
        assert.deepEqual(await search(target, { asOf, cacheOnly: true }), results[0]);
    });
    assert.equal(charged(), 1);
});
test("wrong printing, condition, currency, date and grader cannot become sale observations", async () => {
    for (const alternative of [
        { title: "Mewtwo 10/102 Base Set Shadowless Holo LP" }, { title: "Mewtwo 10/130 Base Set 2 Unlimited Holo LP" },
        { title: "Mewtwo 10/102 Base Set Unlimited Reverse Holo LP" }, { title: "Mewtwo 10/102 Base Set Unlimited Holo HP" },
        { title: "Mewtwo 10/102 Base Set Unlimited Holo" }, { title: "Mewtwo 10/102 Base Set Unlimited Holo LP PSA 7" },
        { title: "Mewtwo 10/102 Base Set Unlimited Holo LP", details: "Japanese" }, { currency: "CAD" }, { date: "2026-11-25" },
        { priceEvidence: "Best offer accepted. Listed for $45.00" }, { priceEvidence: "Buy It Now $45.00" }, { priceEvidence: "Sold for $21" }, { date: "2026-01-01" }, { date: null }, { url: "https://ebay.com.evil.org/itm/123456789001" },
    ]) {
        const wrong = { ...row, ...alternative };
        const { search } = fixture([wrong], [wrong.url]);
        assert.deepEqual((await search(target, { asOf }))?.observations, [], JSON.stringify(alternative));
    }
    const { search } = fixture([{ ...row, title: "Mewtwo 10/102 Base Set Unlimited Holo PSA 8" }], [url(1)]);
    assert.equal((await search({ ...target, grade: "8", grader: "PSA" }, { asOf }))?.observations.length, 1);
    assert.deepEqual((await search({ ...target, grade: "8", grader: "CGC" }, { asOf }))?.observations, []);
});
test("a completed auction-house lot with an explicit printing and half-grade is usable as a web reference", async () => {
    const lot = "https://www.fanaticscollect.com/weekly/43632ef8-b9bc-11f1-97b9-0a58a9feac02";
    const target = { cardName: "Dark Gengar", setName: "Neo Destiny", cardNumber: "6/105", printingLabel: "Unlimited", finish: "HOLO", grader: "CGC", grade: "8.5" };
    const sale = { ...row, title: "2002 Neo Destiny Dark Gengar Holo #6 CGC 8.5", details: "English 6/105 Unlimited",
        priceEvidence: "Sold for $990", priceUsd: 990, url: lot };
    for (const [observation, expected] of [[sale, 1], [{ ...sale, details: "English 6/105 First Edition" }, 0],
        [{ ...sale, kind: "ASK" }, 0], [{ ...sale, url: lot.replace("/weekly/", "/search/") }, 0]] as const) {
        const { search } = fixture([observation], [observation.url]);
        assert.equal((await search(target, { asOf }))?.observations.length, expected);
    }
});

test("web research ties the reported amount to the final sale or active item price", async () => {
    const offer = "Listed for $89.99; best offer accepted. Actual sale price: $45.00.";
    const ask = "Buy It Now $45.00, plus $7.95 delivery.";
    const rows = [{ ...row, priceEvidence: offer, priceUsd: 89.99 }, { ...row, url: url(2), priceEvidence: offer },
        { ...row, kind: "ASK", url: url(3), date: null, priceEvidence: ask, priceUsd: 7.95 },
        { ...row, kind: "ASK", url: url(4), date: null, priceEvidence: ask }];
    const { search } = fixture(rows, rows.map(r => r.url));
    assert.deepEqual((await search(target, { asOf }))?.observations.map(r => [r.kind, r.priceUsd]), [["SOLD", 45], ["ASK", 45]]);
});

test("a saved empty finding is reusable and corrupt saved results fail closed", async () => {
    const { search, charged } = fixture([], []);
    assert.deepEqual((await search(target, { asOf }))?.observations, []);
    assert.deepEqual((await search(target, { asOf }))?.observations, []);
    assert.equal(charged(), 1);
    const broken = createWebPriceSearch({ read: async () => ({} as WebPriceResearch), search: () => assert.fail("corruption authorized paid search") });
    await assert.rejects(broken(target, { asOf }), StorageUnavailableError);
});
test("a tool result or citation must be provider metadata from a completed search", () => {
    const output = [{ type: "web_search_call", status: "completed", action: { type: "search", sources: [{ type: "url", url: url(1) }] } },
        { type: "message", content: [{ type: "output_text", text: url(3), annotations: [{ type: "url_citation", url: url(2) }] }] }];
    assert.deepEqual(webSearchSources(output as any), [url(1), url(2)]);
    assert.throws(() => webSearchSources(output.slice(1) as any), /did not complete/);
});


test("normal SDK route counts the prompt and tools, makes one search, charges the tool, and replays", async t => {
    const { aiSpending } = await import("../../server/ai/spending.ts");
    const { withAiUsageContext } = await import("../../server/ai/usage-context.ts");
    for (const [key, value] of Object.entries({ OPENAI_API_KEY: "offline-web-fixture", POKEMON_FLIPPER_STORAGE: "file" })) {
        const old = process.env[key]; process.env[key] = value;
        t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    }
    await aiSpending.configure({ paused: false, perSearchCapUsd: 0.06 });
    const searchId = randomUUID();
    let counts = 0, sends = 0, counted: any;
    t.mock.method(globalThis, "fetch", async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.origin, "https://api.openai.com");
        const body = JSON.parse(String(init?.body));
        if (url.pathname === "/v1/responses/input_tokens") {
            counts++; counted = body;
            assert.deepEqual(body.tools.map((tool: any) => tool.type), ["web_search"]);
            return Response.json({ object: "response.input_tokens", input_tokens: 800 });
        }
        assert.equal(url.pathname, "/v1/responses"); sends++;
        for (const field of ["input", "instructions", "tools", "tool_choice", "text", "reasoning"]) assert.deepEqual(body[field], counted[field]);
        assert.equal(body.max_tool_calls, 1); assert.equal(body.parallel_tool_calls, false);
        return Response.json({ object: "response", id: "offline-web", status: "completed", model: body.model, service_tier: "default",
            output: [{ type: "web_search_call", id: "search", status: "completed", action: { type: "search", sources: [{ type: "url", url: row.url }] } },
                { type: "message", role: "assistant", content: [{ type: "output_text", annotations: [], text: JSON.stringify({ observations: [row] }) }] }],
            usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
    });
    const run = () => withAiUsageContext({ searchId }, () => searchWebPrices(target, { asOf }));
    const first = await run();
    assert.equal(first?.observations[0]?.priceUsd, 45);
    assert.deepEqual(await run(), first);
    assert.equal(counts, 1); assert.equal(sends, 1);
    const budget = await aiSpending.summary(searchId);
    assert.equal(budget.settledUsd, 0.01044); assert.equal(budget.unsettledAttempts, 0);
});
