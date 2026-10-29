import { test } from "node:test";
import assert from "node:assert/strict";
import { findDeals } from "../../server/deals/find-deals.ts";
import { searchListings } from "../../server/ebay/listings.ts";
import { writeCache } from "../../server/lib/cache.ts";
import { MODEL } from "../../server/ai/openai.ts";

test("stopping the first primary search page prevents all later page requests", async (t) => {
    const controller = new AbortController();
    const query = `offline cancellation ${Date.now()}`;
    await writeCache(`search-intent:v1:${MODEL}:${query}`, { cardName: null, sets: [], cardNumber: null, printing: null, graded: null, titleWords: [], source: "rules" });
    let pages = 0;
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        const address = String(url);
        if (address.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (address.includes("rate_limit")) return Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse", rates: [{ count: 0, limit: 5000, remaining: 5000 }] }] }] });
        assert.match(address, /item_summary\/search/);
        pages += 1;
        assert.ok(init?.signal, "the provider request also receives the signal");
        controller.abort();
        return Response.json({ total: 1000, itemSummaries: Array.from({ length: 200 }, (_, index) => ({ itemId: `v1|${index}|0`, title: "Venusaur Base Set Holo", buyingOptions: ["FIXED_PRICE"], price: { value: "20", currency: "USD" } })) });
    });
    await assert.rejects(findDeals(query, { maxResults: 1000, signal: controller.signal }), { name: "AbortError" });
    assert.equal(pages, 1);
    await assert.rejects(searchListings(query, { maxResults: 1000, signal: controller.signal }), { name: "AbortError" });
    assert.equal(pages, 1);
});
