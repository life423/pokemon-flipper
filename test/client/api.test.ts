import { test } from "node:test";
import assert from "node:assert/strict";
import { disconnectBuyerAccount, evaluateListing, fetchAuctionReminders, fetchBuyerAccount, interpretSearchRequest, reviewBuyerListing, startBuyerConnection, streamDeals, streamNewDeals } from "../../client/src/api.ts";

test("buyer-review recovery metadata keeps its original account and leaves retry scheduling to the queue", async t => {
    const controller = new AbortController(), retryAt = Date.now() + 180_000;
    const response = { listingId: "offline-alakazam", decision: "WAIT", reason: "Temporary provider cooldown.", evidence: "saved", evaluation: null,
        unavailable: true, failure: { code: "PROVIDER_TEMPORARY", retryable: true }, retryAt };
    const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
        assert.equal(new Headers(init?.headers).get("X-Pokemon-Flipper-Search-Id"), "original-account");
        assert.deepEqual(JSON.parse(String(init?.body)), { allowResearch: true });
        return Response.json(response);
    });
    assert.deepEqual(await reviewBuyerListing(response.listingId, "original-account", { minProfit: 0, minRoi: 0 }, false, true, controller.signal), response);
    fetch.mock.mockImplementation(async () => Response.json({ error: "Still cooling down", retryable: true, retryAfterMs: 180_000 }, { status: 503 }));
    await assert.rejects(reviewBuyerListing(response.listingId, "original-account", { minProfit: 0, minRoi: 0 }, false, true, controller.signal),
        (error: any) => error.retryable === true && error.retryAt >= Date.now() + 179_000);
    assert.equal(fetch.mock.callCount(), 2, "no nested HTTP retry multiplies the queue's bounded attempts");
    controller.abort();
    await assert.rejects(reviewBuyerListing(response.listingId, "original-account", { minProfit: 0, minRoi: 0 }, false, true, controller.signal));
    assert.equal(fetch.mock.callCount(), 2);
});

test("buyer-review API rejects unsafe or malformed automatic-retry metadata", async t => {
    const base = { listingId: "offline-alakazam", decision: "WAIT", reason: "Unavailable", evidence: "listing", evaluation: null, unavailable: true };
    for (const extra of [
        { failure: { code: "AI_EVIDENCE_HELD", retryable: true }, retryAt: Date.now() + 3000 },
        { failure: { code: "AI_BUDGET", retryable: true }, retryAt: Date.now() + 3000 },
        { failure: { code: "PROVIDER_TEMPORARY", retryable: true } },
        { failure: { code: "PROVIDER_TEMPORARY", retryable: true }, retryAt: "soon" },
        { failure: { code: "PROVIDER_TEMPORARY", retryable: true }, retryAt: -1 },
    ]) {
        t.mock.method(globalThis, "fetch", async () => Response.json({ ...base, ...extra }));
        await assert.rejects(reviewBuyerListing(base.listingId, "original-account", { minProfit: 0, minRoi: 0 }, false, true, new AbortController().signal), /response was incomplete/);
    }
});

test("search interpretation sends the original request before canonical discovery under the same search ID", async t => {
    const requests: { url: string; headers: Headers; body: unknown }[] = [];
    const plan = { workflow: "named_search", query: "Venusaur 1999", intent: { cardName: "Venusaur", minYear: 1999, maxYear: 1999 },
        format: "FIXED_PRICE", marketPreferences: {}, goal: null, minProfit: null, maxDelivered: null,
        summary: "Find 1999 Venusaur listings." };
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        requests.push({ url, headers: new Headers(init?.headers), body: init?.body && JSON.parse(String(init.body)) });
        return url === "/api/search-plan" ? Response.json(plan) : new Response('{"type":"done"}\n');
    });
    const signal = new AbortController().signal;
    const filters = { typeFilter: "FIXED_PRICE" as const, kindFilter: "all" as const };
    const result = await interpretSearchRequest({ query: "please show me a venusaur from 1999", filters }, "one-request", signal);
    await streamDeals(result.query, { minPrice: 0, filters, searchRunId: "one-request", signal }, () => {});
    assert.equal(requests[0].url, "/api/search-plan");
    assert.deepEqual(requests[0].body, { query: "please show me a venusaur from 1999", filters });
    assert.equal(new URL(requests[1].url, "http://local").searchParams.get("q"), "Venusaur 1999");
    assert.ok(requests.every(request => request.headers.get("X-Pokemon-Flipper-Search-Id") === "one-request"));
});

