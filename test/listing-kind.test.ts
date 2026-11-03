import { test } from "node:test";
import assert from "node:assert/strict";
import { observedCardKind } from "../shared/photo-evidence.ts";
import { matchesListingFilters } from "../shared/listing-filters.ts";
import { evaluatedCriteriaMismatch } from "../shared/search-criteria.ts";
import { cardEvaluation } from "./fixtures/card-evaluation.ts";
import type { ListingSummary } from "../shared/types.ts";

function subject() {
    const evaluation = cardEvaluation();
    evaluation.photoCheck!.cardCount = "ONE";
    evaluation.listing.photos = ["https://i.ebayimg.com/images/g/offline/s-l1600.jpg", "https://i.ebayimg.com/images/g/offline-back/s-l1600.jpg"];
    const listing: ListingSummary = { id: evaluation.listing.id, title: evaluation.listing.title, isGraded: false,
        images: evaluation.listing.photos, currentPrice: 50, shipping: 0, buyingOption: "FIXED_PRICE", bids: 0, endTime: null,
        url: "#", seller: null };
    evaluation.photoCheck!.holder = "GRADED_SLAB";
    evaluation.photoCheck!.slab = { present: true, grader: null, grade: null, certNumber: null, labelText: null,
        gradeQualifier: null, caseCondition: "INTACT", authenticity: "NONE_SEEN", concerns: [] };
    return { listing, evaluation };
}

test("unreadable labels establish holder kind while unknown, contradictory or stock-only evidence stays unresolved", () => {
    const { evaluation } = subject();
    assert.equal(observedCardKind(evaluation), "graded");
    for (const holder of ["UNKNOWN", "OTHER", "NONE", "TOPLOADER"]) {
        evaluation.photoCheck!.holder = holder;
        assert.equal(observedCardKind(evaluation), null, "present slab and a contrary holder cannot prove raw");
    }
    evaluation.photoCheck!.holder = "GRADED_SLAB";
    evaluation.photoCheck!.images.forEach(photo => { photo.isStockImage = true; });
    assert.equal(observedCardKind(evaluation), null);
    evaluation.photoCheck!.images.forEach(photo => { photo.isStockImage = false; });
    for (const count of ["MULTIPLE", "UNKNOWN"]) {
        evaluation.photoCheck!.cardCount = count;
        assert.equal(observedCardKind(evaluation), null);
    }
    assert.equal(observedCardKind(null), null);
    const malformed = subject().evaluation;
    Reflect.deleteProperty(malformed.photoCheck!, "images");
    assert.equal(observedCardKind(malformed), null, "an incomplete saved photo record cannot prove a holder kind or crash filtering");
});

test("cached holder evidence matches current photo content independently of bids, prices and expired valuation", t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("filtering must not re-fetch photos or buy assessments"));
    const { listing, evaluation } = subject();
    evaluation.pricesCheckedAt = "2020-01-01T00:00:00Z";
    evaluation.answeredAt = "2020-01-01T00:00:00Z";
    evaluation.underwriting = null;
    const thumbnail = { ...listing, currentPrice: 175, bids: 12,
        images: [listing.images[0].replace("s-l1600", "s-l225")] };
    assert.equal(matchesListingFilters(thumbnail, { kindFilter: "raw" }, evaluation), false);
    assert.equal(matchesListingFilters(thumbnail, { kindFilter: "graded" }, evaluation), true);
    assert.equal(matchesListingFilters(thumbnail, { kindFilter: "all" }, evaluation, false), false, "raw query cannot queue a known slab when Both is selected");
    assert.equal(matchesListingFilters(thumbnail, { kindFilter: "raw" }, evaluation, true), false, "conflicting query/control constraints do not open a paid route");
    for (const changed of [{ ...listing, id: "another-copy" }, { ...listing, title: "Changed seller title" },
        { ...listing, images: ["https://i.ebayimg.com/images/g/replaced/s-l1600.jpg"] }]) {
        assert.equal(matchesListingFilters(changed, { kindFilter: "raw" }, evaluation), true, "old holder evidence must not override changed metadata/photos");
        assert.equal(matchesListingFilters(changed, { kindFilter: "graded" }, evaluation), false);
    }
});

test("bare raw/graded search words require the observed kind, not merely a matching numeric grade", () => {
    const { evaluation } = subject();
    const intent = { cardName: "Venusaur", cardNumber: "15/102", sets: ["Base Set"], printing: null,
        finish: "HOLO" as const, titleWords: ["venusaur"], source: "rules", graded: false };
    assert.equal(evaluatedCriteriaMismatch(evaluation, intent), true);
    assert.equal(evaluatedCriteriaMismatch(evaluation, { ...intent, graded: true }), false);
    evaluation.photoCheck!.holder = "SLEEVE"; evaluation.photoCheck!.slab = null;
    assert.equal(evaluatedCriteriaMismatch(evaluation, intent), false);
    assert.equal(evaluatedCriteriaMismatch(evaluation, { ...intent, graded: true }), true);
});
