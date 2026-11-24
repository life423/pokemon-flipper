import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDeals, type SearchSummary } from "../../server/deals/find-deals.ts";
import { prioritizeListingText } from "../../server/deals/listing-text-priority.ts";
import { screenListingWithoutAi } from "../../server/deals/screen-listing.ts";
import { readTitleByRules } from "../../server/ai/title-reader.ts";
import { readSearchLocally } from "../../server/search/intent.ts";
import { EbayBudgetError } from "../../server/ebay/daily-budget.ts";
import { canAutoAnalyze, resultGroup } from "../../shared/analysis.ts";
import { analysisPriority, compareAnalysisPriority } from "../../shared/analysis-priority.ts";
import { sellerConditionClues } from "../../shared/raw-condition-claim.ts";
import { EnglishOnlyError } from "../../shared/card-language.ts";
import { offlineSearchSteps } from "../fixtures/search-steps.ts";
import type { ListingSummary, ScreeningSoldEvidence } from "../../shared/types.ts";

const listing = (title = "Charizard Base Set 4/102 Unlimited Holo English", extra: Partial<ListingSummary> = {}): ListingSummary => ({
    id: "v1|1|0", title, currentPrice: 80, shipping: 5, bids: 0, isGraded: false, buyingOption: "FIXED_PRICE", endTime: null,
    images: ["offline-photo"], url: "#", seller: null, ...extra,
});
const read = async (title: string) => readTitleByRules(title);

test("discovery reports source and settled pricing progress before retaining any listing", async () => {
    const rows = [listing(undefined, { id: "one" }), listing(undefined, { id: "two" })];
    const progress: { found: number; screened: number }[] = [];
    let release!: () => void, started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const pricingStarted = new Promise<void>(resolve => { started = resolve; });
    let titleBatches = 0, emitted = 0;
    const search = findDeals("Charizard Base Set", { onProgress: value => progress.push(value), onListing: () => { emitted++; } },
        offlineSearchSteps(rows, {
            readTitle: async () => assert.fail("the prepared title map handles this page"),
            readTitles: async titles => { titleBatches++; return new Map(titles.map(title => [title, readTitleByRules(title)])); },
            soldScreening: () => async () => { started(); await wait; return { status: "UNAVAILABLE", exactScope: false, references: [], note: "No saved sales." }; },
        }));
    await pricingStarted;
    assert.deepEqual(progress, [{ found: 2, screened: 0 }]);
    assert.equal(emitted, 0);
    release();
    const retained = await search;
    assert.equal(titleBatches, 1);
    assert.equal(retained.length, 2);
    assert.deepEqual(progress.at(-1), { found: 2, screened: 2 });
});

test("foreign-language searches stop before query interpretation or source requests", async () => {
    const steps = offlineSearchSteps([], { readIntent: async () => assert.fail("foreign searches cannot start query research"),
        search: async () => assert.fail("foreign searches cannot consume eBay allowance") });
    await assert.rejects(findDeals("Japanese Charizard", {}, steps), EnglishOnlyError);
});

test("saved or literal metadata removes foreign, junk and wrong-identity cards without provider work", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("metadata screening cannot dispatch provider requests"));
    const intent = readSearchLocally("Charizard Base Set 4/102 Unlimited holo");
    for (const [title, mismatch] of [["Charizard Base Set 4/102 Japanese Holo", "OTHER_LANGUAGE"],
        ["Charizard Base Set 4/102 custom proxy", "JUNK"], ["Charizard Base Set 2 4/130 Holo", "OTHER_SET"],
        ["Charizard Base Set 5/102 Holo", "OTHER_CARD"], ["Charizard Base Set 4/102 First Edition Holo", "OTHER_PRINTING"]]) {
        assert.equal((await screenListingWithoutAi(listing(title), intent, undefined, read)).match, mismatch);
    }
    assert.equal(fetch.mock.callCount(), 0);
});

