import { test } from "node:test";
import assert from "node:assert/strict";
import { analysisConcurrency, resultGroup } from "../../shared/analysis.ts";

test("losing at asking is never a deal, and lowball offers are not opportunities", () => {
    const listing = { buyingOption: "FIXED_PRICE", bestOffer: true, currentPrice: 125 };
    const evaluation = { underwriting: { verdict: "PASS", best: { maxBid: 76, profit: -52.99 } } };
    assert.equal(resultGroup(listing, evaluation, true), null);
    assert.equal(resultGroup({ ...listing, currentPrice: 80 }, evaluation, true), "offers");
    assert.equal(resultGroup({ ...listing, currentPrice: 80 }, evaluation, false), null);
    const buy = { underwriting: { verdict: "BUY_RAW", best: { maxBid: 150, profit: 10 } } };
    assert.equal(resultGroup(listing, buy, false), "deals");
});

test("AI concurrency grows with candidates, respects a cap, and backs off after failures", () => {
    assert.equal(analysisConcurrency(1), 1);
    assert.ok(analysisConcurrency(54) > 3);
    assert.equal(analysisConcurrency(1000), 8);
    assert.ok(analysisConcurrency(54, [false, false]) < analysisConcurrency(54, [true, true]));
    assert.ok(analysisConcurrency(0, [false, false]) >= 1);
});

test("minimum potential grade uses the upper end without claiming certainty", async () => {
    const { meetsMinimumGrade } = await import("../../shared/analysis.ts");
    const raw = (low, likely, high) => ({ condition: { gradeRange: { low, likely, high } } });
    assert.equal(meetsMinimumGrade(raw(5, 7, 8), 7), true);
    assert.equal(meetsMinimumGrade(raw(3, 5, 8), 7), true);
    assert.equal(meetsMinimumGrade(raw(5, null, 9), 7), true);
    assert.equal(meetsMinimumGrade(raw(7, null, 9), 7), true);
    assert.equal(meetsMinimumGrade({ slab: { status: "OK", grade: "7.5" } }, 7), true);
    assert.equal(meetsMinimumGrade({ slab: { status: "NEEDS_REVIEW", grade: "9" } }, 7), false);
    assert.equal(meetsMinimumGrade({}, 0), true);
    assert.equal(meetsMinimumGrade({}, 7), false);
});
