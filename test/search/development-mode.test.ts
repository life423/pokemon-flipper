import { test } from "node:test";
import assert from "node:assert/strict";
import { findDeals, type SearchSummary, type ScreenSteps } from "../../server/deals/find-deals.ts";
import { searchWithDiscovery } from "../../server/deals/search.ts";
import { createNewListingDiscovery } from "../../server/deals/new-listings.ts";
import { pricingSnapshotKey } from "../../shared/pricing-retries.ts";
import { DEVELOPMENT_SEARCH_LIMIT } from "../../shared/research-policy.ts";
import type { ListingSummary, SearchIntent } from "../../shared/types.ts";

const intent: SearchIntent = { cardName: null, sets: [], cardNumber: null, printing: null, graded: null, titleWords: [], source: "rules" };
const rows = Array.from({ length: 200 }, (_, index): ListingSummary => ({ id: String(index), title: `Pokemon card ${index}`, currentPrice: 80,
    shipping: 0, buyingOption: "FIXED_PRICE", bids: 0, isGraded: false, images: [String(index)], url: "#", seller: null, endTime: null }));
function fixture(page = rows) {
    const titles: string[] = [], sources: number[] = [], emitted: ListingSummary[] = []; let summary: SearchSummary | undefined;
    const screening: ScreenSteps = {
        readTitle: async () => ({ aspects: {}, filled: [], condition: null, kind: "SINGLE_CARD" }),
        check: async () => ({ status: "UNSCREENED", reason: "Offline temporary price issue", card: null, assumed: null, bestCase: null, pricingIssue: { kind: "TEMPORARY", retryAt: null } }),
        deferPricing: listing => ({ ticket: "offline-retry", snapshotKey: pricingSnapshotKey(listing), retryAt: new Date().toISOString(), attemptsLeft: 1 }),
        loadDetails: async () => { assert.fail("an incomplete development sample should not fetch details"); },
        matchPhoto: async () => { assert.fail("an incomplete development sample should not request another photo"); },
    };
    const find: typeof findDeals = (query, options) => findDeals(query, options, {
        readIntent: async () => { assert.fail("bounded metadata cannot buy intent AI"); },
        readIntentWithoutAi: async () => intent,
        search: async (_query, settings) => { sources.push(settings?.maxResults ?? 0); return { listings: page, total: 1000, skipped: 0 }; },
        readTitle: async title => { titles.push(title); assert.fail("bounded metadata cannot buy title AI"); }, screening: () => screening,
    });
    return { find, titles, sources, emitted, onListing: (row: ListingSummary) => { emitted.push(row); }, onStart: (value: SearchSummary) => { summary = value; }, getSummary: () => summary };
}

test("development normal searches admit50 eligible metadata rows without title AI or discovery/recovery", async () => {
    const sample = fixture(); let discovery = 0, retries = 0;
    await searchWithDiscovery("pokemon", { bounded: true, developmentLimit: DEVELOPMENT_SEARCH_LIMIT, maxResults: 1000, onStart: sample.onStart, onListing: sample.onListing }, {
        find: sample.find, discover: async () => { discovery++; }, recover: async () => { retries++; },
    });
    assert.deepEqual(sample.sources, [200]); assert.equal(sample.titles.length, 0); assert.equal(sample.emitted.length, 50);
    assert.ok(sample.emitted.every(row => row.screen?.status === "UNSCREENED"), "metadata is not a paid photo assessment or verified price");
    assert.equal(sample.getSummary()?.mode, "development"); assert.equal(sample.getSummary()?.count, 50); assert.equal(sample.getSummary()?.deferred, 150);
    assert.equal(discovery, 0); assert.equal(retries, 0);
});

test("development newest scans admit50 unseen eligible metadata rows, remember only them and skip recovery", async () => {
    const sample = fixture(); let retries = 0; let remembered: readonly string[] = [];
    const discover = createNewListingDiscovery({ find: sample.find, usage: async () => null,
        history: { seen: async () => ["1"], remember: async (_query, _minimum, ids) => { remembered = ids; } },
        recover: async () => { retries++; },
    });
    await discover("pokemon", { bounded: true, developmentLimit: DEVELOPMENT_SEARCH_LIMIT, onStart: sample.onStart, onListing: sample.onListing });
    assert.deepEqual(sample.sources, [200]); assert.equal(sample.titles.length, 0); assert.equal(sample.emitted.length, 50);
    assert.ok(sample.emitted.every(row => row.id !== "1"));
    assert.deepEqual(remembered, sample.emitted.map(row => row.id)); assert.equal(retries, 0);
    assert.equal(sample.getSummary()?.mode, "development"); assert.equal(sample.getSummary()?.deferred, 149);
});

test("foreign, absurdly priced and filtered rows do not consume the50 matching metadata slots", async () => {
    const page = rows.map(row => ({ ...row }));
    page[0].title = "Japanese Pokemon card"; page[1].currentPrice = 223_200; page[2].isGraded = true;
    const sample = fixture(page);
    await searchWithDiscovery("pokemon", { bounded: true, developmentLimit: DEVELOPMENT_SEARCH_LIMIT, filters: { kindFilter: "raw" }, onListing: sample.onListing }, {
        find: sample.find, discover: async () => { assert.fail("development cannot start broad discovery"); }, recover: async () => { assert.fail("development cannot start pricing recovery"); },
    });
    assert.deepEqual(sample.sources, [200]); assert.deepEqual(sample.emitted.map(row => row.id), Array.from({ length: 50 }, (_, index) => String(index + 3)));
    assert.equal(sample.titles.length, 0);
});
