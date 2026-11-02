import { test } from "node:test";
import assert from "node:assert/strict";
import { findDeals, type ScreenSteps } from "../../server/deals/find-deals.ts";
import { digDeeper } from "../../server/deals/dig.ts";
import { readListingFilters } from "../../server/search/listing-filters.ts";
import { withinAutomaticAuctionWindow, worthScreening } from "../../shared/listing-filters.ts";
import type { ListingSummary, SearchIntent } from "../../shared/types.ts";

const intent: SearchIntent = { cardName: null, sets: [], cardNumber: null, printing: null, graded: null, titleWords: [], source: "rules" };
const listing = (id: string, overrides: Partial<ListingSummary> = {}): ListingSummary => ({
    id, title: `Pokemon card ${id}`, currentPrice: 50, shipping: 0, bids: 0, isGraded: false,
    buyingOption: "FIXED_PRICE", endTime: overrides.buyingOption === "AUCTION" ? new Date(Date.now() + 2 * 3600000).toISOString() : null, images: [id], url: `https://example.invalid/${id}`, seller: null, ...overrides,
});
const droppedSteps = (): ScreenSteps => ({
    readTitle: async () => ({ aspects: {}, filled: [], condition: null, kind: "SINGLE_CARD" }),
    check: async () => ({ status: "DROPPED", reason: "Offline price check found no margin", card: null, bestCase: null, assumed: null }),
    matchPhoto: async () => { assert.fail("a dropped preliminary price needs no paid photo check"); },
    loadDetails: async () => { assert.fail("a dropped preliminary price needs no details lookup"); },
});

test("primary filters exclude known mismatches and a $223,200 listing before any title batch", async () => {
    const warmed: string[] = [];
    const rows = [listing("raw"), listing("auction", { currentPrice: 5, buyingOption: "AUCTION" }),
        listing("cheap-bin", { currentPrice: 5 }), listing("slab", { isGraded: true }),
        listing("over-user-ceiling", { currentPrice: 150 }), listing("absurd", { currentPrice: 223_200 })];
    const result = await findDeals("pokemon", { minPrice: 30, filters: { kindFilter: "raw", maxPrice: 100 } }, {
        readIntent: async () => intent,
        search: async () => ({ listings: rows, total: rows.length, skipped: 0 }),
        readTitle: async title => { warmed.push(title); return null; }, screening: droppedSteps,
    });
    assert.deepEqual(result.map(row => row.id), ["raw", "auction"]);
    assert.deepEqual(warmed, rows.slice(0, 2).map(row => row.title));
    warmed.length = 0;
    await findDeals("pokemon", {}, {
        readIntent: async () => intent,
        search: async () => ({ listings: [rows[0], rows[5]], total: 2, skipped: 0 }),
        readTitle: async title => { warmed.push(title); return null; }, screening: droppedSteps,
    });
    assert.deepEqual(warmed, [rows[0].title], "the automatic ceiling also applies when no user ceiling is set");
});

test("discovery applies filters to primary and secondary sources before photos while retaining vague and misspelled auctions", async () => {
    const photographed: string[] = [], emitted: string[] = []; let searches = 0;
    await digDeeper("pokemon", {
        intent, filters: { typeFilter: "AUCTION", kindFilter: "raw", minPrice: 30, maxPrice: 100 },
        primaryListings: [listing("primary-bin"), listing("primary-absurd", { currentPrice: 223_200, buyingOption: "AUCTION" })],
        onListing: row => { emitted.push(row.id); },
    }, {
        readIntent: async () => intent, plan: async () => [{ query: "old pokemon card", how: "PHOTO_SHOWS_IT" }],
        search: async () => { searches++; return { total: 6, skipped: 0, listings: [
            listing("generic", { title: "Old Pokemon card", currentPrice: 5, buyingOption: "AUCTION" }),
            listing("typo", { title: "Charzard", currentPrice: 7, buyingOption: "AUCTION" }),
            listing("bin"), listing("graded", { isGraded: true, buyingOption: "AUCTION" }),
            listing("expensive", { currentPrice: 150, buyingOption: "AUCTION" }),
            listing("absurd", { currentPrice: 223_200, buyingOption: "AUCTION" }),
        ] }; },
        findPhoto: async photo => { photographed.push(photo); return { found: "YES", cardCount: 1, set: null, cardNumber: null, shows: "One raw card" }; },
        screening: droppedSteps,
    });
    assert.deepEqual(photographed.sort(), ["generic", "typo"]);
    assert.deepEqual(emitted.sort(), ["generic", "typo"]); assert.equal(searches, 1);
});

test("eligible listings still receive a preliminary price check before their main-photo assessment", async () => {
    const order: string[] = [];
    const steps = droppedSteps();
    steps.check = async () => { order.push("price"); return { status: "CANDIDATE", card: { name: "Venusaur", set: "Base Set", cardNumber: "15/102", printing: "UNLIMITED", printingLabel: "Unlimited" }, reason: "Offline margin", bestCase: null, assumed: null }; };
    steps.matchPhoto = async () => { order.push("photo"); return { verdict: "MATCH", problems: [], firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT" }; };
    steps.loadDetails = async () => { order.push("details"); throw Error("offline details unavailable"); };
    const rows = await findDeals("pokemon", { filters: { maxPrice: 100 } }, {
        readIntent: async () => intent, search: async () => ({ listings: [listing("eligible")], total: 1, skipped: 0 }),
        readTitle: async () => null, screening: () => steps,
    });
    assert.deepEqual(order, ["price", "photo", "details"]); assert.equal(rows.length, 1);
});

test("server listing filters accept valid numeric bounds and ignore malformed query values", () => {
    assert.deepEqual(readListingFilters({ type: "AUCTION", kind: "raw", min: "30", ceiling: "100" }), { typeFilter: "AUCTION", kindFilter: "raw", minPrice: 30, maxPrice: 100 });
    assert.deepEqual(readListingFilters({ type: "bogus", kind: ["raw"], min: "NaN", ceiling: "-1" }), { typeFilter: "all", kindFilter: "all", minPrice: undefined, maxPrice: undefined });
});

test("automatic auctions require a known end strictly ahead and within12hours before title or photo work", async () => {
    const now = Date.now();
    for (const [hours, expected] of [[-1, false], [0, false], [1, true], [12, true], [12.001, false], [24, false]] as const) {
        const auction = listing(String(hours), { buyingOption: "AUCTION", endTime: new Date(now + hours * 3600000).toISOString() });
        assert.equal(withinAutomaticAuctionWindow(auction, now), expected);
        assert.equal(worthScreening(auction, {}, now), expected);
    }
    for (const endTime of [null, "invalid"]) assert.equal(withinAutomaticAuctionWindow(listing("unknown", { buyingOption: "AUCTION", endTime }), now), false);
    assert.equal(withinAutomaticAuctionWindow(listing("bin"), now), true);
    const warmed: string[] = [];
    const rows = [listing("soon", { buyingOption: "AUCTION" }), listing("late", { buyingOption: "AUCTION", endTime: new Date(now + 24 * 3600000).toISOString() }), listing("unknown", { buyingOption: "AUCTION", endTime: null })];
    await findDeals("pokemon", {}, { readIntent: async () => intent, search: async () => ({ listings: rows, total: 3, skipped: 0 }),
        readTitle: async title => { warmed.push(title); return null; }, screening: droppedSteps });
    assert.deepEqual(warmed, [rows[0].title]);
});
