import "../fixtures/isolated-data.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { findDeals, type SearchSummary } from "../../server/deals/find-deals.ts";
import { createDiscoveryContinuationStore, discoveryContinuations, type DiscoveryBacklog } from "../../server/deals/search-continuation.ts";
import { getBudgetContext, withAiUsageContext } from "../../server/ai/usage-context.ts";
import { offlineSearchSteps } from "../fixtures/search-steps.ts";
import { readSearchLocally } from "../../server/search/intent.ts";
import type { ListingSummary } from "../../shared/types.ts";
import { isolatedDataDir } from "../fixtures/isolated-data.ts";

const query = "Charizard Base Set 4/102 Unlimited holo";
const row = (number: number): ListingSummary => ({ id: `v1|${120000000000 + number}|0`, title: query, currentPrice: 25, shipping: 5,
    buyingOption: "FIXED_PRICE", bids: 0, isGraded: false, endTime: null, images: ["offline-front"], seller: null, url: "#" });

test("continued discovery preserves all 240 copies, source offsets and the original allowance without repeated source work", async t => {
    t.mock.method(globalThis, "fetch", async () => assert.fail("continuation mechanics use only injected evidence"));
    const root = randomUUID(), all = Array.from({ length: 240 }, (_, i) => row(i));
    const offsets: number[] = [], accounts = new Set<string | undefined>();
    const steps = offlineSearchSteps([], {
        search: async (_query, options) => {
            accounts.add(getBudgetContext().searchId);
            assert.equal(options?.anyCategory, true);
            assert.equal(options?.filters?.maxPrice, 100, "a continuation cannot widen its saved filters");
            const offset = options?.offset ?? 0;
            offsets.push(offset);
            return { listings: all.slice(offset, offset + 200), total: 240, skipped: 0, rejections: [],
                ...(offset === 0 && { nextOffset: 200 }) };
        },
        soldScreening: () => async () => {
            accounts.add(getBudgetContext().searchId);
            return { status: "UNAVAILABLE", exactScope: false, references: [], note: "No saved sale. Photos remain eligible." };
        },
    });
    let summary: SearchSummary | undefined;
    const output: ListingSummary[] = [];
    const first = await withAiUsageContext({ searchId: root }, () => findDeals(query, {
        marketplaceOrder: "lowest", filters: { typeFilter: "FIXED_PRICE", maxPrice: 100 }, onStart: value => { summary = value; },
    }, steps));
    output.push(...first);
    assert.equal(first.length, 50); assert.equal(summary?.continuation?.pending, 150);
    const firstNext = summary!.continuation!;
    let batches = 1;
    while (summary?.continuation) {
        const next = summary.continuation;
        assert.equal(await discoveryContinuations.budgetOwner(next.searchId), root);
        const part = await withAiUsageContext({ searchId: next.searchId }, () => findDeals(query, {
            continuation: next.token, filters: { maxPrice: 1000 }, onStart: value => { summary = value; },
        }, steps));
        assert.ok(part.length <= 50); output.push(...part);
        assert.ok(++batches <= 5, "an exhausted source cannot create an endless continuation");
    }
    assert.equal(batches, 5);
    assert.equal(output.length, 240);
    assert.equal(new Set(output.map(value => value.id)).size, 240);
    assert.deepEqual(offsets, [0, 200]);
    assert.deepEqual([...accounts], [root]);
    const before = offsets.length;
    const replay = await withAiUsageContext({ searchId: firstNext.searchId }, () => findDeals(query, { continuation: firstNext.token }, steps));
    assert.deepEqual(replay.map(value => value.id), output.slice(50, 100).map(value => value.id));
    assert.equal(offsets.length, before);
    await assert.rejects(withAiUsageContext({ searchId: randomUUID() }, () => findDeals(query, { continuation: firstNext.token }, steps)), /different discovery/);
    await assert.rejects(withAiUsageContext({ searchId: firstNext.searchId }, () => findDeals("Alakazam", { continuation: firstNext.token }, steps)), /different search/);
});

test("a saved continuation shares simultaneous work, survives reload and cannot be attached to another discovery UUID", async () => {
    const directory = `${isolatedDataDir}/receipt-store`, store = createDiscoveryContinuationStore(directory), root = randomUUID();
    const state: DiscoveryBacklog = { rootSearchId: root, request: { search: query }, pending: [row(1)], sources: [], seenIds: [], total: 1 };
    const next = await store.create(state);
    let runs = 0;
    const work = async () => {
        runs++;
        await new Promise(resolve => setTimeout(resolve, 5));
        return { listings: [row(1)], summary: { mode: "development" as const, deferred: 0, total: 1, found: 1, count: 1, skipped: 0,
            intent: readSearchLocally(query) }, dispositions: [], overflow: [] };
    };
    await assert.rejects(store.run(next.token, randomUUID(), query, work), /different discovery/);
    const pair = await Promise.all([store.run(next.token, next.searchId, query, work), store.run(next.token, next.searchId, query, work)]);
    assert.equal(runs, 1); assert.deepEqual(pair[0].receipt, pair[1].receipt);
    const reloaded = createDiscoveryContinuationStore(directory);
    assert.equal(await reloaded.budgetOwner(next.searchId), root);
    const replay = await reloaded.run(next.token, next.searchId, query, work);
    assert.equal(replay.reused, true); assert.equal(runs, 1);
});

test("a cancelled worker cannot save an incomplete continuation receipt", async () => {
    const directory = `${isolatedDataDir}/cancelled-continuation`, store = createDiscoveryContinuationStore(directory);
    const next = await store.create({ rootSearchId: randomUUID(), request: { search: query }, pending: [row(1)], sources: [], seenIds: [], total: 1 });
    const summary = { mode: "development" as const, deferred: 0, total: 1, found: 1, count: 1, skipped: 0, intent: readSearchLocally(query) };
    const controller = new AbortController();
    const partial = store.run(next.token, next.searchId, query, async (_state, signal) => {
        controller.abort();
        assert.equal(signal.aborted, true);
        return { listings: [], summary, dispositions: [], overflow: [] };
    }, controller.signal);
    await assert.rejects(partial, { name: "AbortError" });
    const complete = await store.run(next.token, next.searchId, query, async () => ({
        listings: [row(1)], summary, dispositions: [], overflow: [],
    }));
    assert.equal(complete.reused, false);
    assert.deepEqual(complete.receipt.listings, [row(1)]);
});