test("metadata transcribes seller grade and condition without claiming label or photo confirmation", async () => {
    const raw = await screenListingWithoutAi(listing("Charizard Base Set 4/102 Unlimited Holo LP"), null, undefined, read);
    assert.equal(raw.cardCondition, "Lightly Played"); assert.equal(raw.screen?.needsAnalysis, "IDENTITY");
    assert.equal(raw.screen?.status, "UNSCREENED"); assert.equal(raw.screen?.bestCase, null);
    const slab = await screenListingWithoutAi(listing("Charizard Base Set 4/102 Unlimited Holo CGC 8.5", { isGraded: true }), null, undefined, read);
    assert.deepEqual([slab.listedAttributes?.grader, slab.listedAttributes?.grade], ["CGC", 8.5]);
    assert.equal(slab.screen?.needsAnalysis, "SLAB_LABEL"); assert.equal(slab.screen?.evidence?.mainPhoto, "UNKNOWN");
});

test("title condition only fills an absent field and preserves structured seller claims and notes", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("local metadata cannot call a provider"));
    const title = "Charizard Base Set 4/102 Unlimited Holo Mint English";
    for (const cardCondition of ["Heavily played (Poor)", "Damaged", "Unknown", " Near Mint "]) {
        const notes = ["Seller condition details remain available."];
        const original = listing(title, { cardCondition, conditionNotes: notes });
        const result = await screenListingWithoutAi(original, null, undefined, read);
        assert.equal(result.cardCondition, cardCondition); assert.equal(result.conditionNotes, notes);
        assert.equal(original.cardCondition, cardCondition, "the source listing is not changed");
    }
    for (const cardCondition of [undefined, null, "", "   "]) {
        const result = await screenListingWithoutAi(listing(title, { cardCondition }), null, undefined, read);
        assert.equal(result.cardCondition, "Near Mint", "retain the existing title-reader vocabulary for a missing field");
    }
    assert.equal(fetch.mock.callCount(), 0);
});

test("the search pipeline retains HP metadata against a Mint title for cautious priority without rejecting the card", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("only injected metadata/sold evidence may run"));
    const row = listing("Charizard Base Set 4/102 Unlimited Holo Mint English", {
        currentPrice: 40, shipping: 5, images: ["front-photo", "back-photo"], cardCondition: "Heavily played (Poor)",
        conditionNotes: ["The card is heavily played."],
    });
    const source = JSON.stringify(row);
    const sold: ScreeningSoldEvidence = { status: "AVAILABLE", exactScope: true, note: "Saved matched raw market context", references: [{
        recordId: 1, name: "Charizard", set: "Base Set", cardNumber: "4/102", printing: "UNLIMITED", finish: "HOLO", grader: null, grade: null, condition: null,
        summary: { grader: "RAW", grade: "UNSPECIFIED", windowDays: 90, count: 3, median: 100, low: 90, high: 110,
            newestSale: new Date(Date.now() - 86400000).toISOString(), confidence: "MEDIUM", dropped: {}, sales: [] },
    }] };
    const results = await findDeals("Charizard Base Set 4/102 Unlimited holo", {}, offlineSearchSteps([row], {
        soldScreening: () => async () => structuredClone(sold),
    }));
    assert.equal(results.length, 1); const result = results[0];
    assert.equal(result.cardCondition, row.cardCondition); assert.deepEqual(result.conditionNotes, row.conditionNotes);
    const clues = sellerConditionClues(result);
    assert.equal(clues.claim, null); assert.equal(clues.conflict, true); assert.equal(clues.severe, true);
    const priority = analysisPriority(result);
    assert.equal(priority.rawMarketContext?.caution, "SELLER_DAMAGE"); assert.equal(priority.contextPriority, false);
    assert.equal(result.match, undefined); assert.equal(result.screen?.status, "UNSCREENED"); assert.equal(canAutoAnalyze(result), true);
    assert.equal(priority.expectedProfit, null); assert.equal(result.screen?.bestCase, null);
    assert.equal(JSON.stringify(row), source); assert.equal(fetch.mock.callCount(), 0);
});

