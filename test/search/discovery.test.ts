import { test } from "node:test";
import assert from "node:assert/strict";
import { searchWithDiscovery } from "../../server/deals/search.ts";
import { digDeeper } from "../../server/deals/dig.ts";
import { digQueries } from "../../server/search/dig.ts";

const intent = { cardName: null, sets: ["Base Set"], cardNumber: null, printing: null, graded: false, titleWords: [], source: "rules" };
const listing = (id, overrides = {}) => ({ id, title: "1999 Base Set Mewtwo 10/102 holo", currentPrice: 30, shipping: 0, buyingOption: "FIXED_PRICE", isGraded: false, categoryId: "wrong", images: ["photo"], ...overrides });

test("every normal search automatically expands coverage with matching criteria and excludes its existing listings", async () => {
    const messages = [];
    const targets = { minProfit: 0, minRoi: 0 };
    const controller = new AbortController();
    let primarySent = false;
    await searchWithDiscovery("1999 base set holo", {
        targets, includeOffers: true, minPrice: 20, signal: controller.signal,
        onListing: (value) => messages.push(value.id),
        onDiscovery: (value) => messages.push(value.status),
    }, {
        find: async (_query, options) => {
            options.onStart({ intent });
            options.onListing(listing("primary"));
            primarySent = true;
            return [listing("primary")];
        },
        discover: async (_query, options) => {
            assert.equal(primarySent, true);
            assert.deepEqual(options.excludeIds, ["primary"]);
            assert.equal(options.targets, targets);
            assert.equal(options.includeOffers, true);
            assert.equal(options.minPrice, 20);
            assert.equal(options.signal, controller.signal);
            assert.equal(options.intent, intent);
            options.onStart({ total: 1, queries: ["extra"] });
            options.onListing(listing("extra"));
            options.onProgress(1, 1);
        },
    });
    assert.equal(messages[0], "primary");
    assert.ok(messages.includes("extra"));
    assert.equal(messages.at(-1), "done");
});

test("cancelled normal searches start no discovery and discovery failure preserves normal results", async () => {
    const controller = new AbortController();
    let calls = 0;
    const find = async () => { controller.abort(); return []; };
    const discover = async () => { calls += 1; throw new Error("reserve reached"); };
    await searchWithDiscovery("mewtwo", { signal: controller.signal }, { find, discover });
    assert.equal(calls, 0);
    const progress = [];
    await searchWithDiscovery("mewtwo", { onDiscovery: (value) => progress.push(value) }, { find: async () => [listing("kept")], discover });
    assert.equal(progress.at(-1).status, "error");
    assert.equal(progress.at(-1).note, "reserve reached");
});

test("broad discovery uses the exact phrase without requesting invented card variants", async () => {
    assert.deepEqual(await digQueries("1999 base set holo", intent), [
        { query: "1999 base set holo", how: "WRONG_CATEGORY", anyCategory: true },
        { query: "Base Set card", how: "PHOTO_SHOWS_IT" },
        { query: "old card 1999", how: "PHOTO_SHOWS_IT" },
    ]);
});

test("extra checks deduplicate, retain auction minimum-price exemption, and exclude wrong grades and printings", async () => {
    const checked = [];
    const sent = [];
    let photoCalls = 0;
    const wrongPrinting = { ...intent, printing: "FIRST_EDITION" };
    const extra = listing("extra");
    await digDeeper("1999 base set holo", {
        intent: wrongPrinting, excludeIds: ["already"], minPrice: 20,
        onListing: (value) => sent.push(value),
    }, {
        plan: async () => [{ query: "a", how: "WRONG_CATEGORY" }, { query: "b", how: "WRONG_CATEGORY" }],
        readIntent: async () => { throw new Error("must reuse known intent"); },
        findPhoto: async () => { photoCalls += 1; return { found: "YES", cardCount: 1, set: "Base Set", cardNumber: "10/102", shows: "Actual card" }; },
        search: async (_query, options) => {
            assert.equal(options.keepReserve, true);
            return { listings: [listing("already"), extra, extra, listing("cheap", { currentPrice: 1 }), listing("auction", { currentPrice: 1, buyingOption: "AUCTION" }), listing("slab", { isGraded: true }), listing("normal-category", { categoryId: "183454" })], total: 7, skipped: 0 };
        },
        screening: () => ({
            readTitle: async ({ title }) => ({ aspects: { Set: "Base Set" }, filled: [], kind: "SINGLE_CARD" }),
            loadDetails: async () => { throw new Error("dropped items don't need details"); },
            matchPhoto: async () => { throw new Error("dropped items don't need photos"); },
            check: async (input) => {
                checked.push(input.price);
                return { status: "DROPPED", card: { set: "Base Set", printing: "UNLIMITED" }, incomplete: false };
            },
        }),
    });
    assert.equal(checked.length, 3);
    assert.deepEqual(sent.map((value) => value.id).sort(), ["auction", "extra", "normal-category"]);
    assert.ok(sent.every((value) => value.match === "OTHER_PRINTING"));
    assert.equal(photoCalls, 3);
});

test("automatic photo work is bounded and shared across query families rather than consumed by the first page", async () => {
    const photographed = [];
    let total;
    const makePage = (prefix) => Array.from({ length: 200 }, (_, index) => listing(`${prefix}-${index}`, { images: [`${prefix}-${index}`] }));
    await digDeeper("base set holo", {
        intent, primaryListings: makePage("primary").map((value) => ({ ...value, screen: { status: "DROPPED" } })),
        onStart: (value) => { total = value.total; },
    }, {
        plan: async () => [{ query: "generic", how: "PHOTO_SHOWS_IT" }, { query: "wrong", how: "WRONG_CATEGORY" }],
        readIntent: async () => intent,
        search: async (query) => ({ listings: makePage(query), total: 200, skipped: 0 }),
        findPhoto: async (image) => { photographed.push(image); return null; },
        screening: () => ({}),
    });
    assert.ok(photographed.length <= 120);
    assert.ok(photographed.length <= total);
    assert.ok(photographed.length < 120, "empty discovery backs off before the full ceiling");
    assert.equal(new Set(photographed).size, photographed.length);
    for (const prefix of ["primary", "generic", "wrong"]) assert.ok(photographed.some((image) => image.startsWith(prefix)));
});

test("cancelling discovery starts no subsequent photo checks", async () => {
    const controller = new AbortController();
    let calls = 0;
    await digDeeper("base set holo", { intent, signal: controller.signal }, {
        plan: async () => [{ query: "generic", how: "PHOTO_SHOWS_IT" }], readIntent: async () => intent,
        search: async () => ({ listings: Array.from({ length: 100 }, (_, i) => listing(String(i))), total: 100, skipped: 0 }),
        findPhoto: async () => { calls += 1; controller.abort(); return null; }, screening: () => ({}),
    });
    assert.equal(calls, 1);
});
