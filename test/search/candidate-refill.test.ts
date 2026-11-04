import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDeals, type SearchSummary } from "../../server/deals/find-deals.ts";
import { createSoldScreening } from "../../server/pricing/screening-sales.ts";
import { createNewListingDiscovery } from "../../server/deals/new-listings.ts";
import { readSearchLocally } from "../../server/search/intent.ts";
import { readTitleByRules } from "../../server/ai/title-reader.ts";
import { canAutoAnalyze, resultGroup } from "../../shared/analysis.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import type { SoldScreeningFactory } from "../../server/deals/price-first.ts";
import type { ListingSummary, ScreeningSoldEvidence } from "../../shared/types.ts";
import type { CardRecord, Comp } from "../../server/pricing/types.ts";

const NOW = Date.now();
const query = "Charizard Base Set 4/102 Unlimited PSA 8 holo";
const targets = { minProfit: 0, minRoi: 0 };
const row = (id: string, currentPrice = 1000): ListingSummary => ({ id, currentPrice, title: "Charizard Base Set 4/102 Unlimited Holo English PSA 8",
    shipping: 5, buyingOption: "FIXED_PRICE", isGraded: true, bids: 0, endTime: null, url: `https://www.ebay.com/itm/${id}`,
    images: ["https://i.ebayimg.com/images/g/offline/s-l1600.jpg"], seller: null });
const reference = (): ScreeningSoldEvidence => ({ status: "AVAILABLE", exactScope: true, note: "Three matched recent sales", references: [{
    recordId: 1, name: "Charizard", set: "Base Set", cardNumber: "4/102", printing: "UNLIMITED", finish: "HOLO", grader: "PSA", grade: "8", condition: null,
    summary: { grader: "PSA", grade: "8", median: 100, low: 90, high: 110, mean: 100, count: 3, windowDays: 90, confidence: "MEDIUM",
        newestSale: new Date(NOW - 86400000).toISOString(), sales: [], dropped: {} },
}] });
function steps(rows: ListingSummary[], soldScreening: SoldScreeningFactory) {
    return { soldScreening, search: async () => ({ listings: rows, total: rows.length, skipped: 0 }),
        readIntent: async (text: string) => readSearchLocally(text), readTitle: async (title: string) => readTitleByRules(title) };
}

test("a worthwhile 51st listing refills fifty price exclusions using one page and one shared market lookup", async t => {
    const transport = t.mock.method(globalThis, "fetch", async () => assert.fail("only the injected saved sources may run"));
    const card: CardRecord = { source: "pkmnprices", id: 1, name: "Charizard", setName: "Base Set", cardNumber: "4/102", tcgPlayerId: null,
        variants: [{ name: "Unlimited Holofoil", printing: "UNLIMITED", finish: "HOLO", prices: [] }] };
    const sales: Comp[] = [90, 100, 110].map((price, id) => ({ id, price, title: "Charizard Base Set 4/102 Unlimited Holo English PSA 8",
        grader: "PSA", grade: "8", variant: "Unlimited Holofoil", currency: "USD", attribution: "exact", sale_type: "fixed_price",
        sold_at: new Date(NOW - 86400000).toISOString() }));
    let factories = 0, catalogs = 0, soldPages = 0, sourcePages = 0;
    const prices: SoldScreeningFactory = options => { factories++; return createSoldScreening({ ...options, source: {
        lookupCards: async () => { catalogs++; return [card]; },
        fetchComps: async () => { soldPages++; return sales; }, fetchRawComps: async () => assert.fail("slabs never need raw comps"),
    } }); };
    const rows = [...Array.from({ length: 50 }, (_, i) => row(String(i))), row("worthwhile", 40)];
    const snapshots: SearchSummary[] = [], emitted: ListingSummary[] = [];
    const dependencies = steps(rows, prices);
    const result = await findDeals(query, { targets, onStart: value => snapshots.push(value), onListing: value => emitted.push(value) }, {
        ...dependencies, search: async (text, options) => { sourcePages++; assert.equal(options?.maxResults, 200); return dependencies.search(); },
    });
    assert.deepEqual(result.map(value => value.id), ["worthwhile"]); assert.deepEqual(emitted, result);
    assert.equal(canAutoAnalyze(result[0]), true); assert.equal(resultGroup(result[0], null), "candidates", "preliminary value is not a verified Deal");
    assert.equal(sourcePages, 1); assert.equal(factories, 1); assert.equal(catalogs, 1); assert.equal(soldPages, 1);
    assert.equal(snapshots.at(-1)?.count, 1); assert.equal(snapshots.at(-1)?.screened, 51); assert.equal(snapshots.at(-1)?.priceExcluded, 50);
    assert.equal(snapshots.at(-1)?.deferred, 0); assert.equal(transport.mock.callCount(), 0);
});