test("unknown requested slab grades stay unpriced while explicit wrong grades are excluded before sold research", async () => {
    const rows = [listing("Aquapolis Holo PSA 6", { id: "low", isGraded: true }), listing("Aquapolis Holo CGC 8", { id: "other", isGraded: true }),
        listing("Aquapolis Holo PSA", { id: "unknown", isGraded: true }), listing("Aquapolis Holo PSA 8", { id: "eight", isGraded: true })];
    const researched: string[] = [];
    const result = await findDeals("Aquapolis PSA 7 or better holo", {}, offlineSearchSteps(rows, { soldScreening: () => async row => {
        researched.push(row.id); return { status: "UNAVAILABLE", exactScope: false, references: [], note: "No exact saved grade market" };
    } }));
    assert.deepEqual(researched, ["unknown", "eight"]); assert.deepEqual(result.map(row => row.id), ["unknown", "eight"]);
    assert.ok(result.every(row => !canAutoAnalyze(row))); assert.equal(result[0].listedAttributes?.grade, null);
});

test("metadata preserves unknown shipping and a real zero quote as different inputs", async () => {
    for (const shipping of [null, 0, 7]) {
        const result = await screenListingWithoutAi(listing(undefined, { shipping }), null, undefined, read);
        assert.equal(result.shipping, shipping);
        assert.equal(result.screen?.money, undefined, "metadata cannot invent an investment or safe bid");
    }
});

test("text screening reorders equally ranked photo candidates without changing eligibility or evidence", async () => {
    const row = (id: string, extra: Partial<ListingSummary> = {}) => listing(undefined, {
        id, screen: { status: "CANDIDATE", card: null, bestCase: null, assumed: null }, ...extra,
    });
    const disclosed = row("disclosed", { conditionNotes: ["Card has a peeled layer."] });
    const normal = row("normal");
    const stronger = row("stronger", { images: ["a", "b", "c", "d"] });
    const ordered = [stronger, disclosed, normal];
    let requests = 0;
    const ranked = await prioritizeListingText(ordered, undefined, undefined, async ({ request, validate }) => {
        requests++;
        assert.equal(request.photos.length, 0);
        assert.match(request.prompt, /peeled layer/);
        return { result: validate({ later: [1] }), key: "fake", reused: false, answeredAt: "", usage: { inputTokens: 0, outputTokens: 0 } };
    });
    assert.equal(requests, 1);
    assert.deepEqual(ranked.map(row => row.id), ["stronger", "normal", "disclosed"]);
    assert.deepEqual([...ranked].sort(compareAnalysisPriority), ranked, "the browser's stable sort retains the text tie-break");
    assert.equal(ranked[2], disclosed);
    assert.ok(ranked.every(canAutoAnalyze));

    const fallback = await prioritizeListingText(ordered, undefined, undefined, async ({ validate }) => {
        validate({ later: [99] });
        return assert.fail("out-of-range model row must be rejected");
    });
    assert.equal(fallback, ordered);
    assert.equal(await prioritizeListingText([stronger, normal], undefined, undefined,
        async () => assert.fail("unequal candidates do not spend on text")).then(rows => rows[0]), stronger);
});

test("the search skips listing text screening when automatic photos are off", async () => {
    const steps = offlineSearchSteps([listing()], { prioritizeText: async () => assert.fail("no automatic photo queue to prioritize") });
    assert.equal((await findDeals("Charizard Base Set holo", { automaticPhotos: false }, steps)).length, 1);
});

const slabQuery = "Charizard Base Set 4/102 Unlimited holo PSA 8";
const slab = (id: string, currentPrice = 80) =>
    listing("Charizard Base Set 4/102 Unlimited Holo English PSA 8", { id, currentPrice, isGraded: true });
const slabSales: ScreeningSoldEvidence = { status: "AVAILABLE", exactScope: true, note: "Exact recent sold evidence", references: [{
    recordId: 1, name: "Charizard", set: "Base Set", cardNumber: "4/102", printing: "UNLIMITED", finish: "HOLO",
    grader: "PSA", grade: "8", condition: null,
    summary: { grader: "PSA", grade: "8", windowDays: 90, count: 3, median: 100, low: 90, high: 110,
        newestSale: new Date(Date.now() - 86400000).toISOString(), confidence: "MEDIUM", dropped: {}, sales: [] },
}] };
const binFilters = { typeFilter: "FIXED_PRICE", kindFilter: "graded", minPrice: 25, maxPrice: 125 } as const;

