import { test } from "node:test";
import assert from "node:assert/strict";
import { findDeals, screenListing, type ScreenSteps } from "../../server/deals/find-deals.ts";
import { digDeeper } from "../../server/deals/dig.ts";
import type { ListingSummary, SearchIntent } from "../../shared/types.ts";

const intent: SearchIntent = { cardName: null, sets: [], cardNumber: null, printing: null, graded: null, titleWords: [], source: "rules" };
const auction = (id: string, end: number): ListingSummary => ({ id, title: `Pokemon card ${id}`, currentPrice: 20, shipping: 0, bids: 0, isGraded: false,
    buyingOption: "AUCTION", endTime: new Date(end).toISOString(), images: [id], url: "#", seller: null });
const steps = (): ScreenSteps => ({ readTitle: async () => ({ aspects: {}, filled: [], condition: null, kind: "SINGLE_CARD" }),
    check: async () => ({ status: "DROPPED", reason: "Offline price check", card: null, bestCase: null, assumed: null }),
    loadDetails: async () => { assert.fail("no details expected"); }, matchPhoto: async () => { assert.fail("no photo expected"); } });

test("intent latency cannot expand the primary auction window beyond search start", async t => {
    const start = Date.now(); let clock = start; t.mock.method(Date, "now", () => clock);
    const warmed: string[] = [];
    const page = [auction("beyond-start-window", start + 12 * 3600000 + 1000), auction("inside", start + 12 * 3600000 - 1000), auction("already-ended", start + 1000)];
    const result = await findDeals("pokemon", {}, {
        readIntent: async () => { await Promise.resolve(); clock += 5000; return intent; },
        search: async (_query, options) => { assert.equal(options?.asOf, start); return { listings: page, total: 3, skipped: 0 }; },
        readTitle: async title => { warmed.push(title); return null; }, screening: steps,
    });
    assert.deepEqual(result.map(row => row.id), ["inside"]); assert.deepEqual(warmed, [page[1].title]);
});

test("discovery shares the original auction upper bound even after intent and source delays", async t => {
    const start = Date.now(); let clock = start; t.mock.method(Date, "now", () => clock);
    const photographed: string[] = [];
    await digDeeper("pokemon", {}, {
        readIntent: async () => { clock += 5000; return intent; }, plan: async () => [{ query: "old pokemon", how: "PHOTO_SHOWS_IT" }],
        search: async (_query, options) => { assert.equal(options?.asOf, start); clock += 5000; return { total: 3, skipped: 0, listings: [
            auction("late", start + 12 * 3600000 + 2000), auction("inside", start + 3600000), auction("ended", start + 1000),
        ] }; },
        findPhoto: async image => { photographed.push(image); return null; }, screening: steps,
    });
    assert.deepEqual(photographed, ["inside"]);
});

test("an auction expiring after selection receives no queued title or screening work", async t => {
    const start = Date.now(); let clock = start; t.mock.method(Date, "now", () => clock);
    let warmed = 0;
    const result = await findDeals("pokemon", { onStart: () => { clock += 2000; } }, {
        readIntent: async () => intent, search: async () => ({ listings: [auction("expired-in-queue", start + 1000)], total: 1, skipped: 0 }),
        readTitle: async () => { warmed++; return null; }, screening: () => { const value = steps(); value.check = async () => { assert.fail("expired auction must not start pricing"); }; return value; },
    });
    assert.deepEqual(result, []); assert.equal(warmed, 0);
});

test("an auction expiring during its title reading cannot start later pricing or photo work", async t => {
    const start = Date.now(); let clock = start; t.mock.method(Date, "now", () => clock);
    const value = steps(); value.readTitle = async () => { clock += 2000; return { aspects: {}, filled: [], condition: null, kind: "SINGLE_CARD" }; };
    value.check = async () => { assert.fail("expired auction must stop before pricing"); };
    assert.equal((await screenListing(auction("expired-after-title", start + 1000), value)).availability, "UNAVAILABLE");
});
