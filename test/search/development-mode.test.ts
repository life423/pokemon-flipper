import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDeals, type SearchSummary } from "../../server/deals/find-deals.ts";
import { searchDeals } from "../../server/deals/search.ts";
import { createNewListingDiscovery } from "../../server/deals/new-listings.ts";
import { DEVELOPMENT_SEARCH_LIMIT } from "../../shared/research-policy.ts";
import { offlineSearchSteps } from "../fixtures/search-steps.ts";
import type { ListingSummary } from "../../shared/types.ts";

const row = (id: string, extra: Partial<ListingSummary> = {}): ListingSummary => ({ id, title: "Charizard Base Set 4/102 Holo English",
    currentPrice: 80, shipping: 0, buyingOption: "FIXED_PRICE", bids: 0, isGraded: false, images: [id], url: "#", seller: null, endTime: null, ...extra });
const rows = Array.from({ length: 200 }, (_, index) => row(String(index)));

test("normal searches use one current pipeline with50 metadata rows and no new title/photo requests", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("only injected offline sources may run"));
    let sources = 0, titleReads = 0, summary: SearchSummary | undefined;
    const emitted: ListingSummary[] = [];
    const steps = offlineSearchSteps(rows, {
        search: async (_query, options) => { sources++; assert.equal(options?.maxResults, 200); assert.equal(options?.sort, "newlyListed"); return { listings: rows, total: 1000, skipped: 0 }; },
        readTitle: async title => { titleReads++; return offlineSearchSteps([]).readTitle(title); },
    });
    await searchDeals("Charizard Base Set 4/102 holo", { onStart: value => { summary = value; }, onListing: value => emitted.push(value) },
        (query, options) => findDeals(query, options, steps));
    assert.equal(sources, 1); assert.equal(titleReads, DEVELOPMENT_SEARCH_LIMIT); assert.equal(emitted.length, DEVELOPMENT_SEARCH_LIMIT);
    assert.equal(summary?.deferred, 150); assert.equal(fetch.mock.callCount(), 0);
});

test("newest scans share the50-row pipeline, exclude seen IDs first and remember only emitted IDs", async () => {
    let remembered: readonly string[] = [];
    const discover = createNewListingDiscovery({ usage: async () => null,
        history: { seen: async () => ["0"], remember: async (_query, _minimum, ids) => { remembered = ids; } },
        find: (query, options) => findDeals(query, options, offlineSearchSteps(rows)),
    });
    const emitted: ListingSummary[] = [];
    await discover("Charizard Base Set 4/102 holo", { onListing: value => emitted.push(value) });
    assert.equal(emitted.length, DEVELOPMENT_SEARCH_LIMIT); assert.equal(emitted[0].id, "1");
    assert.deepEqual(remembered, emitted.map(value => value.id));
});

test("known foreign, absurd-price and filtered rows do not consume current metadata slots", async () => {
    const page = [row("foreign", { title: "Charizard Base Set 4/102 Japanese Holo" }), row("absurd", { currentPrice: 223200 }),
        row("graded", { isGraded: true }), ...rows];
    const result = await findDeals("Charizard Base Set 4/102 holo", { filters: { kindFilter: "raw" } }, offlineSearchSteps(page));
    assert.equal(result.length, DEVELOPMENT_SEARCH_LIMIT); assert.equal(result[0].id, "0");
});