test("refill stops at fifty retained rows and a deferred price budget is not renewed by another batch", async () => {
    let factories = 0, checked = 0;
    const prices: SoldScreeningFactory = () => { factories++; return async () => {
        checked++;
        return checked <= 50 ? reference() : { status: "DEFERRED", exactScope: false, references: [], note: "Original shared allowance exhausted" };
    }; };
    const rows = Array.from({ length: 200 }, (_, i) => row(String(i)));
    let summary: SearchSummary | undefined;
    const result = await findDeals(query, { targets, onStart: value => { summary = value; } }, steps(rows, prices));
    assert.equal(factories, 1); assert.equal(checked, 100); assert.equal(result.length, 50);
    assert.deepEqual(result.map(value => value.id), rows.slice(50, 100).map(value => value.id));
    assert.ok(result.every(value => value.screen?.soldEvidence?.status === "DEFERRED" && !canAutoAnalyze(value) && resultGroup(value, null) === "candidates"));
    assert.equal(summary?.priceExcluded, 50); assert.equal(summary?.screened, 100); assert.equal(summary?.deferred, 100);
});

test("even a source returning excess rows cannot refill beyond the original two hundred summary window", async () => {
    let checked = 0;
    const prices: SoldScreeningFactory = () => async () => { checked++; return reference(); };
    const rows = [...Array.from({ length: 200 }, (_, i) => row(String(i))), row("outside-window", 1)];
    let summary: SearchSummary | undefined;
    const result = await findDeals(query, { targets, onStart: value => { summary = value; } }, steps(rows, prices));
    assert.deepEqual(result, []); assert.equal(checked, 200); assert.equal(summary?.count, 0);
    assert.equal(summary?.found, 200); assert.equal(summary?.screened, 200); assert.equal(summary?.priceExcluded, 200); assert.equal(summary?.deferred, 0);
});

test("Stop during a refill prevents later price work and emits no partly selected candidate batch", async () => {
    const stopped = new AbortController();
    let checked = 0, emitted = 0;
    const prices: SoldScreeningFactory = ({ signal } = {}) => async () => {
        checked++;
        if (checked === 51) stopped.abort();
        signal?.throwIfAborted();
        return reference();
    };
    const result = await findDeals(query, { targets, signal: stopped.signal, onListing: () => { emitted++; } },
        steps(Array.from({ length: 200 }, (_, i) => row(String(i))), prices));
    assert.deepEqual(result, []); assert.ok(checked >= 51 && checked <= 54); assert.equal(emitted, 0);
});

test("a refill storage failure aborts its sibling work without reopening the shared screening session", async () => {
    const failure = new StorageUnavailableError("Saved evidence is unavailable");
    let factories = 0, checked = 0, aborted = 0, emitted = 0;
    const prices: SoldScreeningFactory = ({ signal } = {}) => { factories++; return async () => {
        checked++;
        if (checked <= 50) return reference();
        if (checked === 51) throw failure;
        await new Promise<void>((_resolve, reject) => {
            if (signal!.aborted) { aborted++; reject(signal!.reason); }
            else signal!.addEventListener("abort", () => { aborted++; reject(signal!.reason); }, { once: true });
        });
        return reference();
    }; };
    await assert.rejects(findDeals(query, { targets, onListing: () => { emitted++; } },
        steps(Array.from({ length: 200 }, (_, i) => row(String(i))), prices)), error => error === failure);
    assert.equal(factories, 1); assert.ok(checked >= 51 && checked <= 54); assert.equal(aborted, checked - 51); assert.equal(emitted, 0);
});

