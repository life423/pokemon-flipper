import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import { searchListings } from "../../server/ebay/listings.ts";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";
import { EnglishOnlyError } from "../../shared/card-language.ts";
import { findDeals } from "../../server/deals/find-deals.ts";
import { readSearchLocally } from "../../server/search/intent.ts";
import { readTitleByRules } from "../../server/ai/title-reader.ts";

test("a bounded Buy It Now search reaches affordable inventory beyond 200 out-of-range listings and scopes its cache to prices", async t => {
    offlineEbayCredentials(t);
    const query = `Charizard Base Set 4/102 Holo`;
    const item = (id: string, price: number) => ({ itemId: `v1|${id}|0`, title: query, buyingOptions: ["FIXED_PRICE"], conditionId: "4000",
        price: { currency: "USD", value: String(price) }, shippingOptions: [{ shippingCost: { currency: "USD", value: "0" } }],
        image: { imageUrl: "https://i.ebayimg.com/images/g/offline/s-l225.jpg" } });
    const inventory = [...Array.from({ length: 200 }, (_, i) => item(`expensive-${i}`, 500)), item("affordable", 80), item("cheap", 10)];
    const requests: URLSearchParams[] = [];
    t.mock.method(globalThis, "fetch", async input => {
        const address = String(input);
        if (address.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (address.includes("rate_limit")) return Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse", rates: [{ count: 0, limit: 5000, remaining: 5000 }] }] }] });
        const params = new URL(address).searchParams;
        assert.match(new URL(address).pathname, /item_summary\/search$/);
        requests.push(params);
        const range = params.get("filter")!.match(/(?:^|,)price:\[([^\]]+)\]/)?.[1];
        const [minimum, maximum] = range?.includes("..") ? range.split("..") : [range, undefined];
        const matched = inventory.filter(row => Number(row.price.value) >= Number(minimum || 0) && Number(row.price.value) <= (maximum ? Number(maximum) : Infinity));
        return Response.json({ total: matched.length, itemSummaries: matched.slice(0, Number(params.get("limit"))) });
    });
    const run = (minPrice: number, maxPrice?: number) => findDeals(query, {
        minPrice, filters: { typeFilter: "FIXED_PRICE", maxPrice },
    }, {
        search: searchListings, readIntent: async value => readSearchLocally(value), readTitle: async value => readTitleByRules(value),
        soldScreening: () => async () => ({ status: "UNAVAILABLE", exactScope: false, references: [], note: "Offline market fixture." }),
    });
    assert.deepEqual((await run(50, 100)).map(row => row.id), ["v1|affordable|0"]);
    assert.equal(requests.length, 1, "recover the candidate in one page, without extra provider work");
    assert.match(requests[0].get("filter")!, /price:\[50\.\.100\],priceCurrency:USD/);
    assert.equal(requests[0].get("sort"), "newlyListed");
    assert.equal(requests[0].get("limit"), "200");
    assert.deepEqual((await run(50, 100)).map(row => row.id), ["v1|affordable|0"]);
    assert.equal(requests.length, 1, "an identical range reuses its cache");
    assert.deepEqual((await run(0, 100)).map(row => row.id), ["v1|affordable|0", "v1|cheap|0"]);
    assert.match(requests[1].get("filter")!, /price:\[\.\.100\],priceCurrency:USD/);
    assert.equal((await run(50, 600)).length, 50);
    assert.match(requests[2].get("filter")!, /price:\[50\.\.600\],priceCurrency:USD/);
    await run(50);
    assert.match(requests[3].get("filter")!, /price:\[50\],priceCurrency:USD/);
    await run(0);
    assert.doesNotMatch(requests[4].get("filter")!, /price:/);
    assert.deepEqual(await run(100, 50), []);
    assert.equal(requests.length, 5, "wider and unbounded ranges cannot reuse a narrower page");
});

test("BIN price bounds never become auction or mixed-search source filters", async t => {
    offlineEbayCredentials(t);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async input => {
        const address = String(input);
        if (address.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (address.includes("rate_limit")) return Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse", rates: [{ count: 0, limit: 5000, remaining: 5000 }] }] }] });
        assert.doesNotMatch(new URL(address).searchParams.get("filter")!, /price:|priceCurrency:/);
        requests++;
        return Response.json({ total: 1, itemSummaries: [{ itemId: "v1|low-bid|0", title: "Charizard Base Set 4/102 Holo", buyingOptions: ["AUCTION"],
            currentBidPrice: { currency: "USD", value: "1" }, price: { currency: "USD", value: "500" } }] });
    });
    for (const typeFilter of ["AUCTION", "all"] as const) {
        const result = await searchListings(`offline-auction-price-bounds`, { filters: { typeFilter, minPrice: 50, maxPrice: 100 } });
        assert.equal(result.listings[0].currentPrice, 1);
    }
    assert.equal(requests, 2);
});

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
