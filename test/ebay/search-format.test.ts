import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import { searchListings } from "../../server/ebay/listings.ts";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";
import { offlineSearchSteps } from "../fixtures/search-steps.ts";
import { EnglishOnlyError } from "../../shared/card-language.ts";
import { createHuntInventoryScanner, findDeals } from "../../server/deals/find-deals.ts";
import { readSearchLocally } from "../../server/search/intent.ts";
import { readTitleByRules } from "../../server/ai/title-reader.ts";
import { sellerConditionClues } from "../../shared/raw-condition-claim.ts";
import type { MarketplaceOrder } from "../../shared/listing-filters.ts";

test("broad hunt inventory searches the CCG category without requiring seller language or spending on sports noise", async t => {
    offlineEbayCredentials(t);
    const source = "base set";
    const intent = { ...readSearchLocally(source, ["Base Set"]), finish: "HOLO" as const, minYear: 1999, maxYear: 2003,
        releaseYears: { "base set": 1999 } };
    const item = (id: string, title: string, categoryId?: string) => ({
        itemId: `v1|${id}|0`, title, buyingOptions: ["FIXED_PRICE"], conditionId: "4000", price: { value: "15", currency: "USD" },
        shippingOptions: [{ shippingCost: { value: "2", currency: "USD" } }],
        image: { imageUrl: "https://i.ebayimg.com/images/g/fixture/s-l225.jpg" },
        ...(categoryId && { categories: [{ categoryId }] }),
    });
    const fullCardQuery = "Charizard Base Set 4/102";
    const inventory = [
        item("gretzky", "1999-00 Upper Deck Wayne Gretzky #86 HOF 02v3"),
        item("brodeur", "1999-00 Upper Deck MVP Martin Brodeur #115 HOF 07pa", "183454"),
        item("sports-category", "1999 Rookie Single Card #1 Base Set", "261328"),
        item("sports-year", "Panini 2025 Donruss Optic Tyrone Tracy Jr. New York Giants #6 Base Set", "183454"),
        item("sports-league", "1999 NHL 25 Holo", "183454"),
        item("generic", "Charizard 4/102 Holo", "183454"),
        item("misfiled", "Base Set Holo Venusaur 15/102", "261328"),
        item("relevant", "Base Set Holo Blastoise 2/102", "183454"),
        item("sports-holder", "Pokémon Base Set Alakazam 1/102 Holo with Upper Deck holder", "183454"),
        item("foreign", "Japanese Charizard Base Set Holo", "183454"),
    ];
    const browse: URLSearchParams[] = [];
    t.mock.method(globalThis, "fetch", async input => {
        const url = new URL(String(input));
        if (url.pathname.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (url.pathname.includes("rate_limit")) return Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse", rates: [{ count: 0, limit: 5000, remaining: 5000 }] }] }] });
        assert.match(url.pathname, /item_summary\/search$/);
        browse.push(url.searchParams);
        if (url.searchParams.get("q") === fullCardQuery) {
            const alias = item("exact-alias", "Charizard Base Set Holo 4/102", "261328");
            return Response.json({ total: 1, itemSummaries: [alias] });
        }
        assert.equal(url.searchParams.get("q"), "pokemon base set");
        return Response.json({ total: inventory.length, itemSummaries: inventory });
    });
    const screened: string[] = [];
    const scan = createHuntInventoryScanner(new AbortController().signal, offlineSearchSteps([], {
        search: searchListings,
        soldScreening: () => async listing => {
            screened.push(listing.id);
            return { status: "UNAVAILABLE", exactScope: false, references: [], note: "Offline fixture." };
        },
    }));
    const { listings } = await scan(source, intent, { typeFilter: "FIXED_PRICE", kindFilter: "all" },
        { minProfit: 0, minRoi: 0 }, Date.now(), { excludeIds: new Set(), freshGrading: false });
    const expected = ["generic", "misfiled", "relevant", "sports-holder"].map(id => `v1|${id}|0`).sort();
    assert.deepEqual(listings.map(listing => listing.id).sort(), expected, "unknown language and generic Pokémon copy titles remain eligible");
    assert.deepEqual(screened.sort(), expected, "sports rows cannot start pricing or become photo candidates");
    assert.equal(browse[0].get("category_ids"), "183454");
    assert.equal(browse[0].get("aspect_filter"), null);
    assert.equal(browse.length, 1);

    const alias = await searchListings(fullCardQuery, { anyCategory: true });
    assert.equal(alias.listings[0]?.id, "v1|exact-alias|0", "exact card queries still recover a card filed in the wrong category");
    assert.equal(browse[1].get("category_ids"), null);
    assert.equal(browse[1].get("aspect_filter"), null);
});

test("Browse structured condition and wear notes reach seller clues", async t => {
    offlineEbayCredentials(t);
    t.mock.method(globalThis, "fetch", async input => {
        const address = String(input);
        if (address.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (address.includes("rate_limit")) return Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse", rates: [{ count: 0, limit: 5000, remaining: 5000 }] }] }] });
        assert.match(address, /item_summary\/search/);
        return Response.json({ total: 2, itemSummaries: [
            { itemId: "v1|disclosed|0", title: "Venusaur Base Set Holo Near Mint", conditionDescriptors: [
                { name: "Card Condition", values: [{ content: "Heavily Played (Poor)", additionalInfo: ["Creased"] }] },
            ] },
            { itemId: "v1|unknown-condition|0", title: "Venusaur Base Set Holo" },
        ] });
    });
    const { listings: [disclosed, unknown] } = await searchListings("Offline structured condition");
    assert.equal(disclosed.cardCondition, "Heavily Played (Poor)");
    assert.deepEqual(disclosed.conditionNotes, ["Creased"]);
    assert.equal(sellerConditionClues(disclosed).severe, true);
    assert.equal(unknown.conditionNotes, undefined);
});

test("malformed successful Browse responses do not become cached empty searches", async t => {
    offlineEbayCredentials(t);
    const query = "Offline truncated eBay response";
    let pages = 0;
    t.mock.method(globalThis, "fetch", async input => {
        const address = String(input);
        if (address.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (address.includes("rate_limit")) return Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse", rates: [{ count: 0, limit: 5000, remaining: 5000 }] }] }] });
        assert.match(address, /item_summary\/search/);
        return ++pages === 1
            ? new Response('{"total":1,"itemSummaries":[', { headers: { "content-type": "application/json" } })
            : Response.json({ total: 1, itemSummaries: [{ itemId: "v1|recovered-page|0", title: "Venusaur Base Set Holo" }] });
    });
    await assert.rejects(searchListings(query), /eBay returned unreadable data/);
    assert.equal((await searchListings(query)).listings[0]?.id, "v1|recovered-page|0");
    assert.equal((await searchListings(query)).total, 1);
    assert.equal(pages, 2);
});

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
        if (params.get("sort") === "price") matched.sort((a, b) => Number(a.price.value) - Number(b.price.value));
        return Response.json({ total: matched.length, itemSummaries: matched.slice(0, Number(params.get("limit"))) });
    });
    const run = (minPrice: number, maxPrice?: number, marketplaceOrder?: MarketplaceOrder) => findDeals(query, {
        minPrice, filters: { typeFilter: "FIXED_PRICE", maxPrice }, marketplaceOrder,
    }, {
        search: searchListings, readIntent: async value => readSearchLocally(value), readTitle: async value => readTitleByRules(value),
        soldScreening: () => async () => ({ status: "UNAVAILABLE", exactScope: false, references: [], note: "Offline market fixture." }),
    });
    const first = await run(50, 100);
    assert.deepEqual(first.map(row => row.id), ["v1|affordable|0"]);
    assert.ok(Number.isFinite(Date.parse(first[0].termsCheckedAt!)));
    assert.equal(requests.length, 1, "recover the candidate in one page, without extra provider work");
    assert.match(requests[0].get("filter")!, /price:\[50\.\.100\],priceCurrency:USD/);
    assert.equal(requests[0].get("sort"), "newlyListed");
    assert.equal(requests[0].get("limit"), "200");
    const repeated = await run(50, 100);
    assert.deepEqual(repeated.map(row => row.id), ["v1|affordable|0"]);
    assert.equal(repeated[0].termsCheckedAt, first[0].termsCheckedAt, "a cache hit cannot make the original Browse terms look newer");
    assert.equal(requests.length, 1, "an identical range reuses its cache");
    assert.deepEqual((await run(0, 100)).map(row => row.id), ["v1|affordable|0", "v1|cheap|0"]);
    assert.match(requests[1].get("filter")!, /price:\[\.\.100\],priceCurrency:USD/);
    assert.equal((await run(50, 600)).length, 50);
    assert.deepEqual(requests.slice(2).map(params => params.get("sort")), ["newlyListed", "price"]);
    assert.ok(requests.slice(2).every(params => /price:\[50\.\.600\],priceCurrency:USD/.test(params.get("filter")!)));
    assert.equal((await run(50, 600)).length, 50);
    assert.equal(requests.length, 4, "both source orders reuse their respective caches");
    await run(50);
    assert.ok(requests.slice(4).every(params => /price:\[50\],priceCurrency:USD/.test(params.get("filter")!)));
    await run(0);
    assert.ok(requests.slice(6).every(params => !params.get("filter")!.includes("price:")));
    assert.deepEqual(await run(100, 50), []);
    assert.equal(requests.length, 8, "wider and unbounded ranges cannot reuse a narrower page");
    assert.deepEqual((await run(0, 100, "lowest")).map(row => row.id), ["v1|cheap|0", "v1|affordable|0"]);
    assert.equal(requests[8].get("sort"), "price", "the selected order reaches Browse before result sorting");
    assert.equal(requests[8].get("limit"), "200");
    assert.equal((await run(50, 600, "lowest")).length, 50);
    assert.equal(requests.length, 9, "lowest-first reuses the existing cheaper-page cache and skips a duplicate source pass");
});

