import { test } from "node:test";
import assert from "node:assert/strict";
import { resultGroup } from "../../shared/analysis.ts";
import type { ListingSummary } from "../../shared/types.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

test("incomplete screening and failed analyses stay visible in Review without becoming Deals", () => {
    const evaluation = cardEvaluation();
    const listing: ListingSummary = {
        id: evaluation.listing.id, title: evaluation.listing.title, url: evaluation.listing.url,
        currentPrice: 30, shipping: 0, bids: 0, buyingOption: "FIXED_PRICE", endTime: null,
        images: [], seller: null, isGraded: false,
        screen: { status: "UNSCREENED", reason: "Price lookup failed", card: null, bestCase: null, assumed: null },
    };
    assert.equal(resultGroup(listing, null, true), "review");
    const candidate: ListingSummary = { ...listing, screen: { ...listing.screen!, status: "CANDIDATE" } };
    assert.equal(resultGroup(candidate, null), "candidates");
    assert.equal(resultGroup(candidate, null, true, true), "review");
    assert.equal(resultGroup({ ...listing, screen: { ...listing.screen!, status: "DROPPED" } }, null), null);
    evaluation.underwriting = { verdict: "CANT_PRICE", reasons: [], best: null, paths: [], assumptions: [] };
    assert.equal(resultGroup(candidate, evaluation), "review");
    evaluation.underwriting.verdict = "PASS";
    assert.equal(resultGroup(candidate, evaluation, false, true), null, "a completed assessment supersedes an earlier failed attempt");
});

test("a completed financial rejection remains terminal even when a deferred photo snapshot has review notes", () => {
    const value = cardEvaluation();
    const listing = { ...value.listing, currentPrice: value.listing.price, images: [], isGraded: false, bestOffer: true };
    value.researchMode = "DEFERRED_LOW_RESALE";
    value.photoCheck!.missingViews = ["BACK"];
    value.underwriting = { verdict: "PASS", reasons: ["Resale loses money at asking."], best: null, paths: [], assumptions: [] };
    assert.equal(resultGroup(listing, value, true), null);
});

test("resolved seller-metadata mismatches stay in Sorting while deferred prices preserve real identity holds", () => {
    const value = cardEvaluation();
    const listing = { ...value.listing, currentPrice: value.listing.price, images: [], isGraded: false };
    value.pricingDeferred = { provider: "PKMNPRICES", note: "Matching sold prices are deferred." };
    value.rawPricing = null; value.gradedPricing = null;
    value.underwriting = { verdict: "CANT_PRICE", reasons: [value.pricingDeferred.note], best: null, paths: [], assumptions: [] };
    value.photoCheck!.cardCount = "ONE";
    value.photoCheck!.cardIdentity = { name: value.identity!.name, set: value.identity!.set, cardNumber: value.identity!.cardNumber,
        language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["The visible name, set and collector fraction agree."] };
    value.photoCheck!.cardMatch = { verdict: "MISMATCH", problems: ["The seller-entered number and finish differ from the readable card and title."] };
    const original = structuredClone(value);
    assert.equal(resultGroup(listing, value), "candidates", "a final identified card needs prices, not another identity review");
    assert.deepEqual(value, original, "grouping preserves the original paid photo report");
    for (const change of [
        copy => { copy.identity!.notThisCard = "The photos establish a different release."; },
        copy => { copy.identity!.status = "NEEDS_REVIEW"; copy.identity!.reasons = ["The set remains uncertain."]; },
        copy => { copy.identity!.status = "NEEDS_REVIEW"; copy.pricingDeferred!.identityLookupPending = true; },
        copy => { copy.identity = null; },
    ]) {
        const copy = structuredClone(value); change(copy);
        assert.equal(resultGroup(listing, copy), "review", "unresolved or disproved identities must retain their review hold");
    }
});
