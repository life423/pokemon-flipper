import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import { searchListings } from "../../server/ebay/listings.ts";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";
import { EnglishOnlyError } from "../../shared/card-language.ts";

test("source searches apply selected format, grading kind and12hour auction range without mixing cache scopes", async t => {
    offlineEbayCredentials(t);
    const now = Date.now(); const query = `offline-source-format-${now}`; const filters: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        const address = String(url);
        if (address.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (address.includes("rate_limit")) return Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse", rates: [{ count: 0, limit: 5000, remaining: 5000 }] }] }] });
        assert.equal(new URL(address).searchParams.get("aspect_filter"), "categoryId:183454,Language:{English}");
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

test("English source searches exclude contradictory title/aspect evidence and preserve category discovery", async t => {
    offlineEbayCredentials(t);
    let pages = 0;
    t.mock.method(globalThis, "fetch", async input => {
        const address = String(input);
        if (address.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (address.includes("rate_limit")) return Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse", rates: [{ count: 0, limit: 5000, remaining: 5000 }] }] }] });
        const params = new URL(address).searchParams;
        if (pages++ === 0) assert.equal(params.get("aspect_filter"), "categoryId:183454,Language:{English}");
        else { assert.equal(params.get("category_ids"), null); assert.equal(params.get("aspect_filter"), null); assert.match(params.get("q")!, / english$/); }
        return Response.json({ total: 3, itemSummaries: [
            { itemId: "v1|english|0", title: "Charizard Base Set 4/102 Holo English" },
            { itemId: "v1|german|0", title: "Charizard Base Set 4/102 Holo German" },
            { itemId: "v1|foreign-aspect|0", title: "Charizard Base Set 4/102 Holo", localizedAspects: [{ name: "Language", value: "Japanese" }] },
        ] });
    });
    const query = `offline-english-${Date.now()}`;
    for (const anyCategory of [false, true]) {
        const result = await searchListings(query, { anyCategory });
        assert.deepEqual(result.listings.map(row => row.id), ["v1|english|0"]);
        assert.equal(result.skipped, 2);
    }
    assert.equal(pages, 2);
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

test("explicit foreign-language searches consume no eBay requests", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("No source request is needed for an excluded language"); });
    await assert.rejects(searchListings("Japanese Charizard"), EnglishOnlyError);
    assert.equal(fetch.mock.callCount(), 0);
});

test("source filtering keeps assurance/holder wording without admitting other junk beside it", async t => {
    offlineEbayCredentials(t);
    const titles = ["Charizard Base Set 4/102 Holo Authenticity Guaranteed", "Charizard Base Set 4/102 Holo with a custom protective case",
        "Charizard custom card Authenticity Guaranteed with a custom protective case", "Charizard random mystery card Authenticity Guaranteed",
        "Charizard empty slab Authenticity Guaranteed", "Charizard replica with a custom protective case"];
    t.mock.method(globalThis, "fetch", async input => {
        const address = String(input);
        if (address.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (address.includes("rate_limit")) return Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse", rates: [{ count: 0, limit: 5000, remaining: 5000 }] }] }] });
        return Response.json({ total: titles.length, itemSummaries: titles.map((title, index) => ({ itemId: `v1|filter-${index}|0`, title, buyingOptions: ["FIXED_PRICE"], price: { currency: "USD", value: "100" } })) });
    });
    const result = await searchListings(`offline-filter-context-${Date.now()}`);
    assert.deepEqual(result.listings.map(row => row.title), titles.slice(0, 2));
    assert.equal(result.skipped, 4);
});
