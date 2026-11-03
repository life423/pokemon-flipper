import { test } from "node:test";
import assert from "node:assert/strict";
import { retargetScreen } from "../../shared/money/targets.ts";
import { netFromSale } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { canAutoAnalyze, resultGroup } from "../../shared/analysis.ts";
import type { ListingSummary, Screen, ScreeningSoldEvidence } from "../../shared/types.ts";

function soldEvidence(graded: boolean): ScreeningSoldEvidence {
    return { status: "AVAILABLE", exactScope: true, note: "A matched recent sold sample.", references: [{
        recordId: 123, name: "Charizard", set: "Base Set", cardNumber: "4/102", printing: "UNLIMITED", finish: "HOLO",
        grader: graded ? "PSA" : null, grade: graded ? "8" : null, condition: graded ? null : "NEAR_MINT",
        summary: { grader: graded ? "PSA" : "RAW", grade: graded ? "8" : "NEAR_MINT", count: 3, median: 150, mean: 150,
            low: 130, high: 170, windowDays: 90, newestSale: "2026-11-03T00:00:00Z", confidence: "MEDIUM", dropped: {},
            sales: [130, 150, 170].map(price => ({ price, soldAt: "2026-11-03T00:00:00Z", title: "Charizard Base Set 4/102", url: null })) },
    }] };
}
function screen(graded: boolean): Screen {
    return { status: graded ? "DROPPED" : "UNSCREENED", reason: "Preliminary market screening.", card: null,
        bestCase: null, assumed: null, needsAnalysis: graded ? "SLAB_LABEL" : "IDENTITY", soldEvidence: soldEvidence(graded),
        money: { shipping: 0, auction: false, usual: null, bestOffer: false,
            paths: [{ label: graded ? "Resell PSA 8" : "Resell raw", path: graded ? "GRADED_RESALE" : "RAW",
                expectedNet: netFromSale(150, graded ? "graded" : "raw", MONEY_CONFIG.selling), fixedCosts: 0,
                compCount: 3, compConfidence: "MEDIUM" }] } };
}
function listing(screen: Screen, price: number): ListingSummary {
    return { id: "offline-retarget", title: "Charizard Base Set 4/102 English", url: "#", currentPrice: price, shipping: 0,
        buyingOption: "FIXED_PRICE", isGraded: screen.money?.paths.some(path => path.path === "GRADED_RESALE") ?? false,
        images: ["photo"], bids: 0, endTime: null, seller: null, screen };
}

test("supported slab screening can reopen or reject saved targets without provider work", t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("target changes must use stored sold observations"));
    const original = screen(true), before = structuredClone(original);
    const strict = retargetScreen(original, 50, { minProfit: 100, minRoi: 0 });
    assert.equal(strict.status, "DROPPED");
    assert.equal(canAutoAnalyze(listing(strict, 50)), false);
    const upperOnly = retargetScreen(strict, 50, { minProfit: 70, minRoi: 0 });
    assert.notEqual(upperOnly.status, "DROPPED", "a preliminary median cannot reject a slab while the supported recent upper outcome still clears targets");
    assert.equal(canAutoAnalyze(listing(upperOnly, 50)), true);
    const relaxed = retargetScreen(strict, 50, { minProfit: 0, minRoi: 0 });
    assert.equal(relaxed.status, "CANDIDATE");
    assert.equal(canAutoAnalyze(listing(relaxed, 50)), true);
    assert.equal(resultGroup(listing(relaxed, 50), null), "candidates");
    assert.equal(retargetScreen(relaxed, 50, { minProfit: 100, minRoi: 0 }).status, "DROPPED");
    assert.deepEqual(relaxed.soldEvidence, original.soldEvidence);
    assert.deepEqual(original, before, "recalculation must not mutate the saved screen or references");
});

test("raw sold-price ranking cannot close the unassessed raw-to-grade route when targets change", t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("raw preliminary retargeting must stay local"));
    const original = screen(false);
    for (const targets of [{ minProfit: 0, minRoi: 0 }, { minProfit: 1000, minRoi: 2 }]) {
        const updated = retargetScreen(original, 500, targets);
        assert.equal(updated.status, "UNSCREENED");
        assert.equal(updated.needsAnalysis, "IDENTITY");
        assert.equal(canAutoAnalyze(listing(updated, 500)), true, "the raw sold sample has not priced its potential graded outcome");
    }
});

test("missing or deferred sold evidence cannot be reopened by stale preliminary money", () => {
    for (const status of ["UNAVAILABLE", "DEFERRED"] as const) {
        const original = screen(true);
        original.soldEvidence!.status = status;
        original.status = "UNSCREENED";
        const updated = retargetScreen(original, 1, { minProfit: 0, minRoi: 0 });
        assert.equal(updated, original);
        assert.equal(canAutoAnalyze(listing(updated, 1)), false);
        assert.equal(resultGroup(listing(updated, 1), null), "candidates");
    }
});

test("local retargeting preserves the distinction between unquoted shipping and an actual zero-dollar quote", () => {
    const original = screen(true);
    original.assumed = "Purchase shipping is unknown; $0 is used only to avoid excluding a possible opportunity.";
    const updated = retargetScreen(original, 50, { minProfit: 0, minRoi: 0 });
    assert.equal(updated.status, "CANDIDATE");
    assert.equal(updated.assumed, original.assumed);
});