test("a weak newest BIN pass admits a cheaper candidate even with all matching slots filled", async () => {
    const cheap = slab("cheap-deferred", 40);
    const newest = [...Array.from({ length: 50 }, (_, index) => slab(`newest-${index}`)), cheap];
    const duplicate = { ...newest[0], currentPrice: 35 };
    const newCheap = slab("cheap-new", 42);
    const wrongSet = { ...slab("wrong-set", 30), title: "Charizard Base Set 2 4/130 Unlimited Holo English PSA 8" };
    const lookup = offlineSearchSteps([]).soldScreening!();
    const queried: Array<[string, string | undefined]> = [];
    const checked: string[] = [];
    let screeningSessions = 0;
    const emitted: ListingSummary[] = [];
    let summary: SearchSummary | undefined;
    const result = await findDeals(slabQuery, {
        filters: binFilters, automaticPhotos: true, onListing: row => emitted.push(row), onStart: value => { summary = value; },
    }, offlineSearchSteps([], {
        search: async (query, options) => {
            queried.push([query, options?.sort]);
            assert.deepEqual(options?.filters, binFilters);
            assert.equal(options?.maxResults, 200);
            if (options?.sort === "price") {
                assert.equal(options.keepReserve, true);
                assert.equal(checked.length, newest.length, "screen the rest of the fetched newest page before widening");
                return { listings: [wrongSet, duplicate, { ...cheap, currentPrice: 39 }, newCheap], total: 250, skipped: 0 };
            }
            return { listings: newest, total: 250, skipped: 0 };
        },
        soldScreening: () => {
            screeningSessions++;
            return async (row, intent) => {
                checked.push(row.id);
                return row.id === cheap.id || row.id === newCheap.id ? slabSales : lookup(row, intent);
            };
        },
    }));
    assert.deepEqual(queried.map(([, sort]) => sort), ["newlyListed", "price"]);
    assert.equal(queried[0][0], queried[1][0]);
    assert.equal(screeningSessions, 1);
    assert.deepEqual(checked, [...newest.map(row => row.id), newCheap.id]);
    assert.equal(result.length, 50);
    assert.deepEqual(emitted, result);
    assert.deepEqual(result.filter(canAutoAnalyze).map(row => row.id), [cheap.id, newCheap.id]);
    assert.equal(resultGroup(result.find(row => row.id === cheap.id)!, null), "candidates");
    assert.equal(result.find(row => row.id === cheap.id)?.currentPrice, cheap.currentPrice);
    assert.equal(result.find(row => row.id === duplicate.id)?.currentPrice, newest[0].currentPrice);
    assert.equal(summary?.pricePass?.status, "COMPLETE");
    assert.equal(summary?.pricePass?.candidates, 1);
    assert.equal(summary?.found, 53);
    assert.equal(summary?.deferred, 0);
});

test("the cheaper pass is skipped for new inventory, enough candidates, or a complete source page", async () => {
    for (const { newOnly, supported, total } of [
        { newOnly: undefined, supported: true, total: 250 },
        { newOnly: { excludeIds: [] }, supported: false, total: 250 },
        { newOnly: undefined, supported: false, total: 3 },
    ]) {
        const newest = [slab("one", 40), slab("two", 41), slab("three", 42)];
        let requests = 0;
        const result = await findDeals(slabQuery, { filters: binFilters, newOnly, automaticPhotos: true }, offlineSearchSteps([], {
            search: async (_query, options) => {
                requests++;
                assert.equal(options?.sort, "newlyListed");
                return { listings: newest, total, skipped: 0 };
            },
            ...(supported ? { soldScreening: () => async () => slabSales } : {}),
        }));
        assert.equal(requests, 1);
        assert.equal(result.length, newest.length);
        assert.equal(result.filter(canAutoAnalyze).length, supported ? newest.length : 0);
    }
});

test("cheaper listings with preliminary margin can displace newest slab verification near misses", async () => {
    const nearMisses = Array.from({ length: 50 }, (_, index) => slab(`near-miss-${index}`, 80));
    const cheap = slab("cheaper-with-margin", 40);
    let summary: SearchSummary | undefined;
    const result = await findDeals(slabQuery, { filters: binFilters, onStart: value => { summary = value; } }, offlineSearchSteps([], {
        soldScreening: () => async () => slabSales,
        search: async (_query, options) => ({ listings: options?.sort === "price" ? [cheap] : nearMisses, total: 250, skipped: 0 }),
    }));
    assert.equal(result.length, 50);
    assert.equal(result[0].id, cheap.id);
    assert.equal(result.filter(canAutoAnalyze).length, 50);
    assert.equal(summary?.pricePass?.candidates, 1);
});

