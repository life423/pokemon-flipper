import { test } from "node:test";
import assert from "node:assert/strict";
import { streamDeals, streamNewDeals, streamDig, evaluateListing } from "../../client/src/api.ts";

test("known filters and a search identifier reach both search modes before paid work", async t => {
    const requests: { url: string; searchId: string | null }[] = [];
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        requests.push({ url: String(url), searchId: new Headers(init?.headers).get("X-Pokemon-Flipper-Search-Id") });
        return new Response('{"type":"done"}\n');
    });
    const options = { maxResults: 200, minPrice: 10, targets: { minProfit: 50, minRoi: 25 }, includeOffers: false,
        filters: { typeFilter: "FIXED_PRICE" as const, kindFilter: "raw" as const, maxPrice: 300 }, searchRunId: "offline-search", knownIds: [] };
    await streamDeals("charizard", options, () => {});
    await streamNewDeals("charizard", options, () => {});
    for (const request of requests) {
        const query = new URL(request.url, "http://local").searchParams;
        assert.equal(query.get("type"), "FIXED_PRICE"); assert.equal(query.get("kind"), "raw");
        assert.equal(query.get("ceiling"), "300"); assert.equal(query.get("min"), "10");
        assert.equal(request.searchId, "offline-search");
    }
});

test("a stopped evaluation never dispatches or retries a paid request", async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        calls++;
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
    });
    const listing = { id: "offline" } as never;
    const stopped = new AbortController(); stopped.abort();
    await assert.rejects(evaluateListing(listing, { signal: stopped.signal }));
    assert.equal(calls, 0);
    const controller = new AbortController();
    const pending = evaluateListing(listing, { signal: controller.signal });
    controller.abort(); await assert.rejects(pending);
    assert.equal(calls, 1);
});

test("Stop immediately interrupts provider retry waiting and keeps search attribution", async t => {
    let calls = 0;
    const controller = new AbortController();
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        calls++;
        assert.equal(new Headers(init?.headers).get("X-Pokemon-Flipper-Search-Id"), "offline-retry");
        setTimeout(() => controller.abort(), 0);
        return Response.json({ error: "Cooling down", retryable: true, retryAfterMs: 90_000 }, { status: 503 });
    });
    await assert.rejects(evaluateListing({ id: "offline" } as never, { signal: controller.signal, searchRunId: "offline-retry" }));
    assert.equal(calls, 1);
});

test("a fresh request resumes one interrupted connection without repaying completed photo work or trusting old browser terms", async t => {
    const urls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => { urls.push(url); if (urls.length === 1) throw new TypeError("network error"); return Response.json({ listing: { id: "offline" } }); });
    await evaluateListing({ id: "offline", title: "Old browser", images: [], currentPrice: 1, shipping: 0, bids: 0, endTime: null } as never, { fresh: true });
    assert.match(urls[0], /fresh=1/); assert.match(urls[1], /refreshTerms=1/); assert.equal(urls.length, 2);
});

test("browser API calls identify the local app and display actionable validation errors", async t => {
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        assert.equal(new Headers(init?.headers).get("X-Pokemon-Flipper"), "1");
        return Response.json({ error: "Enter a search between 1 and 300 characters." }, { status: 400 });
    });
    await assert.rejects(streamDeals("", { maxResults: 400, minPrice: 0 }, () => {}), /between 1 and 300/);
});

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
