import { test } from "node:test";
import assert from "node:assert/strict";
import { prescreen } from "../../server/deals/prescreen.ts";
import { screenListing } from "../../server/deals/find-deals.ts";
import { digDeeper } from "../../server/deals/dig.ts";
import { canAutoAnalyze, resultGroup } from "../../shared/analysis.ts";
import { toCardRecord } from "../../server/pricing/pkmnprices.ts";

const intent = { cardName: "Mewtwo", sets: ["Base Set"], cardNumber: "10/102", printing: null, graded: null, titleWords: ["mewtwo"], source: "rules" };
const aspects = { "Card Name": "Mewtwo", Set: "Base Set", "Card Number": "10/102", Language: "English" };
const card = toCardRecord({ id: 1, name: "Mewtwo", number: "010", total_set_number: "102", set: { id: 463, name: "Base Set" }, prices: [
    { variant: "Holofoil", condition: "Near Mint", market_price: 300 },
    { variant: "Holofoil", condition: "Heavily Played", market_price: 100 },
    { variant: "Holofoil", condition: "Damaged", market_price: 80 },
] });
const photo = { cardCount: 1, isStockImage: false, shows: "Mewtwo 10/102", printingMarks: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT" },
    card: { name: "Mewtwo", set: "Base Set", cardNumber: "10/102", language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Name, artwork and collector number are legible"] } };
const listing = (id = "cheap", extra = {}) => ({ id, title: "Mewtwo Base Set 10/102 Holo Unlimited", currentPrice: 5, shipping: 0, buyingOption: "FIXED_PRICE", isGraded: false, images: ["front", "back"], seller: null, categoryId: "183454", ...extra });

async function recovery({ inspection = photo, verdict = "MATCH", abortPhoto = false, graded = false } = {}) {
    const counts = { details: 0, comps: 0, photo: 0, mismatchCheck: 0, searches: 0 };
    const controller = new AbortController();
    const listedAspects = graded ? { ...aspects, "Professional Grader": "PSA", Grade: "9" } : aspects;
    const steps = {
        readTitle: async () => ({ aspects: listedAspects, filled: [], kind: "SINGLE_CARD", condition: "Heavily played (Poor)" }),
        loadDetails: async () => { counts.details += 1; return { title: listing().title, aspects, images: ["front", "back"], shipping: 0, cardCondition: "Heavily played (Poor)", conditionNotes: [] }; },
        check: (input) => prescreen(input, { lookupCards: async () => [card], now: Date.parse("2026-10-25T12:00:00Z"), fetchComps: async () => {
            counts.comps += 1;
            return graded ? [190, 200, 210].map((price) => ({ price, sold_at: "2026-10-20", title: "Pokemon Mewtwo Base Set 10/102 Unlimited Holo PSA 9", variant: "Unlimited Holofoil", grader: "PSA", grade: "9", grade_qualifier: null, attribution: "exact" })) : [];
        } }),
        matchPhoto: async () => { counts.mismatchCheck += 1; return verdict === null ? null : { verdict, problems: verdict === "MISMATCH" ? ["anniversary reprint"] : [], firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT" }; },
    };
    const primary = await screenListing(listing("cheap", { isGraded: graded }), steps, intent);
    assert.equal(counts.details, 0);
    assert.equal(counts.comps, 0);
    assert.equal(counts.mismatchCheck, 0);
    assert.equal(primary.match, undefined);
    assert.equal(canAutoAnalyze(primary), true, "the full photo check can verify an unusual price immediately");
    assert.equal(resultGroup(primary, null), "candidates");
    const recovered = [];
    await digDeeper("Mewtwo Base Set", { intent, primaryListings: [primary], excludeIds: [primary.id], signal: controller.signal, onListing: (value) => recovered.push(value) }, {
        plan: async () => [], readIntent: async () => intent,
        search: async () => { counts.searches += 1; throw new Error("primary recovery needs no search requests"); },
        findPhoto: async () => { counts.photo += 1; if (abortPhoto) controller.abort(); return { found: "YES", cardCount: 1, set: "Base Set", cardNumber: "10/102", shows: "Mewtwo", inspection }; },
        screening: () => steps,
    });
    return { recovered, counts, primary };
}

test("a genuinely underpriced photo match resumes existing screening without extra searches or duplicate mismatch checks", async () => {
    const { recovered, counts } = await recovery();
    assert.equal(recovered.length, 1);
    const listing = recovered[0];
    assert.equal(listing.match, undefined);
    assert.equal(listing.screen.priceAnomaly.photoChecked, true);
    assert.equal(listing.mistakes.length, 0, "an honest low price need not be a title mistake");
    assert.equal(canAutoAnalyze(listing), true);
    assert.equal(resultGroup(listing, null), "candidates", "preliminary checks never manufacture a Deal");
    assert.equal(counts.searches, 0);
    assert.equal(counts.photo, 1);
    assert.equal(counts.mismatchCheck, 1);
    assert.equal(counts.details, 1);
});

test("uncertain, stock, multiple-card and different-identity discovery readings trigger no comps or details", async () => {
    for (const inspection of [
        { ...photo, isStockImage: true }, { ...photo, cardCount: 2 },
        { ...photo, card: { ...photo.card, confidence: "LOW" } },
        { ...photo, card: { ...photo.card, name: "Charizard", cardNumber: "4/102" } },
    ]) {
        const { recovered, counts } = await recovery({ inspection });
        assert.equal(recovered.length, 0);
        assert.equal(counts.details, 0);
        assert.equal(counts.comps, 0);
        assert.equal(counts.mismatchCheck, 0);
    }
});

test("mismatch or inconclusive independent checks stop before comp and eBay detail work", async () => {
    for (const verdict of ["MISMATCH", "CANT_TELL", null]) {
        const { recovered, counts } = await recovery({ verdict });
        assert.equal(counts.details, 0);
        assert.equal(counts.comps, 0);
        assert.equal(counts.mismatchCheck, 1);
        assert.ok(recovered.every((value) => canAutoAnalyze(value) === (verdict !== "MISMATCH")));
        if (verdict === "MISMATCH") assert.equal(recovered[0].match, "OTHER_CARD");
    }
});

test("cancelling recovery starts no mismatch checks, comps or detail requests", async () => {
    const { recovered, counts } = await recovery({ abortPhoto: true });
    assert.equal(recovered.length, 0);
    assert.equal(counts.mismatchCheck, 0);
    assert.equal(counts.details, 0);
    assert.equal(counts.comps, 0);
});

test("very cheap slabs are eligible for the same bounded preliminary verification", async () => {
    const { counts } = await recovery({ graded: true, verdict: "CANT_TELL" });
    assert.equal(counts.photo, 1);
    assert.equal(counts.mismatchCheck, 1);
    assert.equal(counts.details, 0);
    const confirmed = await recovery({ graded: true });
    assert.equal(canAutoAnalyze(confirmed.recovered[0]), true);
    assert.equal(confirmed.counts.photo, 1);
    assert.equal(confirmed.counts.mismatchCheck, 1);
    assert.equal(confirmed.counts.details, 1);
});

test("a flood of cheap listings shares at most a quarter of the existing discovery photo ceiling", async () => {
    const checked = [];
    let planned = 0;
    const pending = { status: "UNSCREENED", priceAnomaly: { referencePrice: 80, photoChecked: false } };
    await digDeeper("Mewtwo Base Set", { intent, primaryListings: Array.from({ length: 400 }, (_, i) => listing(`cheap-${i}`, { screen: pending, images: [`cheap-${i}`] })), onStart: (value) => { planned = value.total; } }, {
        plan: async () => [{ query: "other", how: "PHOTO_SHOWS_IT" }], readIntent: async () => intent,
        search: async () => ({ listings: Array.from({ length: 200 }, (_, i) => listing(`other-${i}`, { images: [`other-${i}`] })), total: 200, skipped: 0 }),
        findPhoto: async (url) => { checked.push(url); return { found: "YES", cardCount: 1, set: "Base Set", cardNumber: "10/102", shows: "Mewtwo", inspection: photo }; },
        screening: () => ({
            readTitle: async () => ({ aspects, filled: [], kind: "SINGLE_CARD" }),
            check: async () => ({ status: "CANDIDATE", card: { name: "Mewtwo", set: "Base Set", cardNumber: "10/102", printing: "UNLIMITED", printingLabel: "Unlimited" }, priceAnomaly: { referencePrice: 80, photoChecked: true } }),
            matchPhoto: async () => ({ verdict: "MATCH", problems: [] }),
            loadDetails: async () => ({ title: listing().title, aspects, images: ["front", "back"], shipping: 0, cardCondition: "Heavily played (Poor)", conditionNotes: [] }),
        }),
    });
    assert.equal(checked.filter((url) => url.startsWith("cheap-")).length, Math.ceil(planned / 4));
    assert.ok(checked.some((url) => url.startsWith("cheap-")));
    assert.ok(checked.some((url) => url.startsWith("other-")));
    assert.ok(checked.length <= 120);
    assert.equal(checked.length, planned, "useful hits exercise the full budget rather than the early empty-scan stop");
    assert.equal(new Set(checked).size, checked.length);
});
