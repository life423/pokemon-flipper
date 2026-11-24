import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDeals, type SearchSummary } from "../../server/deals/find-deals.ts";
import { searchDeals } from "../../server/deals/search.ts";
import { createPriceFirstSession, type SoldScreeningFactory } from "../../server/deals/price-first.ts";
import { createSoldScreening } from "../../server/pricing/screening-sales.ts";
import { createNewListingDiscovery } from "../../server/deals/new-listings.ts";
import { readSearchLocally } from "../../server/search/intent.ts";
import { readTitleByRules } from "../../server/ai/title-reader.ts";
import { createBoundedEvaluator, type BoundedReading } from "../../server/analysis/bounded-evaluate.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import { addBinMarketComparisons, currentBinComparison } from "../../shared/bin-market-comparison.ts";
import { analysisPriority } from "../../shared/analysis-priority.ts";
import { autoAnalysisBlockReason, canAutoAnalyze, resultGroup } from "../../shared/analysis.ts";
import { listingEvidenceKey } from "../../shared/listing-evidence.ts";
import { filterSearchResults, groupSearchResults } from "../../client/src/search/results.ts";
import type { AnalysisState } from "../../client/src/analysis-state.ts";
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

test("Buy It Now compares both discovery pages before choosing a price lead and retains its actual resale loss", async () => {
    const reference = evidence(false, 100);
    reference.references[0].summary.sales.forEach(sale => { sale.saleType = "fixed_price"; });
    const nm = (id: string, ask: number, shipping: number | null = 0) =>
        listing(id, { currentPrice: ask, shipping, cardCondition: "Near Mint", termsCheckedAt: new Date(NOW).toISOString() });
    const target = nm("lead", 80, 10), peer1 = nm("peer1", 100), peer2 = nm("peer2", 100, 10), peer3 = nm("peer3", 125);
    let pages = 0;
    const dependencies = steps([], factory(async () => reference));
    const results = await findDeals("Charizard Base Set 4/102 holo", {
        filters: { typeFilter: "FIXED_PRICE", kindFilter: "raw" }, targets, asOf: NOW,
    }, { ...dependencies, search: async () => ({
        listings: ++pages === 1 ? [peer1, target, peer2] : [peer2, peer3, nm("unknown", 105, null)],
        total: 201, skipped: 0,
    }) });
    assert.equal(pages, 2);
    const top = results[0];
    assert.equal(top.id, target.id);
    const signal = currentBinComparison(top);
    assert.ok(signal);
    assert.deepEqual([signal.delivered, signal.otherAskMedian, signal.otherAskCount, signal.soldMedian, signal.soldCount, signal.discountPercent],
        [90, 110, 3, 100, 3, 10], "use the smaller discount; free and paid shipping contribute to delivered asking");
    assert.equal(signal.condition, "NEAR_MINT");
    assert.ok(analysisPriority(top, targets).expectedProfit! < 0);
    assert.equal(analysisPriority(top, targets).band, 0);
    assert.notEqual(resultGroup(top, null), "deals");
    assert.equal(currentBinComparison({ ...top, shipping: null }), null);
    assert.equal(currentBinComparison(results.find(row => row.id === "unknown")!), null);
});

