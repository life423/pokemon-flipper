import assert from "node:assert/strict";
import test from "node:test";
import type { ListingSummary, SearchIntent } from "../../shared/types.ts";
import { getAiUsageContext } from "../../server/ai/usage-context.ts";
import { discoverMarketListings } from "../../server/analysis/same-set-listings.ts";
import { shortlistMarketCopies } from "../../server/analysis/deal-hunt-market-checks.ts";

const source = "743c9275-1cb4-4cd5-8ced-0ffe67777611";
const market: SearchIntent = { cardName: "Dark Gengar", sets: ["Neo Destiny"], cardNumber: "6/105", printing: "UNLIMITED",
    finish: "HOLO", graded: false, titleWords: ["dark", "gengar"], source: "rules" };
const signal = new AbortController().signal;
function listing(index: number, title: string, overrides: Partial<ListingSummary> = {}): ListingSummary {
    const number = 120000000000 + index;
    return { id: `v1|${number}|0`, url: `https://www.ebay.com/itm/${number}`, title, buyingOption: "FIXED_PRICE",
        currentPrice: 50, shipping: 5, isGraded: false, bids: 0, seller: null, endTime: null, images: ["photo"], ...overrides };
}
const knownSets = async () => ["Silver Tempest", "Neo Destiny"];

test("a liquid-market search spends a single reserved Browse page under the original search and screens the returned copies", async () => {
    const original = listing(1, "Dark Gengar 6/105 Neo Destiny Unlimited Holo");
    const numberless = listing(2, "Dark Gengar Neo Destiny");
    const others = [
        listing(3, "Dark Gengar 6/105 1st Edition"), listing(4, "Dark Gengar 6/105 Neo Destiny Reverse Holo"),
        listing(5, "Dark Gengar 6/105 Silver Tempest"), listing(6, "Dark Gengar 7/105 Neo Destiny"),
        listing(7, "Dark Gengar 6/105 Japanese"), listing(8, "Dark Gyarados 6/105 Neo Destiny"), listing(9, "Dark Gengar 6/105 lot of 3 cards"),
        listing(10, original.title, { buyingOption: "AUCTION" }), listing(11, original.title, { currentPrice: 101 }),
        listing(12, original.title, { currentPrice: 9 }), listing(13, original.title, { images: [] }), listing(14, original.title, { isGraded: true }),
        listing(15, original.title, { endTime: "2024-01-01T00:00:00Z" }), listing(16, original.title, { url: "https://example.org/" }),
    ];
    let requests = 0;
    const result = await discoverMarketListings(source, market, { minPrice: 10, maxPrice: 100 }, signal, {
        knownSets,
        search: async (query, options) => {
            requests++;
            assert.match(query, /Dark Gengar 6 Neo Destiny/);
            assert.equal(getAiUsageContext().searchId, source);
            assert.deepEqual(options, { sort: "price", filters: { typeFilter: "FIXED_PRICE", kindFilter: "raw", minPrice: 10, maxPrice: 100 },
                maxResults: 200, cacheMode: "resume", keepReserve: true, signal });
            return { listings: [original, ...others, original, numberless], total: 800, skipped: 0 };
        },
    });
    assert.equal(requests, 1);
    assert.deepEqual(result.map(row => row.id), [original.id, numberless.id]);
    assert.equal(result[1].screen?.status, "UNSCREENED");
});

test("a precise slab market excludes different holders, qualifiers and grades while keeping exact-grade half points", async () => {
    const slab = { ...market, graded: true, grader: "CGC", minGrade: 8.5, maxGrade: 8.5 };
    const rows = ["CGC 8.5", "CGC 8", "PSA 8.5", "CGC 8.5 (OC)"].map((grade, index) =>
        listing(index, `Dark Gengar Neo Destiny 6/105 ${grade}`, { isGraded: true }));
    const found = await discoverMarketListings(source, slab, {}, signal, { knownSets, search: async (query, options) => {
        assert.match(query, /CGC 8\.5$/);
        assert.equal(options?.filters?.kindFilter, "graded");
        return { listings: rows, total: rows.length, skipped: 0 };
    } });
    assert.deepEqual(found.map(row => row.id), [rows[0].id]);
});

test("a copy later in the same paid Browse page can win once destination shipping and tax are included", async () => {
    const title = "Dark Gengar Neo Destiny 6/105 Unlimited Holo";
    const unaffordable = Array.from({ length: 50 }, (_, index) => listing(index, title, { shipping: 90 }));
    const affordable = listing(50, title, { shipping: 0 });
    const rows = [...unaffordable, affordable], filters = { maxPrice: 100 };
    const found = await discoverMarketListings(source, market, filters, signal, {
        knownSets, search: async () => ({ listings: rows, total: rows.length, skipped: 0 }),
    });
    const shortlist = shortlistMarketCopies(found, {
        name: "Dark Gengar", set: "Neo Destiny", cardNumber: "6/105", printing: "UNLIMITED", finish: "HOLO", kind: "raw", condition: "LIGHTLY_PLAYED",
        grader: null, grade: null, sales30: 3, sales90: 3, latestSaleAt: new Date().toISOString(), medianUsd: 150, projectedProfit: null, listingIds: [],
    }, "resell", { minProfit: 0, minRoi: 0 }, filters);
    assert.deepEqual(shortlist.map(row => row.id), [affordable.id]);
});

