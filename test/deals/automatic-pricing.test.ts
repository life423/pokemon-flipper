import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverSearchPricing, RECOVERY_WINDOW_MS, RECOVERY_LISTING_LIMIT } from "../../server/deals/recover-pricing.ts";
import { createPricingRetries } from "../../server/deals/pricing-retries.ts";
import { pricingSnapshotKey, type PricingRecoveryProgress, type PricingRetryResult } from "../../shared/pricing-retries.ts";
import { resultGroup } from "../../shared/analysis.ts";
import { searchWithDiscovery } from "../../server/deals/search.ts";
import type { ListingSummary, Screen } from "../../shared/types.ts";

const TIME = Date.parse("2026-11-01T00:00:00Z");
function pending(id: string, time = TIME): ListingSummary {
    const listing: ListingSummary = { id, title: "Neo Discovery Scizor holo", currentPrice: 40, shipping: 5, bids: 0,
        isGraded: false, buyingOption: "FIXED_PRICE", endTime: null, images: [], seller: null, url: "https://www.ebay.com/itm/123456789012",
        screen: { status: "UNSCREENED", reason: "Temporary price failure", card: null, bestCase: null, assumed: null,
            pricingIssue: { kind: "RATE_LIMIT", retryAt: new Date(time + 30_000).toISOString() } } };
    listing.screen!.pricingRetry = { ticket: id, snapshotKey: pricingSnapshotKey(listing), attemptsLeft: 3,
        retryAt: new Date(time + 30_000).toISOString(), expiresAt: new Date(time + 30 * 60_000).toISOString() };
    return listing;
}
const priced = (): Screen => ({ status: "CANDIDATE", reason: null, card: null, bestCase: null, assumed: null });

test("automatic recovery waits for cooldown, batches at five, and streams recovered candidates without making Deals", async () => {
    let time = TIME; const rows = Array.from({ length: 12 }, (_, i) => pending(String(i))); const batches: string[][] = [];
    const updates: ListingSummary[] = []; const progress: PricingRecoveryProgress[] = [];
    await recoverSearchPricing(rows, { onListing: l => updates.push(l), onProgress: p => progress.push(p) }, {
        now: () => time, wait: async ms => { time += ms; },
        retry: async tokens => { const ids = tokens as string[]; batches.push(ids); assert.ok(time >= TIME + 30_000);
            return { results: ids.map(id => ({ id, snapshotKey: pricingSnapshotKey(rows.find(l => l.id === id)!), screen: priced() })), note: null }; },
    });
    assert.deepEqual(batches.map(x => x.length), [5, 5, 2]);
    assert.equal(updates.length, 12);
    assert.equal(progress.at(-1)?.priced, 12);
    assert.equal(progress.at(-1)?.pending, 0);
    assert.equal(progress.at(-1)?.status, "done");
    assert.equal(resultGroup(rows[0], null), "candidates", "temporary pricing belongs in Waiting");
    assert.equal(resultGroup(updates[0], null), "candidates", "screening recovery still requires full analysis");
});

test("automatic recovery uses trusted real queue tickets and preserves search targets and evidence", async () => {
    let time = TIME; let calls = 0;
    const queue = createPricingRetries({ now: () => time, cooldown: () => null, wait: async ms => { time += ms; }, price: async (_input, targets, offers) => {
        calls++; assert.deepEqual(targets, { minProfit: 0, minRoi: 0 }); assert.equal(offers, true); return priced();
    } });
    const row = pending("trusted"); row.screen!.evidence = { photos: 2, mainPhoto: "MATCH" };
    row.screen!.pricingRetry = queue.register(row, { title: row.title, aspects: {}, price: 40, shipping: 5, isGraded: false, buyingOption: "FIXED_PRICE", cardCondition: null }, null)!;
    let updated: ListingSummary | undefined;
    await recoverSearchPricing([row], { targets: { minProfit: 0, minRoi: 0 }, includeOffers: true, onListing: l => { updated = l; } }, { now: () => time, wait: async ms => { time += ms; }, retry: queue.retry });
    assert.equal(calls, 1); assert.deepEqual(updated?.screen?.evidence, row.screen!.evidence);
});

