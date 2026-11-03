import { test } from "node:test";
import assert from "node:assert/strict";
import { prescreen, type ScreenInput, type ScreenDeps } from "../../server/deals/prescreen.ts";
import type { CardRecord } from "../../server/pricing/types.ts";
import type { ListingSummary } from "../../shared/types.ts";
import { retargetScreen } from "../../shared/money/targets.ts";
import { canAutoAnalyze } from "../../shared/analysis.ts";

const card = (unlimited = 30, firstEdition = 30): CardRecord => ({
    source: "pkmnprices", id: 1, name: "Machop", setName: "Base Set", cardNumber: "52/102", tcgPlayerId: null,
    variants: [
        { name: "Unlimited", printing: "UNLIMITED", finish: "NON_HOLO", prices: [{ condition: "NEAR_MINT", price: unlimited, updatedAt: null }] },
        { name: "1st Edition", printing: "FIRST_EDITION", finish: "NON_HOLO", prices: [{ condition: "NEAR_MINT", price: firstEdition, updatedAt: null }] },
    ],
});
const input = (overrides: Partial<ScreenInput> = {}): ScreenInput => ({
    title: "Machop Base Set 52/102 Unlimited Non-Holo", aspects: { "Card Name": "Machop", Set: "Base Set", "Card Number": "52/102", Language: "English" },
    price: 20, shipping: 0, isGraded: false, cardCondition: "Near mint or better", buyingOption: "FIXED_PRICE", ...overrides,
});
const firstEdition = (price = 5) => input({ title: "Machop Base Set 52/102 1st Edition Non-Holo", price });

function fixture(record: CardRecord | null = card()) {
    const calls = { lookup: 0, rawComps: 0, gradedComps: 0 };
    const deps: ScreenDeps = {
        lookupCards: async () => { calls.lookup++; return record ? [record] : []; },
        fetchRawComps: async () => { calls.rawComps++; return []; },
        fetchComps: async () => { calls.gradedComps++; return []; },
    };
    return { calls, deps };
}

test("a normal $30 non-holo stops at its market feed before sold-copy or graded-comp research", async () => {
    const { calls, deps } = fixture();
    const result = await prescreen(input(), deps);
    assert.equal(result.status, "DROPPED");
    assert.deepEqual(result.lowResale, { minimum: 60, rawMarketMaximum: 30, cheapFirstEditionBaseSet: false });
    assert.equal(result.needsAnalysis, undefined); assert.equal(result.bestCase, null);
    assert.match(result.reason!, /raw market quote.*\$30.*\$60.*manual analysis/i);
    assert.deepEqual(calls, { lookup: 1, rawComps: 0, gradedComps: 0 });
});

test("higher-value non-holos and exact valuable printings remain eligible without a name whitelist", async () => {
    for (const [record, listing] of [[card(60), input()], [card(30, 100), firstEdition(30)]] as const) {
        const { calls, deps } = fixture(record);
        const result = await prescreen(listing, deps);
        assert.equal(result.lowResale, undefined);
        assert.ok(calls.rawComps > 0, "the exact higher-valued variant reaches normal pricing");
        assert.ok(calls.gradedComps > 0);
    }
});