test("market comparison requires three other distinct exact BINs and three supported recent transactions", () => {
    const evidenceWith = (change?: (ref: ScreeningSoldEvidence["references"][number]) => void) => {
        const ev = evidence(false, 120);
        ev.references[0].summary.sales.forEach(sale => { sale.saleType = "fixed_price"; });
        change?.(ev.references[0]);
        return ev;
    };
    const row = (id: string, price: number, ev = evidenceWith(), extra: Partial<ListingSummary> = {}): ListingSummary => listing(id, {
        cardCondition: "Near Mint", currentPrice: price, shipping: 0, termsCheckedAt: new Date(NOW).toISOString(), screen: {
            status: "UNSCREENED", soldEvidence: ev, reason: null, card: null, bestCase: null, assumed: null,
        }, ...extra,
    });
    const subject = row("v1|123456789123|0", 68), one = row("1", 80), two = row("2", 85), three = row("3", 90);
    const invalid = [
        { ...subject, id: "v1|123456789123|1" }, { ...one }, row("undated", 83, undefined, { termsCheckedAt: undefined }), row("unknown", 82, undefined, { shipping: null }),
        row("auction", 70, undefined, { buyingOption: "AUCTION" }), row("ended", 82, undefined, { availability: "UNAVAILABLE" }),
        row("grade", 160, evidence(true), { isGraded: true }), row("lp", 82, undefined, { cardCondition: "Lightly Played" }),
        row("printing", 84, evidenceWith(ref => { ref.printing = "FIRST_EDITION"; })),
        row("finish", 84, evidenceWith(ref => { ref.finish = "REVERSE_HOLO"; })),
        row("record", 84, evidenceWith(ref => { ref.recordId = 2; })),
    ];
    assert.equal(currentBinComparison(addBinMarketComparisons([subject, one, two, ...invalid], [], NOW)[0]), null);
    const lead = addBinMarketComparisons([subject, one, two], [three, ...invalid], NOW)[0];
    assert.equal(currentBinComparison(lead)?.discountPercent, 20, "the active median sets the smaller discount here");
    assert.equal(currentBinComparison(lead)?.otherAskCount, 3);
    const snapshot = (asOf: string) => ({ ...lead, screen: { ...lead.screen!, marketComparison: { ...lead.screen!.marketComparison!, asOf } } });
    const asOf = NOW - 1_000;
    assert.ok(currentBinComparison(snapshot(new Date(asOf).toISOString()), undefined, asOf + BEST_BUY_TERMS_MAX_AGE_MS - 1));
    for (const checked of [new Date(NOW - BEST_BUY_TERMS_MAX_AGE_MS).toISOString(), new Date(NOW + 1).toISOString(), "invalid"]) {
        const cached = snapshot(checked);
        assert.equal(currentBinComparison(cached, undefined, NOW), null);
        assert.equal(analysisPriority(cached, targets, NOW).marketDiscount, undefined, "old unevaluated rows lose queue priority too");
    }
    const nearExpiry = { ...three, termsCheckedAt: new Date(NOW - BEST_BUY_TERMS_MAX_AGE_MS + 1).toISOString() };
    const mixedAge = addBinMarketComparisons([subject, one, two, nearExpiry], [], NOW)[0];
    assert.ok(currentBinComparison(mixedAge, undefined, NOW));
    assert.equal(currentBinComparison(mixedAge, undefined, NOW + 1), null, "assembling an old page cannot renew its prices");
    const withoutSales = evidenceWith(ref => { ref.summary.sales = []; });
    const oldSales = evidenceWith(ref => { ref.summary.sales[0].soldAt = new Date(NOW - 91 * DAY).toISOString(); });
    const repeated = evidenceWith(ref => { ref.summary.sales.forEach(sale => { sale.url = "https://www.ebay.com/itm/123456789321"; }); });
    for (const ev of [withoutSales, oldSales, repeated]) {
        assert.equal(currentBinComparison(addBinMarketComparisons([row("new", 68, ev), one, two, three], [], NOW)[0]), null);
    }
    assert.equal(currentBinComparison(addBinMarketComparisons([lead, one, two], [], NOW)[0]), null, "clear a stale search comparison");
    assert.equal(currentBinComparison({ ...lead, currentPrice: 100 }), null, "changed terms need a fresh comparison");
    const broad = evidenceWith(ref => { ref.condition = null; ref.summary.grade = "UNSPECIFIED"; });
    const unknownCondition = (id: string, ask: number) => row(id, ask, broad, { cardCondition: null });
    const unspecified = addBinMarketComparisons([unknownCondition("unknown1", 68), unknownCondition("unknown2", 80),
        unknownCondition("unknown3", 85), unknownCondition("unknown4", 90), one], [], NOW)[0];
    assert.equal(currentBinComparison(unspecified)?.condition, null);
    assert.equal(currentBinComparison(unspecified)?.otherAskCount, 3);
});

test("an exact-card BIN search compares a stronger raw copy late on the same page before filling the display", async () => {
    const first = Array.from({ length: 50 }, (_, index) => listing(`early-${index}`));
    const last = listing("better-buy", { currentPrice: 30 });
    const screened: string[] = [], overflow: string[] = [];
    let pages = 0;
    const dependencies = steps([...first, last], factory(async row => { screened.push(row.id); return evidence(); }));
    const result = await findDeals("Charizard Base Set 4/102 holo", {
        filters: { typeFilter: "FIXED_PRICE", kindFilter: "raw" }, targets, onScreenedOverflow: row => overflow.push(row.id),
    }, { ...dependencies, search: async () => { pages++; return dependencies.search(); } });
    assert.equal(pages, 1);
    assert.equal(screened.length, 51);
    assert.equal(result.length, 50);
    assert.equal(result[0]?.id, last.id);
    assert.deepEqual(overflow, [first[49]!.id]);
});

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
    const card: CardRecord = { source: "pkmnprices", id: 1, name: "Charizard", setName: "Base Set", cardNumber: "4/102",
        variants: [{ name: "Unlimited Holofoil", printing: "UNLIMITED", finish: "HOLO" }] };
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

