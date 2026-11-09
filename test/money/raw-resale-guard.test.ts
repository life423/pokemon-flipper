import { test } from "node:test";
import assert from "node:assert/strict";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";
import { resultGroup } from "../../shared/analysis.ts";
import { photoReviewStatus } from "../../shared/photo-review.ts";
import type { ListingSummary } from "../../shared/types.ts";

function suspectedCopy(grading = false) {
    const e = cardEvaluation();
    e.listing.price = 25; e.listing.shipping = 4; e.listing.buyingOption = "FIXED_PRICE";
    e.condition!.creases = "SUSPECTED";
    e.photoCheck!.cardCount = "ONE";
    e.photoCheck!.cardIdentity = { name: e.identity!.name, set: e.identity!.set, cardNumber: e.identity!.cardNumber, language: "English",
        finish: "HOLO", confidence: "HIGH", evidence: ["Readable name and collector number."] };
    e.rawPricing = grading ? null : { status: "PRICED", prices: [{ condition: "LIGHTLY_PLAYED", price: 150, basis: "EBAY_SOLD",
        comps: salesSummary("RAW", "LIGHTLY_PLAYED", [150, 150, 150]) }] };
    if (!grading) e.gradedPricing = {};
    return e;
}
const listingSummary = (e: ReturnType<typeof cardEvaluation>): ListingSummary => ({ ...e.listing, currentPrice: e.listing.price, isGraded: false, images: [] });

test("a suspected crease holds profitable raw and grading advice through local target changes without rewriting observations", t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("condition decisions and retargeting must stay offline"));
    for (const grading of [false, true]) {
        const original = suspectedCopy(grading), condition = structuredClone(original.condition);
        for (const targets of [MONEY_CONFIG.targets, { minProfit: 0, minRoi: 0 }]) for (const priceDeferred of [false, true]) {
            if (priceDeferred) original.pricingDeferred = { provider: "PKMNPRICES", note: "An alternative route's prices are deferred." };
            else delete original.pricingDeferred;
            const result = retargetEvaluation(original, targets);
            assert.equal(result.underwriting!.verdict, "NEEDS_REVIEW");
            assert.equal(result.underwriting!.best!.path, grading ? "GRADE" : "RAW");
            assert.ok(result.underwriting!.best!.profit > 0, "the original money scenario remains inspectable");
            assert.match(result.underwriting!.reasons.join(" "), /possible crease.*before buying/i);
            assert.equal(result.condition, original.condition);
            assert.deepEqual(result.condition, condition, "suspected damage must not become a Damaged bucket or a new grade");
            assert.equal(result.rating, null);
            assert.equal(resultGroup(listingSummary(result), result), "review");
            assert.equal(photoReviewStatus(result).needsYourReview, true);
        }
    }
});

test("a suspected crease leaves priced rejections finished until changed targets would make buying actionable", () => {
    const original = suspectedCopy();
    const strict = retargetEvaluation(original, { minProfit: 1000, minRoi: 0 });
    assert.equal(strict.underwriting!.verdict, "PASS");
    assert.ok(strict.underwriting!.best!.profit > 0, "a positive route below the user's targets is still a finished rejection");
    assert.equal(resultGroup(listingSummary(strict), strict), null);
    assert.equal(photoReviewStatus(strict).needsYourReview, false);
    assert.equal(retargetEvaluation(strict, { minProfit: 0, minRoi: 0 }).underwriting!.verdict, "NEEDS_REVIEW");
    original.listing.price = 200;
    const loss = retargetEvaluation(original, { minProfit: 0, minRoi: 0 });
    assert.equal(loss.underwriting!.verdict, "PASS");
    assert.ok(loss.underwriting!.best!.profit < 0);
    assert.equal(resultGroup(listingSummary(loss), loss), null);
    assert.equal(photoReviewStatus(loss).needsYourReview, false);
    assert.equal(loss.condition!.creases, "SUSPECTED");
});