test("a cheap 1st Edition Base Set lead requests focused verification without claiming a deal", async () => {
    const { calls, deps } = fixture();
    for (const price of [3, 10]) {
        const result = await prescreen(firstEdition(price), deps);
        assert.equal(result.status, "UNSCREENED"); assert.equal(result.needsAnalysis, "IDENTITY");
        assert.equal(result.card?.printing, "FIRST_EDITION");
        assert.equal(result.lowResale?.cheapFirstEditionBaseSet, true); assert.equal(result.bestCase, null);
        assert.equal(result.focusedReview, "CHEAP_FIRST_EDITION_BASE_SET");
        assert.match(result.reason!, /not a verified deal/i);
    }
    const aboveLimit = await prescreen(firstEdition(10.01), deps);
    assert.equal(aboveLimit.status, "DROPPED"); assert.equal(aboveLimit.lowResale?.cheapFirstEditionBaseSet, false);
    const disprovenClaim = await prescreen({ ...firstEdition(), photoMarks: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT" } }, deps);
    assert.equal(disprovenClaim.status, "DROPPED"); assert.equal(disprovenClaim.lowResale?.cheapFirstEditionBaseSet, false);
    assert.equal(disprovenClaim.focusedReview, undefined, "a disproven seller claim does not retain the exception");
    assert.equal(calls.rawComps, 0); assert.equal(calls.gradedComps, 0);
});

test("missing prices, unidentified cards and certified slabs are not rejected using a raw feed maximum", async () => {
    const noPrices = card(); noPrices.variants.forEach(variant => { variant.prices = []; });
    for (const [record, listing] of [[noPrices, input()], [null, input({ aspects: {} })],
        [card(), input({ title: "Machop Base Set 52/102 Unlimited Non-Holo PSA 9", isGraded: true })]] as const) {
        const { calls, deps } = fixture(record);
        const result = await prescreen(listing, deps);
        assert.equal(result.lowResale, undefined);
        if (listing.isGraded) assert.ok(calls.gradedComps > 0, "raw value does not cap certified resale");
        if (!record) assert.equal(result.status, "UNSCREENED");
    }
});

test("LP-to-NM and NM-to-Mint opportunities reopen only when existing better-condition feed quotes clear targets", async () => {
    for (const [sellerCondition, claimed, targetCondition] of [["Lightly played (Excellent)", "LIGHTLY_PLAYED", "NEAR_MINT"],
        ["Near mint or better", "NEAR_MINT", "MINT"]] as const) {
        const record = card();
        record.variants[0].prices = [{ condition: claimed, price: 20, updatedAt: null }, { condition: targetCondition, price: 100, updatedAt: null }];
        const { calls, deps } = fixture(record);
        const result = await prescreen(input({ price: 20, cardCondition: sellerCondition }), deps);
        assert.equal(result.status, "UNSCREENED"); assert.equal(result.needsAnalysis, "IDENTITY");
        assert.deepEqual(result.conditionUpside, { sellerCondition: claimed, targetCondition, rawMarketPrice: 100 });
        assert.match(result.reason!, /AI must verify the condition.*not a verified deal/);
        assert.equal(calls.rawComps, 1); assert.equal(calls.gradedComps, 2, "the hypothetical improvement adds no comp requests");
        const tooExpensive = await prescreen(input({ price: 95, cardCondition: sellerCondition }), fixture(record).deps);
        assert.equal(tooExpensive.status, "DROPPED"); assert.equal(tooExpensive.conditionUpside, undefined, "a better label alone cannot justify work if the money still fails");
    }
});

test("a damaged seller claim gets no blanket clean-condition bypass from an unrelated NM quote", async () => {
    const record = card(); record.variants[0].prices = [{ condition: "DAMAGED", price: 5, updatedAt: null }, { condition: "NEAR_MINT", price: 100, updatedAt: null }];
    const result = await prescreen(input({ price: 35, cardCondition: "Damaged" }), fixture(record).deps);
    assert.equal(result.status, "DROPPED"); assert.equal(result.conditionUpside, undefined); assert.equal(result.needsAnalysis, undefined);
});

test("condition-upside screening follows current targets and purchase price without another lookup", async () => {
    const record = card(); record.variants[0].prices = [{ condition: "LIGHTLY_PLAYED", price: 20, updatedAt: null }, { condition: "NEAR_MINT", price: 100, updatedAt: null }];
    const { calls, deps } = fixture(record);
    const original = await prescreen(input({ price: 20, cardCondition: "Lightly played (Excellent)" }), deps);
    assert.equal(original.status, "UNSCREENED");
    const strict = retargetScreen(original, 20, { minProfit: 500, minRoi: 5 });
    assert.equal(strict.status, "DROPPED"); assert.equal(strict.needsAnalysis, undefined);
    const row: ListingSummary = { id: "repriced", title: "Machop", currentPrice: 20, shipping: 0, bids: 0, isGraded: false, buyingOption: "FIXED_PRICE", endTime: null, images: ["front"], url: "#", seller: null, screen: strict };
    assert.equal(canAutoAnalyze(row), false);
    assert.equal(retargetScreen(original, 95, { minProfit: 50, minRoi: 0.25 }).status, "DROPPED");
    assert.equal(retargetScreen(strict, 20, { minProfit: 50, minRoi: 0.25 }).status, "UNSCREENED", "relaxing targets can reopen the saved hypothesis");
    assert.equal(calls.lookup, 1); assert.equal(original.status, "UNSCREENED", "retargeting never mutates the saved screen");
});