test("failed or cancelled interpretation cannot dispatch a fallback marketplace search", async t => {
    const controller = new AbortController();
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Search interpretation is unavailable." }, { status: 503 }));
    await assert.rejects(interpretSearchRequest({ query: "find a deal form neo revolution" }, "one-request", controller.signal), /interpretation is unavailable/);
    assert.equal(fetch.mock.callCount(), 1);
    controller.abort();
    await assert.rejects(interpretSearchRequest({ query: "1999 venusaur" }, "one-request", controller.signal));
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.mockImplementation(async () => Response.json({ workflow: "unknown", query: "invented" }));
    await assert.rejects(interpretSearchRequest({ query: "1999 venusaur" }, "one-request", new AbortController().signal), /interpretation was incomplete/);
    assert.equal(fetch.mock.callCount(), 2);
});

test("known filters and a search identifier reach both search modes before paid work", async t => {
    const requests: { url: string; searchId: string | null }[] = [];
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        requests.push({ url: String(url), searchId: new Headers(init?.headers).get("X-Pokemon-Flipper-Search-Id") });
        return new Response('{"type":"done"}\n');
    });
    const options = { minPrice: 10, targets: { minProfit: 50, minRoi: 25 }, includeOffers: false,
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

test("a pending evidence claim never retries the paid evaluation on a transient HTTP status", async t => {
    const call = t.mock.method(globalThis, "fetch", async () =>
        Response.json({ error: "An earlier photo check is unresolved.", code: "AI_EVIDENCE_HELD" }, { status: 503 }));
    await assert.rejects(evaluateListing({ id: "held" } as never), { code: "AI_EVIDENCE_HELD" });
    assert.equal(call.mock.callCount(), 1);
});

test("only automatic search assessments send the requested listing format", async t => {
    const queries: URLSearchParams[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
        queries.push(new URL(url, "http://local").searchParams);
        return Response.json({});
    });
    const listing = { id: "format-test", buyingOption: "FIXED_PRICE" } as never;
    await evaluateListing(listing, { automatic: true, typeFilter: "FIXED_PRICE" });
    await evaluateListing(listing, { automatic: true, typeFilter: "all" });
    await evaluateListing(listing, { typeFilter: "FIXED_PRICE" });
    assert.deepEqual(queries.map(query => [query.get("auto"), query.get("type")]),
        [["1", "FIXED_PRICE"], ["1", null], [null, null]]);
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

test("explicit price refresh uses the saved search scope and makes one price-only request", async t => {
    const scopes: (string | null)[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        const query = new URL(url, "http://local").searchParams;
        assert.equal(query.get("priceOnly"), "1");
        assert.ok(!query.has("fresh") && !query.has("refreshTerms") && !query.has("auto"));
        assert.equal(query.get("profit"), "0");
        assert.equal(query.get("roi"), "0");
        assert.equal(query.get("offers"), "0");
        assert.equal(init?.body, undefined, "the server checks live terms and saved photos");
        scopes.push(new Headers(init?.headers).get("X-Pokemon-Flipper-Search-Id"));
        return Response.json({ error: "Price research unavailable", retryable: true }, { status: 503 });
    });
    const options = { priceOnly: true, fresh: true, automatic: true, includeOffers: false, targets: { minProfit: 0, minRoi: 0 } };
    await assert.rejects(evaluateListing({ id: "offline" } as never, { ...options, searchRunId: "original" }), /Price research unavailable/);
    await assert.rejects(evaluateListing({ id: "offline" } as never, options), /Price research unavailable/);
    assert.deepEqual(scopes, ["original", null], "no retries or invented search account");
});

test("browser API calls identify the local app and display actionable validation errors", async t => {
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        assert.equal(new Headers(init?.headers).get("X-Pokemon-Flipper"), "1");
        return Response.json({ error: "Enter a search between 1 and 300 characters." }, { status: 400 });
    });
    await assert.rejects(streamDeals("", { minPrice: 0 }, () => {}), /between 1 and 300/);
});