test("unspecified markets, a different requested card kind, or prior cancellation avoid a provider search", async () => {
    const deps = { knownSets, search: async () => assert.fail("unexpected eBay call") };
    assert.deepEqual(await discoverMarketListings(source, market, { kindFilter: "graded" }, signal, deps), []);
    assert.deepEqual(await discoverMarketListings(source, { ...market, sets: [] }, {}, signal, deps), []);
    assert.deepEqual(await discoverMarketListings(source, { ...market, printing: null }, {}, signal, deps), []);
    assert.deepEqual(await discoverMarketListings("unknown", market, {}, signal, deps), []);
    await assert.rejects(discoverMarketListings(source, market, {}, AbortSignal.abort(), deps), { name: "AbortError" });
});

test("Browse uses seller-facing release names and card numbers while screening against the full catalog market", async () => {
    const cases = [
        { cardName: "Mew", set: "SWSH: Crown Zenith: Galarian Gallery", cardNumber: "GG10/GG70", grade: 9,
            query: "Mew GG10 Crown Zenith PSA 9",
            matching: "Mew GG10/GG70 Crown Zenith Galarian Gallery Holo PSA 9",
            wrong: "Mew GG11/GG70 Crown Zenith Holo PSA 9" },
        { cardName: "Mew", set: "SWSH: Crown Zenith: Galarian Gallery", cardNumber: "GG10/GG70", grade: 9,
            query: "Mew GG10 Crown Zenith PSA 9", matching: "2023 POKEMON SWORD & SHIELD CROWN ZENITH #GG10 FULL ART/MEW PSA 9",
            wrong: "2023 POKEMON SWORD & SHIELD CROWN ZENITH #10 FULL ART/MEW PSA 9" },
        { cardName: "Mewtwo", set: "Base Set", cardNumber: "010/102", grade: 8,
            query: "Mewtwo 10 Base Set PSA 8",
            matching: "Mewtwo 10/102 Base Set Holo PSA 8", wrong: "Mewtwo 10/130 Base Set 2 Holo PSA 8" },
        { cardName: "Blastoise", set: "Base Set", cardNumber: "002/102", grade: 8,
            query: "Blastoise 2 Base Set PSA 8",
            matching: "Blastoise 2/102 Base Set Holo PSA 8", wrong: "Blastoise 2/130 Base Set 2 Holo PSA 8" },
    ];
    for (const c of cases) {
        const intent = { ...market, cardName: c.cardName, cardNumber: c.cardNumber, sets: [c.set], graded: true, grader: "PSA", minGrade: c.grade, maxGrade: c.grade };
        const exact = listing(1, c.matching, { isGraded: true });
        const found = await discoverMarketListings(source, intent, {}, signal, {
            knownSets: async () => ["Base Set", "Base Set 2", "Crown Zenith", c.set],
            search: async query => {
                assert.equal(query, c.query);
                return { listings: [exact, listing(2, c.wrong, { isGraded: true })], total: 2, skipped: 0 };
            },
        });
        assert.deepEqual(found.map(row => row.id), [exact.id], c.matching);
    }
});

test("one Browse can screen several eligible finishes without admitting an unrelated finish or another release", async () => {
    const titles = ["Holo", "Reverse Holo", "Non Holo"].map((variant, i) => listing(i, `Dark Gengar 6/105 Neo Destiny ${variant}`));
    const found = await discoverMarketListings(source, market, {}, signal, {
        relatedIntents: [{ ...market, finish: "REVERSE_HOLO" }, { ...market, sets: ["Jungle"], finish: "NON_HOLO" }],
        knownSets, search: async () => ({ listings: titles, total: 3, skipped: 0 }),
    });
    assert.deepEqual(found.map(row => row.id), titles.slice(0, 2).map(row => row.id));
});

test("auction market discovery orders by ending time and keeps only auctions below ten hours", async () => {
    const now = Date.now(), hour = 3_600_000, title = "Dark Gengar 6/105 Neo Destiny Unlimited Holo";
    const rows = [9, 10, 11, 0].map((hours, i) => listing(i + 1, title, {buyingOption: "AUCTION", endTime: new Date(now + hours * hour).toISOString()}));
    const found = await discoverMarketListings(source, market, {typeFilter: "AUCTION"}, signal, {
        now: () => now, knownSets, search: async (_q, config) => {
            assert.equal(config?.sort, "endingSoonest");
            assert.equal(config?.filters?.typeFilter, "AUCTION");
            return {listings: [...rows, listing(6, title)], total: 5, skipped: 0};
        },
    });
    assert.deepEqual(found.map(r => r.id), [rows[0].id]);
});
