import { test } from "node:test";
import assert from "node:assert/strict";
import { resaleActivity, matchedSoldActivity } from "../shared/liquidity.ts";
const now = Date.parse("2026-10-25T12:00:00Z");
const sales = (count: number) => Array.from({ length: count }, () => ({ soldAt: "2026-10-20T12:00:00Z", price: 100 }));

test("resale activity uses dated comps for the actual resale grade, not all grades", () => {
    const evaluation = {
        underwriting: { best: { path: "GRADE", grader: "PSA", outlook: [{ grade: 7, filledFrom: null }] } },
        condition: { gradeRange: { low: 5, likely: 7, high: 8 } },
        gradedPricing: { PSA: { byGrade: [{ grader: "PSA", grade: 7, sales: sales(3) }, { grader: "PSA", grade: 10, sales: sales(20) }] } },
    };
    const result = resaleActivity(evaluation, now);
    assert.equal(result.recentSales, 3);
    assert.equal(result.label, "Some recent sales");
    assert.match(result.detail, /PSA 7: 3 matched sold comps/);
});

test("old and future sales do not imply current liquidity; raw market prices imply no turnover", () => {
    const evaluation = { underwriting: { best: { path: "GRADED_RESALE" } }, slabPricing: { summary: { grader: "CGC", grade: "9", sales: [{ soldAt: "2026-01-01" }, { soldAt: "2027-01-01" }] } } };
    assert.equal(resaleActivity(evaluation, now).recentSales, 0);
    assert.equal(resaleActivity(evaluation, now).label, "Sparse recent sales");
    assert.equal(resaleActivity({ underwriting: { best: { path: "RAW" } } }, now).recentSales, null);
});

test("matched liquidity counts unique dated sales in 7/30/90-day windows", () => {
    const sale = (days: number, url: string) => ({ soldAt: new Date(now - days * 86400000).toISOString(), url, price: 100 });
    const result = matchedSoldActivity({ slab: {}, slabPricing: { summary: { grader: "PSA", grade: "7", windowDays: 90,
        sales: [sale(2, "a"), sale(2, "a"), sale(12, "b"), sale(50, "c"), sale(95, "d"), sale(-1, "future")] } } }, now);
    assert.equal(result?.last7, 1); assert.equal(result?.last30, 2); assert.equal(result?.last90, 3);
    assert.equal(result?.returned, 3); assert.equal(result?.scope, "PSA 7");
});
