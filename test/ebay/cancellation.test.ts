import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { findDeals } from "../../server/deals/find-deals.ts";
import { getListingDetails, searchListings } from "../../server/ebay/listings.ts";
import { browseSearchAllowance, reserveSearchBrowseRequest } from "../../server/ebay/search-budget.ts";
import { evaluateBoundedListing } from "../../server/analysis/bounded-evaluate.ts";
import { writeCache } from "../../server/lib/cache.ts";
import { drainSharedWork } from "../../server/lib/shared-work.ts";
import { MODEL } from "../../server/ai/openai.ts";
import { withAiUsageContext } from "../../server/ai/usage-context.ts";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";

const quotaResponse = () => Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse",
    rates: [{ count: 0, limit: 5000, remaining: 5000 }] }] }] });

test("stopping evaluation during sign-in prevents its listing detail Browse request", async t => {
    offlineEbayCredentials(t);
    const controller = new AbortController();
    const signingIn = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let browseCalls = 0;
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (String(url).includes("oauth2/token")) {
            signingIn.resolve();
            await release.promise;
            return Response.json({ access_token: "offline", expires_in: 3600 });
        }
        browseCalls++;
        return Response.json({ itemId: "v1|stopped-before-details|0", title: "Venusaur Base Set Holo" });
    });
    const evaluation = evaluateBoundedListing("v1|stopped-before-details|0", { signal: controller.signal });
    await signingIn.promise;
    controller.abort();
    release.resolve();
    await assert.rejects(evaluation, { name: "AbortError" });
    assert.equal((await drainSharedWork({ timeoutMs: 1000 })).complete, true);
    assert.equal(browseCalls, 0);
});

test("stopping one of two detail readers keeps the shared Browse request for the other", async t => {
    offlineEbayCredentials(t);
    const controller = new AbortController();
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let browseCalls = 0;
    let transportSignal: AbortSignal | null | undefined;
    const id = "v1|two-detail-readers|0";
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        if (String(url).includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        assert.match(String(url), /\/buy\/browse\/v1\/item\//);
        browseCalls++;
        transportSignal = init?.signal;
        requested.resolve();
        await release.promise;
        return Response.json({ itemId: id, title: "Venusaur Base Set Holo" });
    });
    const first = getListingDetails(id, { maxAgeHours: 0, signal: controller.signal });
    const second = getListingDetails(id, { maxAgeHours: 0 });
    await requested.promise;
    controller.abort();
    release.resolve();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal((await second).id, id);
    assert.equal(transportSignal?.aborted, false);
    assert.equal(browseCalls, 1);
});

test("identical uncached searches share a Browse page and only the initiating search pays for it", async t => {
    offlineEbayCredentials(t);
    const controller = new AbortController();
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const follower = { searchId: randomUUID() };
    const query = "offline shared one-page summary";
    let pages = 0;
    let transportSignal: AbortSignal | null | undefined;
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        const address = String(url);
        if (address.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (address.includes("rate_limit")) return quotaResponse();
        assert.match(address, /item_summary\/search/);
        pages++;
        transportSignal = init?.signal;
        requested.resolve();
        await release.promise;
        return Response.json({ total: 1, itemSummaries: [{ itemId: "v1|shared-summary|0", title: "Venusaur Base Set Holo" }] });
    });

    const first = assert.rejects(searchListings(query, { signal: controller.signal }), { name: "AbortError" });
    const second = withAiUsageContext(follower, () => searchListings(query));
    await requested.promise;
    controller.abort();
    release.resolve();
    await first;
    assert.equal((await second).listings[0]?.id, "v1|shared-summary|0");
    assert.equal(transportSignal?.aborted, false);
    assert.equal((await browseSearchAllowance())?.used, 1);
    assert.equal((await withAiUsageContext(follower, browseSearchAllowance))?.used, 0);
    assert.equal(pages, 1);
});

test("an exhausted initiating search does not block a follower with its own Browse allowance", async t => {
    offlineEbayCredentials(t);
    const allowance = await browseSearchAllowance();
    assert.ok(allowance);
    for (let request = 0; request < allowance.remaining; request++) await reserveSearchBrowseRequest(async () => {});
    const follower = { searchId: randomUUID() };
    let pages = 0;
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        const address = String(url);
        if (address.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (address.includes("rate_limit")) return quotaResponse();
        assert.match(address, /item_summary\/search/);
        pages++;
        return Response.json({ total: 1, itemSummaries: [{ itemId: "v1|follow-up-summary|0", title: "Venusaur Base Set Holo" }] });
    });

    const query = "offline exhausted shared summary";
    const first = assert.rejects(searchListings(query), /eBay Browse cap/);
    const second = withAiUsageContext(follower, () => searchListings(query));
    await first;
    assert.equal((await second).listings[0]?.id, "v1|follow-up-summary|0");
    assert.equal((await browseSearchAllowance())?.used, allowance.limit);
    assert.equal((await withAiUsageContext(follower, browseSearchAllowance))?.used, 1);
    assert.equal(pages, 1);
});

test("stopping the first primary search page prevents all later page requests", async (t) => {
    offlineEbayCredentials(t);
    const controller = new AbortController();
    const query = `offline cancellation ${Date.now()}`;
    await writeCache(`search-intent:v1:${MODEL}:${query}`, { cardName: null, sets: [], cardNumber: null, printing: null, graded: null, titleWords: [], source: "rules" });
    let pages = 0;
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        const address = String(url);
        if (address.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (address.includes("rate_limit")) return quotaResponse();
        assert.match(address, /item_summary\/search/);
        pages += 1;
        assert.ok(init?.signal, "the provider request also receives the signal");
        controller.abort();
        return Response.json({ total: 1000, itemSummaries: Array.from({ length: 200 }, (_, index) => ({ itemId: `v1|${index}|0`, title: "Venusaur Base Set Holo", buyingOptions: ["FIXED_PRICE"], price: { value: "20", currency: "USD" } })) });
    });
    await assert.rejects(findDeals(query, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(pages, 1);
    await assert.rejects(searchListings(query, { maxResults: 1000, signal: controller.signal }), { name: "AbortError" });
    assert.equal(pages, 1);
});
