import { test } from "node:test";
import assert from "node:assert/strict";
import { resaleActivity } from "../shared/liquidity.ts";
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
    assert.match(result.detail, /not sell-through/);
});

test("old and future sales do not imply current liquidity; raw market prices imply no turnover", () => {
    const evaluation = { underwriting: { best: { path: "GRADED_RESALE" } }, slabPricing: { summary: { grader: "CGC", grade: "9", sales: [{ soldAt: "2026-01-01" }, { soldAt: "2027-01-01" }] } } };
    assert.equal(resaleActivity(evaluation, now).recentSales, 0);
    assert.equal(resaleActivity(evaluation, now).label, "Sparse recent sales");
    assert.equal(resaleActivity({ underwriting: { best: { path: "RAW" } } }, now).recentSales, null);
});