test("repeated provider failures stop after two automatic attempts per listing", async () => {
    let time = TIME; let calls = 0; const row = pending("retry"); const progress: PricingRecoveryProgress[] = [];
    await recoverSearchPricing([row], { onProgress: p => progress.push(p) }, { now: () => time, wait: async ms => { time += ms; }, retry: async () => {
        calls++; return { results: [{ id: row.id, snapshotKey: pricingSnapshotKey(row), screen: { ...row.screen!, pricingRetry: { ...row.screen!.pricingRetry!, attemptsLeft: 3 - calls, retryAt: new Date(time + 30_000).toISOString() } } }], note: null };
    } });
    assert.equal(calls, 2); assert.equal(progress.at(-1)?.pending, 1); assert.match(progress.at(-1)?.note ?? "", /limit/);
});

test("stopping during cooldown cancels without a pricing request", async () => {
    let time = TIME; let calls = 0; const controller = new AbortController();
    await assert.rejects(recoverSearchPricing([pending("cancel")], { signal: controller.signal }, { now: () => time, wait: async ms => { time += ms; controller.abort(); }, retry: async () => { calls++; return { results: [], note: null }; } }));
    assert.equal(calls, 0);
});

test("expired tickets, missing identity and account errors never start automatic recovery", async () => {
    const expired = pending("expired"); expired.screen!.pricingRetry!.expiresAt = new Date(TIME - 1).toISOString();
    const unknown = pending("unknown"); delete unknown.screen!.pricingIssue; delete unknown.screen!.pricingRetry;
    const credits = pending("credits"); credits.screen!.pricingIssue!.kind = "CREDITS";
    let calls = 0;
    await recoverSearchPricing([expired, unknown, credits], {}, { now: () => TIME, wait: async () => {}, retry: async () => { calls++; return { results: [], note: null }; } });
    assert.equal(calls, 0); assert.equal(resultGroup(unknown, null), "review");
});

test("server-directed waits beyond the recovery window stop instead of retrying early", async () => {
    const row = pending("long"); row.screen!.pricingRetry!.retryAt = new Date(TIME + RECOVERY_WINDOW_MS + 1).toISOString();
    let calls = 0; const progress: PricingRecoveryProgress[] = [];
    await recoverSearchPricing([row], { onProgress: p => progress.push(p) }, { now: () => TIME, wait: async () => { throw Error("should not wait"); }, retry: async () => { calls++; return { results: [], note: null }; } });
    assert.equal(calls, 0); assert.equal(progress.at(-1)?.pending, 1); assert.match(progress.at(-1)?.note ?? "", /window/);
});

test("a broad search's automatic recovery is capped, deduplicated and snapshot checked", async () => {
    let time = TIME; let calls = 0; const rows = Array.from({ length: RECOVERY_LISTING_LIMIT + 4 }, (_, i) => pending(String(i)));
    const updates: ListingSummary[] = []; const progress: PricingRecoveryProgress[] = [];
    await recoverSearchPricing([...rows, rows[0]], { onListing: l => updates.push(l), onProgress: p => progress.push(p) }, { now: () => time, wait: async ms => { time += ms; }, retry: async tokens => {
        calls++; const results: PricingRetryResult["results"] = (tokens as string[]).map(id => ({ id, snapshotKey: pricingSnapshotKey(rows.find(l => l.id === id)!), screen: priced() })); return { results, note: null };
    } });
    assert.equal(calls, RECOVERY_LISTING_LIMIT / 5); assert.equal(updates.length, RECOVERY_LISTING_LIMIT); assert.equal(progress.at(-1)?.pending, 4);
});

test("search recovery uses the guarded callback instead of replacing normal listing snapshots", async () => {
    const row = pending("stream"); const initial: ListingSummary[] = []; const recovered: ListingSummary[] = [];
    await searchWithDiscovery("neo discovery holo", { onListing: l => initial.push(l), onPricingListing: (l, key) => {
        assert.equal(key, pricingSnapshotKey(row)); recovered.push(l);
    } }, {
        find: async (_query, options = {}) => { options.onListing?.(row); return [row]; },
        discover: async () => {},
        recover: async (rows, options = {}) => { assert.equal(rows.length, 1); options.onListing?.({ ...row, screen: priced() }, pricingSnapshotKey(row)); },
    });
    assert.equal(initial.length, 1); assert.equal(initial[0].screen?.status, "UNSCREENED");
    assert.equal(recovered.length, 1); assert.equal(recovered[0].screen?.status, "CANDIDATE");
});
