import { test } from "node:test";
import assert from "node:assert/strict";
import { resaleActivity, matchedSoldActivity } from "../shared/liquidity.ts";
import { tcgplayerRawEstimate } from "./fixtures/tcgplayer-raw-estimate.ts";
const now = Date.parse("2026-10-25T12:00:00Z");
const sales = (count: number) => Array.from({ length: count }, (_, index) => ({ soldAt: "2026-10-20T12:00:00Z", price: 100,
    saleType: "fixed_price", title: "Exact card", url: `https://www.ebay.com/itm/${123450000000 + index}` }));

test("resale activity uses dated comps for the actual resale grade, not all grades", () => {
    const evaluation = {
        underwriting: { best: { path: "GRADE", grader: "PSA", outlook: [{ grade: 7, filledFrom: null }] } },
        condition: { gradeRange: { low: 5, likely: 7, high: 8 } },
        gradedPricing: { PSA: { byGrade: [{ grader: "PSA", grade: 7, sales: sales(3) }, { grader: "PSA", grade: 10, sales: sales(20) }] } },
    };
    const result = resaleActivity(evaluation, now);
    assert.equal(result.recentSales, 3);
    assert.equal(result.label, "Some recent sales");
    assert.match(result.detail, /PSA 7: 3 observed matching sales in the last 60 days/);
});

test("old and future sales do not imply current liquidity; raw market prices imply no turnover", () => {
    const evaluation = { underwriting: { best: { path: "GRADED_RESALE" } }, slabPricing: { summary: { grader: "CGC", grade: "9", sales: [{ soldAt: "2026-01-01" }, { soldAt: "2027-01-01" }] } } };
    assert.equal(resaleActivity(evaluation, now).recentSales, 0);
    assert.equal(resaleActivity(evaluation, now).label, "Sparse recent sales");
    assert.equal(resaleActivity({ underwriting: { best: { path: "RAW" } } }, now).recentSales, null);
});

test("a lower grade used for pricing does not count as matched liquidity at the estimated grade", () => {
    const evaluation = {
        underwriting: { best: { path: "GRADE", grader: "PSA", outlook: [{ grade: 9, filledFrom: 8 }] } },
        condition: { gradeRange: { low: 8, likely: 9, high: 9 } },
        gradedPricing: { PSA: { byGrade: [{ grader: "PSA", grade: 8, sales: sales(20) }] } },
    };
    assert.equal(resaleActivity(evaluation, now).recentSales, null);
});

test("matched liquidity counts unique confirmed transactions in 7/30/60/90-day windows", () => {
    const sale = (days: number, id: number) => ({ soldAt: new Date(now - days * 86400000).toISOString(), url: `https://www.ebay.com/itm/${123450000000 + id}`,
        title: "Exact card", saleType: "auction", price: 100 });
    const result = matchedSoldActivity({ slab: {}, slabPricing: { summary: { grader: "PSA", grade: "7", windowDays: 90,
        sales: [sale(2, 1), sale(2, 1), sale(12, 2), sale(50, 3), sale(95, 4), sale(-1, 5)] } } }, now);
    assert.equal(result?.last7, 1); assert.equal(result?.last30, 2); assert.equal(result?.last60, 3); assert.equal(result?.last90, 3);
    assert.equal(result?.returned, 3); assert.equal(result?.scope, "PSA 7");
});

test("TCGplayer estimates never become sold volume and seller-described transactions retain their scope", () => {
    const evaluation = { underwriting: { best: { path: "RAW" } }, condition: { rawCondition: "LIGHTLY_PLAYED" },
        rawPricing: { prices: [tcgplayerRawEstimate(100)], conditionEvidence: "TCGPLAYER", sellerConditionComps: null } };
    assert.equal(resaleActivity(evaluation, now).recentSales, null);
    assert.match(resaleActivity(evaluation, now).detail, /offers are competition, not completed sales/);
    evaluation.rawPricing.sellerConditionComps = { grader: "RAW", grade: "LIGHTLY_PLAYED", count: 1, sales: sales(1) };
    assert.equal(resaleActivity(evaluation, now).recentSales, 1);
    assert.match(resaleActivity(evaluation, now).detail, /seller-described condition/);
});
