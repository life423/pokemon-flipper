import { test } from "node:test";
import assert from "node:assert/strict";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";
import { jungleNoSymbolReason } from "../../shared/jungle-no-symbol.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { rateDeal } from "../../shared/money/rating.ts";
import { priceEvidenceGap } from "../../shared/money/price-evidence.ts";
import { resultGroup } from "../../shared/analysis.ts";
import { isResearchDeferred, photoReviewStatus } from "../../shared/photo-review.ts";
import type { Evaluation, ListingSummary } from "../../shared/types.ts";

const any = { minProfit: 0, minRoi: 0 };
function jungleSlab(): Evaluation {
    const value = cardEvaluation(any);
    value.listing.title = "Jolteon Jungle 4/64 Unlimited Holo PSA 8";
    value.listing.price = 50; value.listing.shipping = 0; value.listing.buyingOption = "FIXED_PRICE";
    value.identity = { ...value.identity!, name: "Jolteon", set: "Jungle", cardNumber: "4/64" };
    value.condition = null; value.rawPricing = null; value.gradedPricing = null;
    value.photoCheck!.holder = "GRADED_SLAB";
    value.slab = { status: "OK", grader: "PSA", grade: "8", gradeQualifier: null, certNumber: "12345678", certUrl: null,
        labelText: "1999 POKEMON JUNGLE JOLTEON-HOLO #4 NM-MT 8", caseCondition: "INTACT", reasons: [], concerns: [] };
    value.slabPricing = { status: "PRICED", summary: { ...salesSummary("PSA", "8", [136.5]), confidence: "LOW", median: 136.5 } };
    return retargetEvaluation(value, any);
}
function summary(value: Evaluation): ListingSummary {
    return { ...value.listing, currentPrice: value.listing.price, isGraded: !!value.slab, images: ["front", "back"], bestOffer: true };
}

test("Jungle No Symbol title claims and accepted label/printing evidence each defer ordinary prices without another photo review", t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("variant decisions must remain offline"));
    for (const source of ["title", "label", "printing"] as const) {
        const original = jungleSlab();
        assert.equal(original.underwriting!.verdict, "BUY_GRADED");
        if (source === "title") original.listing.title += " No Symbol";
        if (source === "label") original.slab!.labelText += " NO SYMBOL";
        if (source === "printing") original.photoCheck!.printingMarks = { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT",
            reprintMark: "No visible reprint mark; label explicitly reads NO SYMBOL.", evidence: ["The card and label visibly indicate the Jungle no-symbol printing."] };
        const unchanged = structuredClone(original);
        assert.ok(priceEvidenceGap(original), "old saved BUY advice is gated before retargeting");
        assert.equal(rateDeal(original), null);
        assert.equal(resultGroup(summary(original), original, true), "candidates");
        assert.equal(underwrite(original).verdict, "CANT_PRICE", "ordinary prices cannot price this variant in any caller");
        for (const price of [50, 500]) for (const targets of [any, { minProfit: 50, minRoi: 0.25 }]) {
            const result = retargetEvaluation(original, targets, { ...summary(original), currentPrice: price });
            assert.equal(result.underwriting!.verdict, "CANT_PRICE");
            assert.equal(result.underwriting!.best, null);
            assert.deepEqual(result.underwriting!.paths, []);
            assert.equal(result.slabPricing!.status, "PRICE_UNAVAILABLE");
            assert.equal(result.slabPricing!.summary, undefined, "ordinary sales cannot appear as matched variant evidence");
            assert.match(result.underwriting!.reasons.join(" "), /Jungle No Symbol.*ordinary Jungle/);
            assert.equal(result.slab!.status, "OK", "accepted slab evidence is unchanged");
            assert.equal(result.slab, original.slab);
            assert.equal(result.photoCheck, original.photoCheck);
            assert.equal(result.rating, null);
            assert.equal(photoReviewStatus(result).needsYourReview, false);
            assert.equal(isResearchDeferred(result), true);
            assert.equal(resultGroup(summary(result), result, true), "candidates");
        }
        assert.deepEqual(original, unchanged, "accepted provider/photos and original saved prices remain intact");
    }
});

test("stale ordinary Jungle PASS advice and raw grading routes cannot complete a No Symbol price rejection", () => {
    const expensive = jungleSlab(); expensive.listing.price = 500;
    const old = retargetEvaluation(expensive, any);
    assert.equal(old.underwriting!.verdict, "PASS");
    old.listing.title += " NO-SYMBOL ERROR";
    assert.equal(resultGroup(summary(old), old, true), "candidates");
    assert.equal(retargetEvaluation(old, any).underwriting!.verdict, "CANT_PRICE");
    const raw = cardEvaluation(any);
    raw.listing.title = "Jolteon Jungle 4/64 NoSymbol Holo";
    raw.identity = { ...raw.identity!, set: "Jungle", name: "Jolteon", cardNumber: "4/64" };
    const result = retargetEvaluation(raw, any);
    assert.equal(result.underwriting!.verdict, "CANT_PRICE");
    assert.equal(result.rawPricing!.status, "PRICE_UNAVAILABLE");
    assert.equal(result.gradedPricing!.PSA!.status, "PRICE_UNAVAILABLE");
    assert.equal(result.gradedPricing!.CGC!.status, "PRICE_UNAVAILABLE");
    assert.equal(resultGroup(summary(result), result), "candidates");
});

test("ordinary Jungle, missing edition stamps and Base Set's normal missing set symbol keep their existing scope", () => {
    for (const title of ["Jolteon Jungle 4/64 Holo PSA 8", "Jolteon Jungle 4/64 Holo PSA 8 No First Edition symbol",
        "Jolteon Jungle 4/64 Holo PSA 8 without a 1st Edition stamp", "Jolteon Jungle 4/64 Holo PSA 8 not a No Symbol variant"]) {
        const value = jungleSlab(); value.listing.title = title;
        assert.equal(jungleNoSymbolReason(value), null, title);
        assert.equal(retargetEvaluation(value, any).underwriting!.verdict, "BUY_GRADED", title);
    }
    const base = jungleSlab();
    base.listing.title = "Venusaur Base Set 15/102 Holo PSA 8 no symbol";
    base.identity!.set = "Base Set";
    assert.equal(jungleNoSymbolReason(base), null, "the identified set takes precedence over stray Jungle wording in a label");
    assert.equal(retargetEvaluation(base, any).underwriting!.verdict, "BUY_GRADED");
});

test("No Symbol cannot override an ended listing or an actual fake/slab concern", () => {
    const ended = jungleSlab(); ended.listing.title += " No Symbol"; ended.listing.availability = "UNAVAILABLE";
    const unavailable = retargetEvaluation(ended, any);
    assert.equal(unavailable.underwriting!.verdict, "PASS");
    assert.equal(priceEvidenceGap(unavailable), null);
    assert.equal(resultGroup(summary(unavailable), unavailable), null);
    const fake = cardEvaluation(any); fake.identity!.set = "Jungle"; fake.listing.title = "Jolteon Jungle No Symbol";
    fake.condition!.authenticity.concern = "LIKELY_FAKE";
    assert.equal(retargetEvaluation(fake, any).underwriting!.verdict, "PASS");
    const risky = jungleSlab(); risky.listing.title += " No Symbol"; risky.slab!.status = "NEEDS_REVIEW";
    risky.slab!.concerns = ["The slab label and card identity conflict."];
    const result = retargetEvaluation(risky, any);
    assert.equal(result.underwriting!.verdict, "NEEDS_REVIEW");
    assert.equal(resultGroup(summary(result), result), "review");
});