test("eBay reserve denial on the optional cheaper pass keeps newest BIN results", async () => {
    const newest = slab("newest");
    const sorts: Array<string | undefined> = [];
    let summary: SearchSummary | undefined;
    const result = await findDeals(slabQuery, {
        filters: binFilters, automaticPhotos: true, onStart: value => { summary = value; },
    }, offlineSearchSteps([], {
        search: async (_query, options) => {
            sorts.push(options?.sort);
            if (options?.sort === "price") throw new EbayBudgetError("Extra searches paused to preserve today's reserve.");
            return { listings: [newest], total: 250, skipped: 0 };
        },
    }));
    assert.deepEqual(sorts, ["newlyListed", "price"]);
    assert.deepEqual(result.map(row => row.id), [newest.id]);
    assert.equal(summary?.pricePass?.status, "UNAVAILABLE");
});

test("the final start event authorizes fifteen distinct retained copies, including researchable missing sales and auctions", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => listing(undefined, { id: String(i),
        ...(i % 2 && { buyingOption: "AUCTION" as const, endTime: new Date(Date.now() + 3_600_000).toISOString() }),
    }));
    const selected = rows.slice(-15).reverse().map(row => row.id);
    const starts: SearchSummary[] = [];
    const emitted: string[] = [];
    let rankings = 0;
    const results = await findDeals("Charizard Base Set 4/102 Unlimited holo", {
        automaticPhotos: true, onStart: value => { starts.push(value); }, onListing: row => {
            assert.deepEqual(starts.at(-1)?.reviewSelection?.listingIds, selected);
            emitted.push(row.id);
        },
    }, offlineSearchSteps(rows, {
        prioritizeText: async () => assert.fail("only one batch selection per search"),
        selectReviews: async eligible => {
            rankings++;
            assert.deepEqual(new Set(eligible.map(row => row.id)), new Set(rows.map(row => row.id)));
            assert.ok(eligible.some(row => row.buyingOption === "AUCTION" && row.screen?.soldEvidence?.status === "UNAVAILABLE"));
            return { source: "ai", listingIds: selected };
        },
    }));
    assert.equal(rankings, 1);
    assert.deepEqual(emitted.slice(0, 15), selected);
    assert.deepEqual(results.map(row => row.id), emitted);
    assert.equal(new Set(emitted).size, 50);
    assert.deepEqual(starts.at(-1)?.reviewSelection, { source: "ai", listingIds: selected });
    const off = await findDeals("Charizard Base Set 4/102 Unlimited holo", { automaticPhotos: false,
        onStart: summary => assert.equal(summary.reviewSelection, undefined),
    }, offlineSearchSteps(rows, { selectReviews: async () => assert.fail("manual search must never schedule ranking work") }));
    assert.equal(off.length, 50);
});

test("an auction that closes during selection is excluded from the final search and replaced without a second ranking call", async t => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const rows = Array.from({ length: 17 }, (_, i) => listing(undefined, { id: String(i),
        ...(i === 0 && { buyingOption: "AUCTION" as const, endTime: new Date(now + 2000).toISOString() }),
    }));
    let summary: SearchSummary | undefined;
    let selections = 0;
    const results = await findDeals("Charizard Base Set 4/102 Unlimited holo", {
        automaticPhotos: true, onStart: value => { summary = value; },
    }, offlineSearchSteps(rows, {
        selectReviews: async eligible => {
            selections++;
            assert.ok(eligible.some(row => row.id === "0"));
            now += 3000;
            return { source: "ai", listingIds: rows.slice(0, 15).map(row => row.id) };
        },
    }));
    assert.equal(selections, 1);
    assert.equal(results.length, 16);
    assert.ok(results.every(row => row.id !== "0"));
    assert.equal(summary?.count, 16);
    assert.deepEqual(summary?.reviewSelection, { source: "rules", listingIds: results.slice(0, 15).map(row => row.id) });
});
