import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDeals } from "../../server/deals/find-deals.ts";
import { offlineSearchSteps } from "../fixtures/search-steps.ts";
import type { ListingSummary, SearchIntent } from "../../shared/types.ts";

const intent: SearchIntent = { cardName: null, sets: [], cardNumber: null, printing: null, graded: null, titleWords: [], source: "rules" };
const auction = (id: string, end: number): ListingSummary => ({ id, title: `Pokemon card ${id}`, currentPrice: 20, shipping: 0, bids: 0, isGraded: false,
    buyingOption: "AUCTION", endTime: new Date(end).toISOString(), images: [id], url: "#", seller: null });

test("cached intent latency cannot widen the auction window beyond search start", async t => {
    const start = Date.now(); let clock = start; t.mock.method(Date, "now", () => clock);
    const titleReads: string[] = [];
    const rows = [auction("late", start + 12 * 3600000 + 1000), auction("inside", start + 12 * 3600000 - 1000), auction("ended", start + 1000)];
    const steps = offlineSearchSteps(rows, {
        readIntent: async () => { await Promise.resolve(); clock += 5000; return intent; },
        search: async (_query, options) => { assert.equal(options?.asOf, start); return { listings: rows, total: 3, skipped: 0 }; },
        readTitle: async title => { titleReads.push(title); return offlineSearchSteps([]).readTitle(title); },
    });
    assert.deepEqual((await findDeals("pokemon", {}, steps)).map(row => row.id), ["inside"]);
    assert.deepEqual(titleReads, [rows[1].title]);
});

test("an auction expiring during a cached title read starts no sold research or emitted work", async t => {
    const start = Date.now(); let clock = start; t.mock.method(Date, "now", () => clock);
    let sold = 0;
    const steps = offlineSearchSteps([auction("expired", start + 1000)], {
        readIntent: async () => intent,
        readTitle: async title => { clock += 2000; return offlineSearchSteps([]).readTitle(title); },
        soldScreening: () => async () => { sold++; assert.fail("an ended auction needs no price request"); },
    });
    assert.deepEqual(await findDeals("pokemon", {}, steps), []); assert.equal(sold, 0);
});