test("new-ID discovery remembers completed price exclusions without showing them or screening them again", async () => {
    const remembered = new Set<string>();
    const rows = [row("overpriced"), row("also-overpriced"), row("worthwhile", 40)];
    const emitted: string[] = [];
    let priceChecks = 0, sourcePages = 0;
    const prices: SoldScreeningFactory = () => async () => { priceChecks++; return reference(); };
    const dependencies = steps(rows, prices);
    const find = (text: string, options: Parameters<typeof findDeals>[1]) => findDeals(text, options, {
        ...dependencies, search: async () => { sourcePages++; return dependencies.search(); },
    });
    const discover = createNewListingDiscovery({ find, usage: async () => null,
        history: { seen: async () => [...remembered], remember: async (_query, _minimum, ids) => { for (const id of ids) remembered.add(id); } },
    });
    let summary: SearchSummary | undefined;
    await discover(query, { targets, onListing: value => emitted.push(value.id), onStart: value => { summary = value; } });
    assert.deepEqual(emitted, ["worthwhile"]); assert.equal(summary?.count, 1); assert.equal(summary?.priceExcluded, 2);
    assert.deepEqual([...remembered].sort(), ["also-overpriced", "overpriced", "worthwhile"]);
    assert.equal(priceChecks, 3);
    await discover(query, { targets, onListing: value => emitted.push(value.id) });
    assert.equal(sourcePages, 2, "an explicit newest scan still checks its one source page");
    assert.equal(priceChecks, 3, "seen price exclusions cannot repeat their price research in a new-ID scan");
    assert.deepEqual(emitted, ["worthwhile"]);

    rows[0].currentPrice = 40;
    const ordinary = await find(query, { targets });
    assert.equal(priceChecks, 6, "normal searches reconsider current terms instead of treating seen history as a rejection authority");
    assert.deepEqual(new Set(ordinary.map(value => value.id)), new Set(["overpriced", "worthwhile"]));
});

test("new-ID history keeps earlier completed exclusions but never marks a cancelled or unprocessed refill", async () => {
    const stopped = new AbortController();
    const remembered = new Set<string>();
    let checked = 0, emitted = 0;
    const prices: SoldScreeningFactory = ({ signal } = {}) => async () => {
        checked++;
        if (checked === 51) stopped.abort();
        signal?.throwIfAborted();
        return reference();
    };
    const dependencies = steps(Array.from({ length: 200 }, (_, i) => row(String(i))), prices);
    const discover = createNewListingDiscovery({ find: (text, options) => findDeals(text, options, dependencies), usage: async () => null,
        history: { seen: async () => [...remembered], remember: async (_query, _minimum, ids) => { for (const id of ids) remembered.add(id); } },
    });
    await discover(query, { targets, signal: stopped.signal, onListing: () => { emitted++; } });
    assert.equal(emitted, 0); assert.equal(remembered.size, 50);
    assert.deepEqual([...remembered], Array.from({ length: 50 }, (_, i) => String(i)));
    assert.ok(checked >= 51 && checked <= 54);
});

test("duplicate source IDs are screened once and cannot replace the first source snapshot or fill result slots", async () => {
    const checks: string[] = [];
    const rows = [row("duplicate"), row("duplicate", 1), row("worthwhile", 40)];
    let summary: SearchSummary | undefined;
    const result = await findDeals(query, { targets, onStart: value => { summary = value; } }, steps(rows, () => async value => {
        checks.push(value.id); return reference();
    }));
    assert.deepEqual(checks, ["duplicate", "worthwhile"]); assert.deepEqual(result.map(value => value.id), ["worthwhile"]);
    assert.equal(summary?.found, 2); assert.equal(summary?.screened, 2); assert.equal(summary?.priceExcluded, 1);
});