test("early EOF preserves delivered results but cannot become a completed search", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response('{"type":"listing","listing":{"id":"kept"}}\n'));
    const messages: string[] = [];
    await assert.rejects(streamDeals("offline", { minPrice: 0 }, (message) => messages.push(message.type)), /ended before completion/);
    assert.deepEqual(messages, ["listing"]);
});

test("discovery progress arrives before retained rows without becoming a completed batch", async t => {
    t.mock.method(globalThis, "fetch", async () => new Response([
        { type: "progress", found: 200, screened: 0 }, { type: "start", count: 1 },
        { type: "progress", found: 200, screened: 48 }, { type: "listing", listing: { id: "retained" } }, { type: "done" },
    ].map(value => JSON.stringify(value)).join("\n")));
    const messages: string[] = [];
    await streamDeals("Venusaur", { minPrice: 0 }, message => messages.push(message.type));
    assert.deepEqual(messages, ["progress", "start", "progress", "listing", "done"]);
    t.mock.method(globalThis, "fetch", async () => new Response('{"type":"progress","found":200,"screened":48}\n'));
    await assert.rejects(streamDeals("Venusaur", { minPrice: 0 }, () => {}), /ended before completion/);
});

test("a terminal message without a newline completes a fragmented UTF-8 stream", async (t) => {
    const data = new TextEncoder().encode('{"type":"listing","listing":{"id":"Pokémon"}}\n{"type":"done"}');
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) {
        for (let index = 0; index < data.length; index += 1) controller.enqueue(data.slice(index, index + 1));
        controller.close();
    } })));
    const messages: string[] = [];
    await streamDeals("offline", { minPrice: 0 }, (message) => messages.push(message.type === "listing" ? message.listing.id : message.type));
    assert.deepEqual(messages, ["Pokémon", "done"]);
});

test("stream parsing errors cancel pending upstream work", async (t) => {
    let cancelled = false;
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('not json\n'));
    }, cancel() { cancelled = true; } })));
    await assert.rejects(streamDeals("offline", { minPrice: 0 }, () => {}), SyntaxError);
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
    const termsCheckedAt = "2026-11-03T12:00:00Z";
    await evaluateListing({ id: "changed", title: "New listing title", images: ["https://i.ebayimg.com/new.jpg"], currentPrice: 20, shipping: 0, bids: 1, endTime: null, isGraded: false, buyingOption: "FIXED_PRICE", bestOffer: false, termsCheckedAt, url: "", seller: null }, { fresh: true });
    assert.equal(body.title, "New listing title");
    assert.deepEqual(body.images, ["https://i.ebayimg.com/new.jpg"]);
    assert.equal(body.termsCheckedAt, termsCheckedAt);
    assert.equal(body.buyingOption, "FIXED_PRICE");
    assert.equal(body.bestOffer, false);
});

test("Any targets and offer settings reach both search endpoints as explicit zeroes", async (t) => {
    const urls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        urls.push(String(url));
        return new Response('{"type":"done"}\n', { headers: { "Content-Type": "application/x-ndjson" } });
    });
    const targets = { minProfit: 0, minRoi: 0 };
    await streamDeals("1999 base set holo", { minPrice: 0, targets, includeOffers: false, marketplaceOrder: "lowest" }, () => {});
    await streamNewDeals("lugia", { minPrice: 0, targets, includeOffers: true, knownIds: [] }, () => {});
    assert.equal(new URL(urls[0], "http://local").searchParams.get("offers"), "0");
    assert.equal(new URL(urls[1], "http://local").searchParams.get("offers"), "1");
    assert.equal(new URL(urls[0], "http://local").searchParams.get("order"), "lowest");
    assert.equal(new URL(urls[1], "http://local").searchParams.get("order"), null);
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

