import { test } from "node:test";
import assert from "node:assert/strict";
import { resultGroup } from "../../shared/analysis.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import type { ListingSummary } from "../../shared/types.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";

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
    evaluation.rawPricing = null;
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

test("unknown Buy It Now shipping keeps positive raw and slab estimates in Sorting until a quote is available", () => {
    const targets = { minProfit: 0, minRoi: 0 };
    for (const slab of [false, true]) {
        const value = cardEvaluation(targets);
        Object.assign(value.listing, { buyingOption: "FIXED_PRICE", availability: "ACTIVE", termsCheckedAt: new Date().toISOString(), endTime: null, shipping: 0 });
        if (slab) {
            value.condition = null;
            value.photoCheck!.holder = "GRADED_SLAB";
            value.slab = { status: "OK", grader: "PSA", grade: "7", reasons: [], concerns: [] };
            value.slabPricing = { status: "PRICED", summary: salesSummary() };
        }
        const listing: ListingSummary = { ...value.listing, currentPrice: value.listing.price, images: [], isGraded: slab };
        const quoted = retargetEvaluation(value, targets);
        assert.equal(resultGroup(listing, quoted), "deals", "an explicit zero is a verified shipping quote");
        const missing = { ...listing, shipping: null, termsCheckedAt: new Date().toISOString() };
        const provisional = retargetEvaluation(quoted, targets, missing);
        assert.equal(provisional.underwriting?.verdict, "CANT_PRICE");
        assert.equal(provisional.underwriting?.shippingUnconfirmed, true);
        assert.ok(provisional.underwriting?.best && provisional.underwriting.best.profit > 0);
        assert.match(provisional.underwriting.reasons[0], /Confirm the delivered price/);
        assert.equal(provisional.rating, null);
        assert.equal(resultGroup(missing, provisional, true), "candidates");
        assert.equal(resultGroup(missing, { ...quoted, listing: provisional.listing }, true), "candidates", "a saved BUY also requires a quote");
        const refreshed = { ...listing, termsCheckedAt: new Date(Date.parse(missing.termsCheckedAt) + 1).toISOString() };
        assert.equal(resultGroup(refreshed, retargetEvaluation(provisional, targets, refreshed), true, false, Date.parse(refreshed.termsCheckedAt)), "deals");
    }
});
