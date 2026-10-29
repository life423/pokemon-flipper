import { test } from "node:test";
import assert from "node:assert/strict";
import { streamDeals, streamDig } from "../../client/src/api.ts";

test("early EOF preserves delivered results but cannot become a completed search", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response('{"type":"listing","listing":{"id":"kept"}}\n'));
    const messages: string[] = [];
    await assert.rejects(streamDeals("offline", { maxResults: 200, minPrice: 0 }, (message) => messages.push(message.type)), /ended before completion/);
    assert.deepEqual(messages, ["listing"]);
});

test("a terminal message without a newline completes a fragmented UTF-8 stream", async (t) => {
    const data = new TextEncoder().encode('{"type":"listing","listing":{"id":"Pokémon"}}\n{"type":"done"}');
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) {
        for (let index = 0; index < data.length; index += 1) controller.enqueue(data.slice(index, index + 1));
        controller.close();
    } })));
    const messages: string[] = [];
    await streamDeals("offline", { maxResults: 200, minPrice: 0 }, (message) => messages.push(message.type === "listing" ? message.listing.id : message.type));
    assert.deepEqual(messages, ["Pokémon", "done"]);
});

test("stream parsing errors cancel pending upstream work", async (t) => {
    let cancelled = false;
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('not json\n'));
    }, cancel() { cancelled = true; } })));
    await assert.rejects(streamDeals("offline", { maxResults: 200, minPrice: 0 }, () => {}), SyntaxError);
    assert.equal(cancelled, true);
});

test("an evaluation supplies current evidence hints without asking the server to fetch those image URLs", async (t) => {
    const { evaluateListing } = await import("../../client/src/api.ts");
    let body: Record<string, unknown> = {};
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        assert.equal(url, "/api/listings/changed/evaluate?fresh=1");
        body = JSON.parse(String(init?.body));
        return Response.json({});
    });
    await evaluateListing({ id: "changed", title: "New listing title", images: ["https://i.ebayimg.com/new.jpg"], currentPrice: 20, shipping: 0, bids: 1, endTime: null, isGraded: false, buyingOption: "FIXED_PRICE", url: "", seller: null }, { fresh: true });
    assert.equal(body.title, "New listing title");
    assert.deepEqual(body.images, ["https://i.ebayimg.com/new.jpg"]);
});

test("Any targets and offer settings reach both search endpoints as explicit zeroes", async (t) => {
    const urls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        urls.push(String(url));
        return new Response('{"type":"done"}\n', { headers: { "Content-Type": "application/x-ndjson" } });
    });
    const targets = { minProfit: 0, minRoi: 0 };
    await streamDeals("1999 base set holo", { maxResults: 200, minPrice: 0, targets, includeOffers: false }, () => {});
    await streamDig("lugia", 0, () => {}, targets, true);
    assert.equal(new URL(urls[0], "http://local").searchParams.get("offers"), "0");
    assert.equal(new URL(urls[1], "http://local").searchParams.get("offers"), "1");
    for (const url of urls) {
        const params = new URL(url, "http://local").searchParams;
        assert.equal(params.get("profit"), "0");
        assert.equal(params.get("roi"), "0");
    }
});

test("focused photo review uses only its explicit endpoint and saved-assessment key", async (t) => {
    const { reviewListingPhotos } = await import("../../client/src/api.ts");
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        calls++;
        assert.equal(url, "/api/listings/v1%7C123%7C0/photo-review");
        assert.equal(init?.method, "POST");
        assert.deepEqual(JSON.parse(String(init?.body)), { key: "saved-key" });
        return Response.json({ summary: "saved review" });
    });
    await reviewListingPhotos("v1|123|0", "saved-key");
    assert.equal(calls, 1);
});