test("ordinary auction discovery reaches a soon-ending copy while new-listings discovery checks the newest page", async t => {
    offlineEbayCredentials(t);
    const now = Date.now();
    const query = "Venusaur Base Set";
    const makeAuction = (id: string, hours: number) => ({
        itemId: `v1|${id}|0`, title: "Venusaur Base Set Holo", buyingOptions: ["AUCTION"],
        currentBidPrice: { value: "10", currency: "USD" }, itemEndDate: new Date(now + hours * 3_600_000).toISOString(),
    });
    const inventory = [...Array.from({ length: 200 }, (_, index) => makeAuction(String(index), 48)), makeAuction("ends-today", 1)];
    const sorts: (string | null)[] = [];
    t.mock.method(globalThis, "fetch", async input => {
        const url = new URL(String(input));
        if (url.pathname.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (url.pathname.includes("rate_limit")) return Response.json({ rateLimits: [] });
        assert.match(url.pathname, /item_summary\/search$/);
        assert.doesNotMatch(url.searchParams.get("filter")!, /itemEndDate/);
        const sort = url.searchParams.get("sort");
        sorts.push(sort);
        const rows = sort === "endingSoonest" ? inventory.toSorted((a, b) => a.itemEndDate.localeCompare(b.itemEndDate)) : inventory;
        return Response.json({ total: rows.length, itemSummaries: rows.slice(0, Number(url.searchParams.get("limit"))) });
    });
    const steps = offlineSearchSteps([], { search: searchListings });
    const options = { filters: { typeFilter: "AUCTION" as const }, asOf: now };
    const run = (newOnly?: { excludeIds: string[] }) => findDeals(query, { ...options, newOnly,
        onStart: summary => assert.equal(summary.marketplaceOrder, newOnly ? "newest" : "ending"),
    }, steps);
    assert.deepEqual((await run()).map(row => row.id), ["v1|ends-today|0"]);
    assert.deepEqual(await run({ excludeIds: [] }), []);
    assert.deepEqual(sorts, ["endingSoonest", "newlyListed"]);
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

test("source searches apply format and grading kind without sending the ignored end-date filter or mixing cache scopes", async t => {
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
    await searchListings(query, { filters: { typeFilter: "AUCTION", kindFilter: "raw" } });
    await searchListings(query, { filters: { typeFilter: "AUCTION", kindFilter: "raw" } });
    await searchListings(query, { filters: { typeFilter: "FIXED_PRICE", kindFilter: "graded" } });
    await searchListings(query);
    assert.equal(filters.length, 3, "identical format requests reuse their own cache");
    assert.equal(filters[0], "buyingOptions:{AUCTION},conditionIds:{4000}");
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
        else { assert.equal(params.get("category_ids"), null); assert.equal(params.get("aspect_filter"), null);
            assert.doesNotMatch(params.get("q")!, / english$/i, "an English card need not put its language in the title"); }
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
        return Response.json({ total: titles.length, itemSummaries: titles.map((title, index) => ({ itemId: `v1|filter-${index}|0`, title,
            image: { imageUrl: `https://i.ebayimg.com/images/g/front-${index}/s-l500.jpg` },
            buyingOptions: ["FIXED_PRICE"], price: { currency: "USD", value: "100" } })) });
    });
    const result = await searchListings(`offline-filter-context-${Date.now()}`);
    assert.deepEqual(result.listings.map(row => row.title), titles.slice(0, 2));
    assert.equal(result.skipped, 4);
    assert.deepEqual(result.rejections?.map(({ id, reason, listing }) => ({ id, reason, title: listing?.title,
        images: listing?.images, currentPrice: listing?.currentPrice })), ["PROXY_OR_REPLICA", "MYSTERY", "EMPTY_HOLDER", "PROXY_OR_REPLICA"].map((reason, index) => ({
        id: `v1|filter-${index + 2}|0`, reason, title: titles[index + 2],
        currentPrice: 100,
        images: [`https://i.ebayimg.com/images/g/front-${index + 2}/s-l500.jpg`],
    })));
});
