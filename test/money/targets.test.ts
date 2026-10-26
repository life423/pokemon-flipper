import { test } from "node:test";
import assert from "node:assert/strict";
import { retargetEvaluation, retargetScreen } from "../../shared/money/targets.ts";

// A PSA 9 Lugia slab listed at $1,500, with sold comps at a $2,600 median.
const slabEvaluation = () => ({
    listing: { price: 1500, shipping: 5, buyingOption: "FIXED_PRICE", seller: null, cardCondition: null },
    identity: { status: "IDENTIFIED", set: "Neo Genesis", cardNumber: "009/111", printing: "UNLIMITED", reasons: [] },
    condition: null,
    slab: { status: "OK", grader: "PSA", grade: "9", reasons: [], concerns: [] },
    slabPricing: {
        status: "PRICED",
        summary: { grader: "PSA", grade: "9", count: 5, median: 2600, low: 2325, high: 3350, confidence: "HIGH", dropped: {}, sales: [] },
    },
    underwriting: null,
    rating: null,
});

test("an analyzed deal is re-priced for new targets", () => {
    const easy = retargetEvaluation(slabEvaluation(), { minProfit: 50, minRoi: 0.25 });
    const strict = retargetEvaluation(slabEvaluation(), { minProfit: 1000, minRoi: 0.25 });

    assert.equal(easy.underwriting.verdict, "BUY_GRADED");
    assert.equal(strict.underwriting.verdict, "PASS");
    assert.ok(strict.underwriting.best.maxBid < easy.underwriting.best.maxBid);
    assert.equal(strict.rating, null);
});

test("a free check is re-sorted for new targets from the paths it priced", () => {
    const screen = {
        status: "CANDIDATE",
        reason: null,
        card: null,
        bestCase: null,
        assumed: "Near Mint, grading 9 at best",
        money: {
            shipping: 5,
            paths: [
                { label: "Resell raw", expectedNet: 450, fixedCosts: 0 },
                { label: "Grade with PSA", expectedNet: 2217.54, fixedCosts: 364 },
            ],
        },
    };

    const easy = retargetScreen(screen, 900, { minProfit: 50, minRoi: 0.25 });
    const strict = retargetScreen(screen, 900, { minProfit: 50, minRoi: 1 });

    assert.equal(easy.status, "CANDIDATE");
    assert.equal(easy.bestCase.label, "Grade with PSA");
    assert.equal(strict.status, "DROPPED");
    assert.ok(strict.bestCase.maxBid < 900);
});

test("a free check that couldn't be priced stays as it is", () => {
    const screen = { status: "UNSCREENED", reason: "Only English cards are supported so far.", card: null, bestCase: null, assumed: null };

    assert.equal(retargetScreen(screen, 100, { minProfit: 0, minRoi: 0 }), screen);
});

test("with any profit and any return, the max bid is break-even, never a loss", () => {
    const any = retargetEvaluation(slabEvaluation(), { minProfit: 0, minRoi: 0 });
    const best = any.underwriting.best;

    assert.equal(any.underwriting.verdict, "BUY_GRADED");
    assert.ok(best.profitAtMaxBid >= 0);
    assert.ok(best.profitAtMaxBid < 2);
});

test("a repeat search uses the latest price and shipping while preserving the saved assessment", () => {
    const saved = slabEvaluation();
    const targets = { minProfit: 50, minRoi: 0.25 };
    const current = { currentPrice: 2300, shipping: 15, bids: 4, endTime: "2026-12-01T00:00:00Z", buyingOption: "AUCTION", seller: null };
    const result = retargetEvaluation(saved, targets, current);

    assert.equal(retargetEvaluation(saved, targets).underwriting.verdict, "BUY_GRADED");
    assert.equal(result.underwriting.verdict, "PASS");
    assert.equal(result.listing.price, 2300);
    assert.equal(result.listing.shipping, 15);
    assert.equal(result.listing.bids, 4);
    assert.equal(result.listing.endTime, current.endTime);
    assert.equal(result.listing.buyingOption, "AUCTION");
    assert.equal(result.slabPricing, saved.slabPricing);
    assert.equal(saved.listing.price, 1500);
    assert.equal(saved.listing.shipping, 5);

    const unknown = retargetEvaluation(saved, targets, { ...current, currentPrice: null, shipping: null });
    assert.equal(unknown.underwriting.verdict, "CANT_PRICE");
    assert.equal(unknown.listing.shipping, saved.listing.shipping);
    assert.equal(unknown.rating, null);
});