test("Buy It Now emits a profitable slab, a loss and an unresolved row and replays without new paid work", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("the search-to-Deals regression must remain offline"));
    const candidate = listing("profitable", { title: "Charizard Base Set 4/102 Unlimited Holo English PSA 8", isGraded: true });
    const loss = listing("loss", { title: candidate.title, isGraded: true,
        images: ["https://i.ebayimg.com/images/g/offline-loss/s-l1600.jpg"] });
    const missing = listing("no-exact-sales", { title: "Charizard Base Set 4/102 Unlimited Holo English CGC 8", isGraded: true });
    const card: CardRecord = { source: "pkmnprices", id: 1, name: "Charizard", setName: "Base Set", cardNumber: "4/102",
        variants: [{ name: "Unlimited Holofoil", printing: "UNLIMITED", finish: "HOLO" }] };
    const sales: Comp[] = [190, 200, 210].map((price, index) => ({ id: index, title: candidate.title, price, currency: "USD",
        sold_at: new Date(NOW - (index + 1) * DAY).toISOString(), sale_type: "fixed_price", attribution: "exact", variant: "Unlimited Holofoil", grader: "PSA", grade: "8" }));
    const fetchComps: Parameters<typeof createBoundedEvaluator>[0]["fetchComps"] = async (_id, { grader, grade }) => grader === "PSA" && grade === "8" ? sales : [];
    const lookupCards = async () => [card];
    const fetchRawComps = async () => assert.fail("verified slabs must not look up raw comps");
    const prices: SoldScreeningFactory = options => createSoldScreening({ ...options, source: { lookupCards, fetchRawComps, fetchComps } });
    const cache = new Map<string, unknown>();
    let assessments = 0;
    const reading: BoundedReading = { condition: null, photoCheck: { cardCount: "ONE", holder: "GRADED_SLAB", photoSufficiency: "SUFFICIENT", confidence: "HIGH",
        printedName: "Charizard", printedNumber: "4/102", cardIdentity: { name: "Charizard", set: "Base Set", cardNumber: "4/102", language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Readable card and slab label."] },
        images: [{ number: 1, view: "FRONT", usable: true, isStockImage: false, issues: [], obscuresCondition: false }], missingViews: [], problems: [], cardMatch: { verdict: "MATCH", problems: [] },
        printingMarks: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT", reprintMark: "NONE_SEEN", evidence: ["Printed artwork shadow is visible."] },
        slab: { present: true, grader: "PSA", grade: "8", gradeQualifier: null, certNumber: "12345678", labelText: "1999 POKEMON GAME CHARIZARD-HOLO #4 NM-MT 8",
            caseCondition: "INTACT", authenticity: "NONE_SEEN", authenticityEvidence: [], concerns: [] } } };
    const evaluate = createBoundedEvaluator({ now: () => NOW, saved: async () => null, assertPriceAvailable: async () => {},
        cached: async <T>(key: string) => (cache.get(key) ?? null) as T | null,
        save: async (key, value) => { cache.set(key, structuredClone(value)); },
        details: async id => {
            const row = id === candidate.id ? candidate : id === loss.id ? loss : assert.fail("a missing exact market should not reach photo assessment");
            return { ...row, price: row.currentPrice, shipping: id === loss.id ? 175 : row.shipping,
                availability: "ACTIVE", condition: "Graded", cardCondition: null, conditionNotes: [],
                aspects: { "Card Name": "Charizard", Set: "Base Set", "Card Number": "4/102", Language: "English", Finish: "Holo", "Professional Grader": "PSA", Grade: "8" } };
        },
        assess: async () => { assessments++; return { result: reading, usage: { inputTokens: 500, outputTokens: 250 } }; },
        lookup: lookupCards, fetchComps, fetchRawComps, compChecks: async () => new Map(),
    });
    const query = "Charizard Base Set 4/102 holo";
    const filters = { typeFilter: "FIXED_PRICE", kindFilter: "graded" } as const;
    const run = async () => {
        const rows: ListingSummary[] = [], progress: SearchSummary[] = [];
        const dependencies = steps([missing, loss, candidate], prices);
        await searchDeals(query, { filters, targets, onListing: row => rows.push(row), onStart: summary => progress.push(summary) },
            (text, options) => findDeals(text, options, dependencies));
        assert.equal(rows.length, 3);
        assert.equal(progress.at(-1)?.screened, 3);
        assert.equal(progress.at(-1)?.priceExcluded, 0);
        assert.equal(rows.find(row => row.id === missing.id)?.screen?.soldEvidence?.status, "UNAVAILABLE");
        const analyses: Record<string, AnalysisState> = {};
        for (const row of rows.filter(canAutoAnalyze)) {
            const evaluation = await evaluate(row.id, { automatic: true, targets });
            analyses[row.id] = { status: "done", evaluation, evidenceKey: listingEvidenceKey(row) };
        }
        const filtered = filterSearchResults({ listings: rows, analyses, page: "search", intent, now: NOW,
            filters: { ...filters, minPrice: "", maxPrice: "", minGrade: 0 } });
        const grouped = groupSearchResults(filtered, analyses, false, new Set());
        assert.deepEqual(grouped.deals.map(row => row.id), [candidate.id]);
        assert.deepEqual(grouped.losses.map(row => row.id), [loss.id]);
        assert.deepEqual(grouped.candidates.map(row => row.id), [missing.id]);
        const result = analyses[candidate.id];
        assert.equal(result?.status, "done");
        return result.evaluation;
    };
    const first = await run();
    assert.equal(first.slabPricing?.summary?.count, 3);
    assert.equal(first.usage.length, 1);
    assert.equal(assessments, 2);
    const replay = await run();
    assert.deepEqual(replay.usage, []);
    assert.equal(assessments, 2);
});

