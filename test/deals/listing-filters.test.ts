import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDeals } from "../../server/deals/find-deals.ts";
import { readListingFilters } from "../../server/search/listing-filters.ts";
import { withinAutomaticAuctionWindow, worthScreening } from "../../shared/listing-filters.ts";
import { offlineSearchSteps } from "../fixtures/search-steps.ts";
import type { ListingSummary } from "../../shared/types.ts";

const listing = (id: string, overrides: Partial<ListingSummary> = {}): ListingSummary => ({
    id, title: `Pokemon card ${id}`, currentPrice: 50, shipping: 0, bids: 0, isGraded: false,
    buyingOption: "FIXED_PRICE", endTime: overrides.buyingOption === "AUCTION" ? new Date(Date.now() + 2 * 3600000).toISOString() : null,
    images: [id], url: `https://example.invalid/${id}`, seller: null, ...overrides,
});

test("raw/type/price and absolute ceilings exclude metadata before title or sold research", async () => {
    const read: string[] = [], sold: string[] = [];
    const rows = [listing("raw"), listing("auction", { currentPrice: 5, buyingOption: "AUCTION" }), listing("cheap-bin", { currentPrice: 5 }),
        listing("slab", { isGraded: true }), listing("over-ceiling", { currentPrice: 150 }), listing("absurd", { currentPrice: 223200 })];
    const steps = offlineSearchSteps(rows, {
        readTitle: async title => { read.push(title); return offlineSearchSteps([]).readTitle(title); },
        soldScreening: () => async value => { sold.push(value.id); return { status: "UNAVAILABLE", exactScope: false, references: [], note: "Offline missing prices" }; },
    });
    assert.deepEqual((await findDeals("pokemon", { minPrice: 30, filters: { kindFilter: "raw", maxPrice: 100 } }, steps)).map(row => row.id), ["raw", "auction"]);
    assert.deepEqual(read, rows.slice(0, 2).map(row => row.title)); assert.deepEqual(sold, ["raw", "auction"]);
    read.length = 0;
    await findDeals("pokemon", {}, { ...steps, search: async () => ({ listings: [rows[0], rows[5]], total: 2, skipped: 0 }) });
    assert.deepEqual(read, [rows[0].title]);
});

test("server listing filters accept valid numeric bounds and ignore malformed query values", () => {
    assert.deepEqual(readListingFilters({ type: "AUCTION", kind: "raw", min: "30", ceiling: "100" }), { typeFilter: "AUCTION", kindFilter: "raw", minPrice: 30, maxPrice: 100 });
    assert.deepEqual(readListingFilters({ type: "bogus", kind: ["raw"], min: "NaN", ceiling: "-1" }), { typeFilter: "all", kindFilter: "all", minPrice: undefined, maxPrice: undefined });
});

test("automatic auctions require a known future end within12hours before local or provider work", async () => {
    const now = Date.now();
    for (const [hours, expected] of [[-1, false], [0, false], [1, true], [12, true], [12.001, false], [24, false]] as const) {
        const auction = listing(String(hours), { buyingOption: "AUCTION", endTime: new Date(now + hours * 3600000).toISOString() });
        assert.equal(withinAutomaticAuctionWindow(auction, now), expected); assert.equal(worthScreening(auction, {}, now), expected);
    }
    for (const endTime of [null, "invalid"]) assert.equal(withinAutomaticAuctionWindow(listing("unknown", { buyingOption: "AUCTION", endTime }), now), false);
    assert.equal(withinAutomaticAuctionWindow(listing("bin"), now), true);
    const read: string[] = [];
    const rows = [listing("soon", { buyingOption: "AUCTION" }), listing("late", { buyingOption: "AUCTION", endTime: new Date(now + 24 * 3600000).toISOString() }), listing("unknown", { buyingOption: "AUCTION", endTime: null })];
    await findDeals("pokemon", {}, offlineSearchSteps(rows, { readTitle: async title => { read.push(title); return offlineSearchSteps([]).readTitle(title); } }));
    assert.deepEqual(read, [rows[0].title]);
});
