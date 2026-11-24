import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalysisState } from "../../client/src/analysis-state.ts";
import { artworkCounterpart, binderFind, cheaperArtwork, collectorCopies, refreshedCollectorQuote } from "../../client/src/search/collector-finds.ts";
import type { RawCondition } from "../../shared/conditions.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import type { ListingSummary } from "../../shared/types.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

const now = Date.parse("2026-11-24T00:00:00Z");

function copy(id: string, price: number, condition: RawCondition, back: "CLEAN" | "WORN", set = "Base Set", number = "15/102") {
    const value = cardEvaluation();
    const listing: ListingSummary = {
        id, title: `Venusaur ${set} ${number} Holo English`, currentPrice: price, shipping: 5,
        url: `https://www.ebay.com/itm/${id}`, images: [`https://i.ebayimg.com/${id}/front.jpg`, `https://i.ebayimg.com/${id}/back.jpg`],
        availability: "ACTIVE", buyingOption: "FIXED_PRICE", bids: 0, isGraded: false, endTime: null, seller: null,
    };
    Object.assign(value.listing, listing, { price, photos: listing.images, termsCheckedAt: new Date(now).toISOString(),
        photosInListing: 2, photosAnalyzed: 2, conditionNotes: [] });
    Object.assign(value.identity!, { set, cardNumber: number });
    Object.assign(value.photoCheck!, {
        cardCount: "ONE", cardIdentity: { name: "Venusaur", set, cardNumber: number, finish: "HOLO", language: "English",
            confidence: "HIGH", evidence: ["The printed name, set and number are visible."] },
        images: ["FRONT", "BACK"].map((view, index) => ({
            number: index + 1, view, usable: true, isStockImage: false, obscuresCondition: false, issues: [],
        })),
    });
    Object.assign(value.condition!, {
        rawCondition: condition, binderAppearance: { front: "CLEAN", back, frontEvidence: "Face and border visible and clean.",
            backEvidence: back === "CLEAN" ? "Clear blue back with intact edges." : "Whitening along bottom right blue edge." },
    });
    value.underwriting = null;
    value.rawPricing = null;
    value.gradedPricing = null;
    const state: AnalysisState = { status: "done", evidenceKey: id, pricingExpired: true, evaluation: value };
    return { listing, state, value };
}

type Fixture = ReturnType<typeof copy>;

function checked(...fixtures: Fixture[]) {
    return collectorCopies(fixtures.map(fixture => fixture.listing),
        Object.fromEntries(fixtures.map(fixture => [fixture.listing.id, fixture.state])), null, now);
}

test("binder buyer sees the known back defect and actual saving over the cheapest cleaner printing", () => {
    const binder = copy("111111111111", 40, "LIGHTLY_PLAYED", "WORN");
    const nearMint = copy("222222222222", 65, "NEAR_MINT", "CLEAN");
    const otherSet = copy("333333333333", 30, "NEAR_MINT", "CLEAN", "Base Set 2", "18/130");
    const picked = binderFind(checked(nearMint, otherSet, binder));
    assert.equal(picked?.candidate.id, binder.listing.id);
    assert.equal(picked?.cleaner.id, nearMint.listing.id);
    assert.equal(picked?.saving, 27.07);
    assert.equal(picked?.candidate.back, binder.listing.images[1]);
    const cheaperClean = copy("444444444444", 35, "NEAR_MINT", "CLEAN");
    assert.equal(binderFind(checked(nearMint, cheaperClean, binder)), null);
});

