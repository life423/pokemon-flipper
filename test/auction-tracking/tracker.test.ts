import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuctionTracker, matchingClose } from "../../server/auction-tracking/tracker.ts";

const id = "v1|123456789123|0", url = "https://www.ebay.com/itm/123456789123";
const end = Date.parse("2026-11-25T01:00:00Z"), minute = 60_000;
const iso = (t: number) => new Date(t).toISOString();
async function setup(t: TestContext) {
    const dir = await mkdtemp(join(tmpdir(), "pf-auction-outcome-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const clock = { time: end - 2 * 60 * minute };
    const listing = { id, title: "Dark Alakazam 1/82 Unlimited Holo", url, buyingOption: "AUCTION", shipping: 5, cardCondition: "Lightly played",
        conditionNotes: [], aspects: {}, photos: ["https://i.ebayimg.com/a.jpg"] };
    const evaluation = { listing, identity: { recordId: 7 }, rawPricing: { source: "pkmnprices", variant: "Unlimited Holo" }, slab: null };
    const opportunity = { listingId: id, status: "BID", checkedAt: iso(clock.time), endsAt: iso(end), validUntil: clock.time + minute,
        nextBid: 31, maxBid: 42, currentPrice: 30, marketValue: 60 };
    const detail = { ...listing, images: listing.photos, endTime: iso(end), availability: "ACTIVE", retrievedAt: "", price: 30,
        auctionBids: { currentBid: 30, minimumBid: 31 }, bids: 4 };
    const calls = { details: 0, sales: 0 };
    const sold = { sale_type: "auction", currency: "USD", listing_url: url, price: 41, sold_at: "2026-11-24" };
    let rows: typeof sold[] = [sold];
    const deps = { file: join(dir, "outcomes.json"), now: () => clock.time,
        details: async (item, account) => { assert.equal(item, id); assert.equal(account, "original"); calls.details++;
            return { ...detail, retrievedAt: iso(clock.time) }; },
        sales: async (market, account) => { assert.deepEqual(market, { recordId: 7, variant: "Unlimited Holo", grader: null, grade: null });
            assert.equal(account, "original"); calls.sales++; return rows; } };
    const tracker = createAuctionTracker(deps);
    const restart = () => createAuctionTracker(deps);
    return { tracker, restart, clock, evaluation, opportunity, detail, calls, sold, setRows: (next: typeof sold[]) => { rows = next; } };
}

test("first actionable ceiling persists across review retries, refreshes and restart, and a closed auction is scored once", async t => {
    const { tracker, restart, clock, evaluation, opportunity, detail, calls } = await setup(t);
    await tracker.remember({ ...opportunity, status: "PASS" }, evaluation, "original");
    assert.equal((await tracker.list()).auctions.length, 0);
    await tracker.remember(opportunity, evaluation, "original");
    await Promise.all([tracker.remember(opportunity, evaluation, "original"), tracker.remember({ ...opportunity, maxBid: 72 }, evaluation, "later")]);
    const resumed = restart();
    assert.equal((await resumed.list()).auctions[0].originalMaxBid, 42);
    clock.time = end - 60 * minute;
    detail.price = detail.auctionBids.currentBid = 43; detail.auctionBids.minimumBid = 44;
    await Promise.all([resumed.tick(), resumed.tick(), tracker.tick()]);
    assert.deepEqual(calls, { details: 1, sales: 0 }); assert.equal((await resumed.list()).auctions[0].status, "OVER_LIMIT");
    clock.time = end + minute;
    assert.equal((await resumed.list()).auctions[0].status, "AWAITING_SALE");
    await resumed.tick(); assert.equal(calls.sales, 0);
    clock.time = end + 5 * minute;
    await resumed.tick(); await resumed.tick();
    const result = await resumed.list();
    assert.equal(result.withinLimit, 1); assert.equal(result.confirmed, 1); assert.equal(result.auctions[0].closingPrice, 41);
    assert.equal(result.auctions[0].originalMaxBid, 42); assert.equal(calls.sales, 1);
    assert.deepEqual(result.auctions[0].bidHistory, [{ checkedAt: iso(end - 60 * minute), currentBid: 43, minimumBid: 44, shipping: 5 }]);
});

test("a changed quote, higher closing sale and missing sale are each reported with distinct evidence", async t => {
    const { tracker, clock, evaluation, opportunity, detail, calls, sold, setRows } = await setup(t);
    await tracker.remember(opportunity, evaluation, "original");
    detail.shipping = 11;
    clock.time = end - 15 * minute; await tracker.tick();
    assert.equal((await tracker.list()).auctions[0].status, "RECHECK");
    setRows([]); clock.time = end + 5 * minute; await tracker.tick();
    const pending = await tracker.list();
    assert.equal(pending.awaiting, 1); assert.equal(pending.confirmed, 0); assert.equal(pending.auctions[0].closingPrice, undefined);
    clock.time = end + 25 * 60 * minute; setRows([{ ...sold, price: 51 }]); await tracker.tick();
    const known = await tracker.list();
    assert.equal(known.auctions[0].status, "ABOVE_LIMIT"); assert.equal(known.confirmed, 1); assert.equal(known.withinLimit, 0);
    assert.equal(calls.sales, 2);
});

test("missing sale remains unconfirmed after the bounded closing checks and cannot enter success counts", async t => {
    const { tracker, clock, evaluation, opportunity, calls, setRows } = await setup(t);
    await tracker.remember(opportunity, evaluation, "original"); setRows([]);
    for (const hours of [1, 7, 25, 73, 96]) { clock.time = end + hours * 60 * minute; await tracker.tick(); }
    const results = await tracker.list();
    assert.equal(results.auctions[0].status, "UNCONFIRMED"); assert.equal(results.confirmed, 0); assert.equal(calls.sales, 4);
});

test("a later reported sale can be recovered without repeating the bounded checks or changing the original ceiling", async t => {
    const { tracker, clock, evaluation, opportunity, calls, sold, setRows } = await setup(t);
    await tracker.remember(opportunity, evaluation, "original"); setRows([]);
    clock.time = end + 74 * 60 * minute; await tracker.tick();
    assert.equal(await tracker.recheck(id), false);
    setRows([sold]); clock.time += 6 * 60 * minute;
    const checks = await Promise.all([tracker.recheck(id), tracker.recheck(id)]);
    assert.equal(checks.filter(Boolean).length, 1);
    assert.equal((await tracker.list()).withinLimit, 1); assert.equal(calls.sales, 2);
});

test("replaced gallery retires the alert without assuming an ended transaction", async t => {
    const { tracker, clock, evaluation, opportunity, calls, detail } = await setup(t);
    await tracker.remember(opportunity, evaluation, "original");
    detail.images = ["https://i.ebayimg.com/seller-replaced-photo.jpg"];
    clock.time = end - 15 * minute; await tracker.tick();
    const results = await tracker.list();
    assert.equal(results.auctions[0].status, "UNCONFIRMED"); assert.equal(results.awaiting, 0);
    clock.time = end + 74 * 60 * minute; await tracker.tick();
    assert.equal(calls.sales, 0); assert.equal(await tracker.recheck(id), false);
});

test("sale matching excludes another item, a fixed price, a currency mismatch, relisted sale dates and ambiguous prices", async t => {
    const { sold } = await setup(t);
    const auction = { listingId: id, endsAt: iso(end) }, time = end + 8 * 60 * minute;
    for (const change of [{ listing_url: "https://www.ebay.com/itm/123456789124" },{ sale_type: "fixed_price" },
        { currency: "EUR" }, { sold_at: "2026-11-20" }, { sold_at: iso(time + minute) }]) {
        assert.equal(matchingClose([{ ...sold, ...change }], auction, time), null);
    }
    assert.equal(matchingClose([sold, { ...sold, price: 42 }], auction, time), null);
    assert.equal(matchingClose([sold], auction, time)?.price, 41);
});