test("an exact expensive slab is terminal for automatic work while raw grading upside remains eligible", async () => {
    const slab = listing("slab", { title: "Charizard Base Set 4/102 Unlimited Holo PSA 8 English", isGraded: true, currentPrice: 1000 });
    const raw = listing("raw", { currentPrice: 1000, cardCondition: "Near Mint",
        images: ["front", "back", "detail"] });
    const result = await findDeals("Charizard Base Set 4/102 holo", { targets }, steps([slab, raw], factory(async row => evidence(row.isGraded))));
    assert.deepEqual(result.map(row => row.id), ["raw"], "confident preliminary price rejections no longer fill result slots");
    const candidate = result.find(row => row.id === "raw")!;
    assert.equal(candidate.screen?.status, "UNSCREENED"); assert.equal(candidate.screen?.bestCase, null); assert.equal(canAutoAnalyze(candidate), true);
});

test("a raw Buy It Now far above exact clean sales defers paid photos while preserving the listing", async () => {
    const result = await findDeals("Charizard Base Set 4/102 holo", { targets }, steps([
        listing("premium", { currentPrice: 260 }), listing("competitive", { currentPrice: 85 }),
    ], factory(async () => evidence())));
    assert.deepEqual(result.map(row => row.id), ["competitive", "premium"]);
    const [competitive, premium] = result;
    assert.equal(autoAnalysisBlockReason(competitive, NOW), null);
    assert.equal(autoAnalysisBlockReason(premium, NOW), "RAW_PRICE_PREMIUM");
    assert.equal(resultGroup(premium, null), "candidates");
    assert.equal(premium.screen?.bestCase, null);
    assert.equal(canAutoAnalyze({ ...premium, currentPrice: 215 }), true, "exactly twice the high sale stays eligible");
    assert.equal(canAutoAnalyze({ ...premium, shipping: null }), true, "unknown shipping does not trigger this rule");
    assert.equal(canAutoAnalyze({ ...premium, cardCondition: "Near Mint" }), true);
    assert.equal(canAutoAnalyze({ ...premium, images: ["front", "back", "detail"] }), true);
    assert.equal(autoAnalysisBlockReason({ ...premium, images: [
        "https://i.ebayimg.com/images/g/front/s-l500.jpg", "https://i.ebayimg.com/images/g/front/s-l1600.jpg", "back",
    ] }, NOW), "RAW_PRICE_PREMIUM", "resizing a photo does not count as a third view");
    assert.equal(autoAnalysisBlockReason(premium, NOW + 91 * DAY), null, "stale prices cannot suppress research");
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
    const screenPrices = createPriceFirstSession(intent, {}, prices);
    await assert.rejects(screenPrices(Array.from({ length: 50 }, (_, index) => listing(String(index)))), error => error === failure);
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