test("listing resolution, deeper review, price retries and usage keep one explicit search scope", async t => {
    const { resolveListingLink, reviewListingPhotos, retryPricingBatch, fetchEbayUsage, refreshSavedListings } = await import("../../client/src/api.ts");
    const scopes: string[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        scopes.push(new Headers(init?.headers).get("X-Pokemon-Flipper-Search-Id") ?? "missing");
        return Response.json({});
    });
    const scope = "same-search-across-stages";
    await resolveListingLink("https://www.ebay.com/itm/123", undefined, scope);
    await evaluateListing({ id: "123" } as never, { searchRunId: scope });
    await reviewListingPhotos("123", "saved", scope);
    await retryPricingBatch(["ticket"], { minProfit: 0, minRoi: 0 }, false, new AbortController().signal, scope);
    await fetchEbayUsage(scope);
    await refreshSavedListings(["123"], scope);
    assert.deepEqual(scopes, Array(6).fill(scope));
});

test("an automatic connection retry retains a generated scope instead of gaining another allowance", async t => {
    const scopes: (string | null)[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        scopes.push(new Headers(init?.headers).get("X-Pokemon-Flipper-Search-Id"));
        if (scopes.length === 1) throw new TypeError("connection interrupted");
        return Response.json({});
    });
    await evaluateListing({ id: "scope-retry" } as never);
    assert.equal(scopes.length, 2);
    assert.ok(scopes[0]);
    assert.equal(scopes[0], scopes[1]);
});

test("quota copy distinguishes a per-search cap from the account's daily allowance", async () => {
    const { describeUsage } = await import("../../client/src/search/presentation.ts");
    const copy = describeUsage({ used: 100, limit: 5000, remaining: 4900, resetsAt: null, braking: false,
        searchBudget: { searchId: "same-search", limit: 25, used: 7, remaining: 18 } });
    assert.match(copy, /eBay today: 4,900 of 5,000/);
    assert.match(copy, /This search: 18 of 25/);
    assert.doesNotMatch(copy, /renew|expir|Development allowance/);
});

test("an AI budget stop preserves all50 free metadata rows still arriving in the search stream", async t => {
    const { analysisBlockPolicy } = await import("../../client/src/search/presentation.ts");
    const signal = new AbortController();
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        let row = 0;
        return new Response(new ReadableStream({
            start(controller) {
                init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
            },
            pull(controller) {
                const done = row >= 50;
                controller.enqueue(new TextEncoder().encode(JSON.stringify(done ? { type: "done" } : { type: "listing", listing: { id: String(row++) } }) + "\n"));
                if (done) controller.close();
            },
        }));
    });
    const rows: string[] = [];
    await streamDeals("charizard", { minPrice: 0, signal: signal.signal, searchRunId: "metadata-during-budget-stop" }, message => {
        if (message.type !== "listing") return;
        rows.push(message.listing.id);
        if (rows.length === 1 && analysisBlockPolicy("AI_BUDGET").stopListingStream) signal.abort();
    });
    assert.equal(rows.length, 50);
    assert.equal(signal.signal.aborted, false);
    assert.equal(analysisBlockPolicy("AI_PAUSED").stopListingStream, false);
    assert.equal(analysisBlockPolicy("STORAGE_UNAVAILABLE").stopListingStream, true, "storage failures must still stop unsafe reads");
});

test("the buyer's sniper calls only its production account and live reminders", async t => {
    const requests: { url: string; method: string; environment?: string }[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        assert.equal(new Headers(init.headers).get("X-Pokemon-Flipper"), "1");
        requests.push({ url, method: init.method ?? "GET", environment: init.body ? JSON.parse(String(init.body)).environment : undefined });
        return Response.json({});
    });
    await fetchAuctionReminders();
    await fetchBuyerAccount();
    await startBuyerConnection("production");
    await disconnectBuyerAccount();
    assert.deepEqual(requests, [
        { url: "/api/sniper?mode=reminder", method: "GET", environment: undefined },
        { url: "/api/ebay/connection?environment=production", method: "GET", environment: undefined },
        { url: "/api/ebay/connection/start", method: "POST", environment: "production" },
        { url: "/api/ebay/connection/disconnect?environment=production", method: "POST", environment: "production" },
    ]);
});
