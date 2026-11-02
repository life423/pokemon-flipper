import { test } from "node:test";
import assert from "node:assert/strict";
import { searchListings } from "../../server/ebay/listings.ts";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";

test("source searches apply selected format, grading kind and12hour auction range without mixing cache scopes", async t => {
    offlineEbayCredentials(t);
    const now = Date.now(); const query = `offline-source-format-${now}`; const filters: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        const address = String(url);
        if (address.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (address.includes("rate_limit")) return Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse", rates: [{ count: 0, limit: 5000, remaining: 5000 }] }] }] });
        filters.push(new URL(address).searchParams.get("filter")!);
        return Response.json({ total: 0, itemSummaries: [] });
    });
    await searchListings(query, { filters: { typeFilter: "AUCTION", kindFilter: "raw" }, auctionEndsWithinHours: 12, asOf: now });
    await searchListings(query, { filters: { typeFilter: "AUCTION", kindFilter: "raw" }, auctionEndsWithinHours: 12 });
    await searchListings(query, { filters: { typeFilter: "FIXED_PRICE", kindFilter: "graded" }, auctionEndsWithinHours: 12 });
    await searchListings(query);
    assert.equal(filters.length, 3, "identical format requests reuse their own cache");
    assert.match(filters[0], /^buyingOptions:\{AUCTION\},conditionIds:\{4000\},itemEndDate:\[/);
    const [start, end] = filters[0].match(/itemEndDate:\[(.*?)\.\.(.*?)\]/)!.slice(1).map(Date.parse);
    assert.equal(start, now); assert.equal(end - start, 12 * 3600000);
    assert.equal(filters[1], "buyingOptions:{FIXED_PRICE},conditionIds:{2750}");
    assert.equal(filters[2], "buyingOptions:{AUCTION|FIXED_PRICE},conditionIds:{4000|2750}");
});

test("development retrieves one200-row Browse page before limiting paid screening", async t => {
    offlineEbayCredentials(t); let pages = 0;
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        const address = String(url);
        if (address.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (address.includes("rate_limit")) return Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse", rates: [{ count: 0, limit: 5000, remaining: 5000 }] }] }] });
        const query = new URL(address).searchParams; pages++;
        assert.equal(query.get("limit"), "200"); assert.equal(query.get("offset"), "0");
        return Response.json({ total: 1000, itemSummaries: [] });
    });
    await searchListings(`offline-development-page-${Date.now()}`, { maxResults: 200 }); assert.equal(pages, 1);
});
