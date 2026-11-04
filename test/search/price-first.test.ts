import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDeals } from "../../server/deals/find-deals.ts";
import { priceFirstListings, type SoldScreeningFactory } from "../../server/deals/price-first.ts";
import { createSoldScreening } from "../../server/pricing/screening-sales.ts";
import { createNewListingDiscovery } from "../../server/deals/new-listings.ts";
import { readSearchLocally } from "../../server/search/intent.ts";
import { readTitleByRules } from "../../server/ai/title-reader.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import { canAutoAnalyze, resultGroup } from "../../shared/analysis.ts";
import type { ListingSummary, ScreeningSoldEvidence } from "../../shared/types.ts";
import type { CardRecord, Comp } from "../../server/pricing/types.ts";

const NOW = Date.now(), DAY = 86_400_000;
const intent = readSearchLocally("Charizard Base Set 4/102 holo");
const targets = { minProfit: 0, minRoi: 0 };
const listing = (id: string, extra: Partial<ListingSummary> = {}): ListingSummary => ({
    id, title: "Charizard Base Set 4/102 Unlimited Holo English", currentPrice: 40, shipping: 5,
    buyingOption: "FIXED_PRICE", isGraded: false, bids: 0, endTime: null, images: ["https://i.ebayimg.com/images/g/offline/s-l1600.jpg"],
    url: `https://www.ebay.com/itm/${id}`, seller: null, ...extra,
});
const unavailable = (status: "UNAVAILABLE" | "DEFERRED" = "UNAVAILABLE"): ScreeningSoldEvidence => ({
    status, exactScope: false, references: [], note: "No usable saved sold prices.",
});
function evidence(slab = false, median = 100): ScreeningSoldEvidence {
    return { status: "AVAILABLE", exactScope: true, note: "Three actual matched sold records.", references: [{
        recordId: 1, name: "Charizard", set: "Base Set", cardNumber: "4/102", printing: "UNLIMITED", finish: "HOLO",
        grader: slab ? "PSA" : null, grade: slab ? "8" : null, condition: slab ? null : "NEAR_MINT",
        summary: { grader: slab ? "PSA" : "RAW", grade: slab ? "8" : "NEAR_MINT", windowDays: 90, count: 3,
            median, low: median - 10, high: median + 10, newestSale: new Date(NOW - DAY).toISOString(), confidence: "MEDIUM", dropped: {},
            sales: [median - 10, median, median + 10].map(price => ({ price, title: "Matched sold record", soldAt: new Date(NOW - DAY).toISOString(), url: null })) },
    }] };
}
const factory = (run: ReturnType<SoldScreeningFactory>): SoldScreeningFactory => () => run;
function steps(rows: ListingSummary[], soldScreening: SoldScreeningFactory) {
    return { soldScreening, search: async () => ({ listings: rows, total: rows.length, skipped: 0 }),
        readIntent: async (query: string) => readSearchLocally(query), readTitle: async (title: string) => readTitleByRules(title),
    };
}

test("no browser candidate is emitted until the batch's sold evidence is ready", async () => {
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const emitted: ListingSummary[] = [];
    let factories = 0;
    const prices: SoldScreeningFactory = () => { factories++; return async () => { started(); await pending; return evidence(); }; };
    const work = findDeals("Charizard Base Set 4/102 holo", { targets, onListing: row => emitted.push(row) }, steps([listing("one"), listing("two")], prices));
    await ready;
    assert.equal(emitted.length, 0);
    release();
    const result = await work;
    assert.equal(factories, 1);
    assert.equal(emitted.length, 2);
    assert.ok(result.every(row => row.screen?.soldEvidence?.status === "AVAILABLE" && canAutoAnalyze(row)));
});

test("fifty admitted rows reuse one canonical catalog lookup and sold page before any AI", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("offline sources only; no AI, eBay or price transport"));
    const card: CardRecord = { source: "pkmnprices", id: 1, name: "Charizard", setName: "Base Set", cardNumber: "4/102", tcgPlayerId: null,
        variants: [{ name: "Unlimited Holofoil", printing: "UNLIMITED", finish: "HOLO", prices: [] }] };
    const sold: Comp[] = [90, 100, 110].map((price, index) => ({ id: index, title: "Charizard Base Set 4/102 Unlimited Holo NM English",
        price, currency: "USD", sold_at: new Date(NOW - DAY).toISOString(), sale_type: "fixed_price", attribution: "exact", variant: "Unlimited Holofoil", grader: null, grade: null }));
    let catalogCalls = 0, rawCalls = 0;
    const prices: SoldScreeningFactory = options => createSoldScreening({ ...options, source: {
        lookupCards: async () => { catalogCalls++; return [card]; }, fetchRawComps: async () => { rawCalls++; return sold; },
        fetchComps: async () => assert.fail("raw screening must not research hypothetical slab grades"),
    } });
    const rows = Array.from({ length: 50 }, (_, index) => listing(String(index)));
    const result = await findDeals("Charizard Base Set 4/102 holo", { targets }, steps(rows, prices));
    assert.equal(result.length, 50); assert.equal(catalogCalls, 1); assert.equal(rawCalls, 1);
    assert.ok(result.every(row => row.screen?.soldEvidence?.references[0].summary.median === 100));
    assert.deepEqual(result.map(row => row.id), rows.map(row => row.id), "equal priority preserves newest/source order");
    assert.equal(fetch.mock.callCount(), 0);
});

