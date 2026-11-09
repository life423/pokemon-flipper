import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDeals } from "../../server/deals/find-deals.ts";
import { prioritizeListingText } from "../../server/deals/listing-text-priority.ts";
import { screenListingWithoutAi } from "../../server/deals/screen-listing.ts";
import { readTitleByRules } from "../../server/ai/title-reader.ts";
import { readSearchLocally } from "../../server/search/intent.ts";
import { canAutoAnalyze } from "../../shared/analysis.ts";
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