test("binder selection rejects missing side evidence, expired terms, and unavailable or wrong versions", () => {
    const base = copy("111111111111", 40, "LIGHTLY_PLAYED", "WORN");
    const cleaner = copy("222222222222", 65, "NEAR_MINT", "CLEAN");
    const cases: [string, (fixture: Fixture) => void][] = [
        ["legacy report", fixture => { delete fixture.value.condition!.binderAppearance; }],
        ["unclear front", fixture => { fixture.value.condition!.binderAppearance!.front = "UNCLEAR"; }],
        ["obscured front photo", fixture => { fixture.value.photoCheck!.images[0].obscuresCondition = true; }],
        ["possible crease", fixture => { fixture.value.condition!.creases = "SUSPECTED"; }],
        ["unknown shipping", fixture => { fixture.value.listing.shipping = null; }],
        ["expired quote", fixture => { fixture.value.listing.termsCheckedAt = new Date(now - BEST_BUY_TERMS_MAX_AGE_MS).toISOString(); }],
        ["ended", fixture => { fixture.listing.availability = "UNAVAILABLE"; }],
        ["changed photo", fixture => { fixture.listing.images = ["https://i.ebayimg.com/replaced.jpg"]; }],
        ["wrong photographed card", fixture => { fixture.value.photoCheck!.cardIdentity!.cardNumber = "18/130"; }],
        ["different printing", fixture => { fixture.value.identity!.printing = "FIRST_EDITION"; }],
        ["foreign language", fixture => { fixture.value.identity!.language = "Japanese"; }],
    ];
    for (const [reason, change] of cases) {
        const fixture = structuredClone(base);
        change(fixture);
        assert.equal(binderFind(checked(fixture, cleaner)), null, reason);
    }
});

test("same-art comparison confirms both releases, fresh totals and comparable or better condition", () => {
    const original = copy("111111111111", 40, "LIGHTLY_PLAYED", "WORN");
    const other = copy("222222222222", 20, "NEAR_MINT", "CLEAN", "Base Set 2", "018/130");
    const worse = copy("333333333333", 5, "HEAVILY_PLAYED", "WORN", "Base Set 2", "18/130");
    const [anchor] = checked(original);
    assert.deepEqual(artworkCounterpart(anchor.identity), { name: "Venusaur", set: "Base Set 2", number: "18/130" });
    assert.equal(cheaperArtwork(anchor, checked(worse, original, other), now)?.id, other.listing.id);
    assert.equal(cheaperArtwork(anchor, checked(worse), now), null);
    assert.equal(cheaperArtwork(anchor, checked(other), now + BEST_BUY_TERMS_MAX_AGE_MS), null);
    assert.equal(artworkCounterpart({ ...anchor.identity, cardNumber: "15/130" }), null);
    assert.equal(artworkCounterpart({ ...anchor.identity, name: "Machamp" }), null);
    assert.equal(artworkCounterpart({ ...anchor.identity, finish: "REVERSE_HOLO" }), null);
});

test("alternate search can update the original price from fresh eBay terms without new photo analysis", () => {
    const fixture = copy("111111111111", 40, "LIGHTLY_PLAYED", "WORN");
    const [original] = checked(fixture);
    const quoteTime = now + BEST_BUY_TERMS_MAX_AGE_MS;
    const quote = { ...fixture.listing, cardCondition: fixture.value.listing.cardCondition, currentPrice: 38, shipping: 4, termsCheckedAt: new Date(quoteTime).toISOString() };
    const refreshed = refreshedCollectorQuote(original, quote, quoteTime);
    assert.equal(refreshed?.total, 45.47);
    assert.equal(refreshed?.checkedAt, quote.termsCheckedAt);
    assert.equal(refreshedCollectorQuote(original, { ...quote, shipping: null }, quoteTime), null);
    assert.equal(refreshedCollectorQuote(original, { ...quote, id: "222222222222" }, quoteTime), null);
    assert.equal(refreshedCollectorQuote(original, { ...quote, images: [...quote.images, "new.jpg"] }, quoteTime), null);
    assert.equal(refreshedCollectorQuote(original, { ...quote, conditionNotes: ["Card has a crease"] }, quoteTime), null);
    assert.equal(refreshedCollectorQuote(original, { ...quote, availability: "UNKNOWN" }, quoteTime), null);
    assert.equal(refreshedCollectorQuote(original, quote, quoteTime + BEST_BUY_TERMS_MAX_AGE_MS), null);
});