test("known wrong cards and search-filter exclusions never reach sold research", async () => {
    const checked: string[] = [];
    const prices = factory(async row => { checked.push(row.id); return evidence(); });
    const rows = [listing("other", { title: "Charmander Base Set 46/102 Holo English" }),
        listing("reprint", { title: "Charizard Celebrations 4/102 Holo English" }),
        listing("foreign", { title: "Charizard Base Set 4/102 Japanese Holo" }),
        listing("too-high", { currentPrice: 500 }), listing("one")];
    const result = await findDeals("Charizard Base Set 4/102 holo", { filters: { maxPrice: 100 } }, steps(rows, prices));
    assert.deepEqual(checked, ["one"]); assert.deepEqual(result.map(row => row.id), ["one"]);
});

test("missing and budget-deferred markets remain visible Sorting rows without paid eligibility or invented money", async () => {
    const rows = [listing("missing"), listing("budget")];
    const result = await findDeals("Charizard Base Set 4/102 holo", {}, steps(rows, factory(async row => unavailable(row.id === "budget" ? "DEFERRED" : "UNAVAILABLE"))));
    assert.equal(result.length, 2);
    for (const row of result) {
        assert.equal(canAutoAnalyze(row), false); assert.equal(resultGroup(row, null), "candidates");
        assert.equal(row.screen?.bestCase, null); assert.equal(row.screen?.money, undefined);
    }
});

test("an exact expensive slab is terminal for automatic work while raw grading upside remains eligible", async () => {
    const slab = listing("slab", { title: "Charizard Base Set 4/102 Unlimited Holo PSA 8 English", isGraded: true, currentPrice: 1000 });
    const raw = listing("raw", { currentPrice: 1000 });
    const result = await findDeals("Charizard Base Set 4/102 holo", { targets }, steps([slab, raw], factory(async row => evidence(row.isGraded))));
    assert.deepEqual(result.map(row => row.id), ["raw"], "confident preliminary price rejections no longer fill result slots");
    const candidate = result.find(row => row.id === "raw")!;
    assert.equal(candidate.screen?.status, "UNSCREENED"); assert.equal(candidate.screen?.bestCase, null); assert.equal(canAutoAnalyze(candidate), true);
});

test("cheap First Edition Base Set leads are an explicit focused exception, never a blanket missing-price bypass", async () => {
    const result = await findDeals("Charizard Base Set 4/102 holo", {}, steps([
        listing("cheap", { title: "Charizard Base Set 4/102 1st Edition Holo English", currentPrice: 5 }),
        listing("normal", { title: "Charizard Base Set 4/102 1st Edition Holo English", currentPrice: 50 }), listing("unlimited", { currentPrice: 5 }),
    ], factory(async () => unavailable())));
    assert.equal(canAutoAnalyze(result.find(row => row.id === "cheap")!), true);
    assert.ok(result.filter(row => row.id !== "cheap").every(row => !canAutoAnalyze(row)));
    assert.ok(result.every(row => row.screen?.bestCase === null));
});

test("Stop during sold research prevents queued lookups, candidate emission and later stages", async () => {
    const stopped = new AbortController();
    let started!: () => void, checked = 0, emitted = 0;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const prices: SoldScreeningFactory = ({ signal } = {}) => async () => {
        checked++; started();
        await new Promise<void>((_resolve, reject) => {
            if (signal!.aborted) reject(signal!.reason);
            else signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        });
        return evidence();
    };
    const work = findDeals("Charizard Base Set 4/102 holo", { signal: stopped.signal, onListing: () => { emitted++; } },
        steps(Array.from({ length: 50 }, (_, index) => listing(String(index))), prices));
    await ready; stopped.abort();
    assert.deepEqual(await work, []);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(checked <= 4); assert.equal(emitted, 0);
});

test("a storage failure aborts sibling and queued market work instead of dispatching all fifty", async () => {
    let checked = 0, observedAbort = 0;
    const failure = new StorageUnavailableError("Saved sold data unavailable");
    const prices: SoldScreeningFactory = ({ signal } = {}) => async row => {
        checked++;
        if (row.id === "0") throw failure;
        await new Promise<void>((_resolve, reject) => {
            if (signal!.aborted) { observedAbort++; reject(signal!.reason); }
            else signal!.addEventListener("abort", () => { observedAbort++; reject(signal!.reason); }, { once: true });
        });
        return evidence();
    };
    await assert.rejects(priceFirstListings(Array.from({ length: 50 }, (_, index) => listing(String(index))), intent, {}, prices), error => error === failure);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(checked <= 4, `${checked} callbacks started`); assert.equal(observedAbort, checked - 1);
});

test("new-listing discovery uses the same price-first path and remembers only emitted IDs", async () => {
    const researched: string[] = [], emitted: ListingSummary[] = [];
    let remembered: readonly string[] = [];
    const dependencies = steps([listing("seen"), listing("new")], factory(async row => { researched.push(row.id); return evidence(); }));
    const discover = createNewListingDiscovery({ usage: async () => null,
        history: { seen: async () => ["seen"], remember: async (_query, _minimum, ids) => { remembered = ids; } },
        find: async (query, options) => findDeals(query, options, dependencies),
    });
    await discover("Charizard Base Set 4/102 holo", { targets, onListing: row => emitted.push(row) });
    assert.deepEqual(researched, ["new"]); assert.deepEqual(remembered, ["new"]);
    assert.equal(emitted[0].screen?.soldEvidence?.status, "AVAILABLE");
});
