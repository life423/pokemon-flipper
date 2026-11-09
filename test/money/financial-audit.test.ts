import { test } from "node:test";
import assert from "node:assert/strict";
import { MONEY_CONFIG, type MoneyConfig } from "../../shared/money/config.ts";
import {
    acquisitionCost,
    ebaySellingFees,
    gradePath,
    gradingTier,
    maxBid,
    netFromSale,
    pathNumbers,
    underwrite,
} from "../../shared/money/underwriting.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";

// Worked transaction examples, deliberately independent of current published
// fee defaults. Prices below include the amount collected for delivery.
const config: MoneyConfig = {
    ...MONEY_CONFIG,
    targets: { minProfit: 50, minRoi: 0.25 },
    buying: { salesTaxRate: 0.1, assumedShippingWhenUnknown: 7 },
    selling: {
        finalValueRate: 0.1,
        finalValueTierLimit: 7500,
        finalValueRateAboveLimit: 0.0235,
        perOrderFee: 0.4,
        perOrderFeeSmall: 0.3,
        smallOrderLimit: 10,
        typicalBuyerTaxRate: 0.1,
        promotedRate: 0,
        shipping: { raw: 6, graded: 8 },
    },
};

test("worked transactions deduct purchase, selling and grading costs exactly once on all three routes", () => {
    // $300 collected + $30 buyer tax gives a $33.40 selling fee. Raw
    // delivery costs $6; slab delivery costs $8. Buying $100 + $5 delivery
    // costs $115.50 including tax. Grading adds $35, without taxing it as
    // part of the eBay purchase.
    assert.equal(ebaySellingFees(300, config.selling), 33.4);
    assert.equal(netFromSale(300, "raw", config.selling), 260.6);
    assert.equal(netFromSale(300, "graded", config.selling), 258.6);
    assert.equal(acquisitionCost(100, 5, config.buying), 115.5);

    for (const [route, expectedNet, fixedCosts, cost, profit] of [
        ["raw resale", 260.6, 0, 115.5, 145.1],
        ["slab resale", 258.6, 0, 115.5, 143.1],
        ["buy and grade", 258.6, 35, 150.5, 108.1],
    ] as const) {
        const result = pathNumbers({ expectedNet, fixedCosts, shipping: 5, price: 100 }, config);
        assert.equal(result.cost, cost, route);
        assert.equal(result.profit, profit, route);
        assert.equal(result.clears, true, route);
    }
});

test("worked tiered sale charges the higher rate only through the fee threshold", () => {
    // $10,000 collected + $1,000 tax: $7,500 x 10% = $750;
    // $3,500 x 2.35% = $82.25; order fee = $0.40.
    assert.equal(ebaySellingFees(10000, config.selling), 832.65);
    assert.equal(netFromSale(10000, "graded", config.selling), 9159.35);
    assert.equal(ebaySellingFees(5, config.selling), 0.85);
});

test("promoted listing costs include the buyer tax in the total sale fee base", () => {
    // $100 collected + $10 tax: final value fee $11 + order fee $0.40
    // + 5% of $110 promoted-listing fee $5.50 = $16.90.
    assert.equal(ebaySellingFees(100, { ...config.selling, promotedRate: 0.05 }), 16.9);
});

test("tax and selling-fee multiplication stay decimal-exact through an aggregate half-cent", () => {
    // $157.50 + 10% tax = $173.25; 10% fee = $17.325.
    // Adding the $0.40 order fee gives $17.725, which rounds to $17.73.
    assert.equal(ebaySellingFees(157.5, config.selling), 17.73);
});

test("an exact half-cent in combined final-value and promoted fees rounds up", () => {
    // $3,187.50 x 1.08 = $3,442.50. Final-value fee at 13.6% is
    // $468.18; advertising at 5% is $172.125; order fee is $0.40.
    // Aggregate $640.705 rounds to $640.71.
    const selling = { ...config.selling, finalValueRate: 0.136, typicalBuyerTaxRate: 0.08, promotedRate: 0.05 };
    assert.equal(ebaySellingFees(3187.5, selling), 640.71);
});

test("purchase tax rounds decimal half cents up rather than losing a cent to binary floating point", () => {
    // 8.25% = 33/400 exactly: $62 x 1.0825 = $67.115.
    const buying = { salesTaxRate: 0.0825, assumedShippingWhenUnknown: 7 };
    assert.equal(acquisitionCost(62, 0, buying), 67.12);
    assert.equal(acquisitionCost(270, 0, buying), 292.28);
    assert.equal(acquisitionCost(298, 0, buying), 322.59);
    assert.equal(acquisitionCost(55, 7, buying), 67.12);
});

test("an actual cents-priced purchase can meet the target even above the last whole dollar", () => {
    const money = { ...config, buying: { ...config.buying, salesTaxRate: 0 }, targets: { minProfit: 50, minRoi: 0 } };
    const result = pathNumbers({ expectedNet: 150.75, fixedCosts: 0, shipping: 0, price: 100.5 }, money);
    assert.equal(result.cost, 100.5);
    assert.equal(result.profit, 50.25);
    assert.equal(result.clears, true);
    assert.equal(result.maxBid, 100.75);
    assert.equal(pathNumbers({ expectedNet: 150.75, fixedCosts: 0, shipping: 0, price: 100.76 }, money).clears, false);
});

test("a recommended bid meets the ROI target using rounded cash costs, including at the last cent", () => {
    const money = { ...config, buying: { ...config.buying, salesTaxRate: 0.0825 }, targets: { minProfit: 0, minRoi: 0.25 } };
    // $198 costs $214.34 after rounded purchase tax. $267.92 - $214.34
    // leaves $53.58: less than the $53.585 required for a true 25% return.
    // At $197.99, total cost is $214.32 and profit $53.60, meeting 25%.
    const terms = { expectedNet: 267.92, fixedCosts: 0, shipping: 0 };
    assert.equal(maxBid(terms, money), 197.99);
    const meets = pathNumbers({ ...terms, price: 197.99 }, money);
    assert.equal(meets.cost, 214.32);
    assert.equal(meets.profit, 53.6);
    assert.ok(meets.profit / meets.cost >= 0.25);
    assert.equal(meets.clears, true);
    assert.equal(pathNumbers({ ...terms, price: 198 }, money).clears, false);
});

test("ROI retains the actual return instead of rounding fractions to whole percentage points", () => {
    const money = { ...config, buying: { ...config.buying, salesTaxRate: 0 }, targets: { minProfit: 0, minRoi: 0.25 } };
    const result = pathNumbers({ expectedNet: 124.6, fixedCosts: 0, shipping: 0, price: 100 }, money);
    assert.equal(result.profit, 24.6);
    assert.equal(result.roi, 0.246);
    assert.equal(result.clears, false);
    assert.equal(result.roiAtMaxBid, result.profitAtMaxBid! / result.costAtMaxBid!);
});

test("weighted grading proceeds use the same cent amount before and after saved-result recalculation", () => {
    const money: MoneyConfig = {
        ...config,
        targets: { minProfit: 0, minRoi: 0 },
        buying: { ...config.buying, salesTaxRate: 0 },
        selling: { ...config.selling, finalValueRate: 0, finalValueRateAboveLimit: 0, perOrderFee: 0, perOrderFeeSmall: 0, typicalBuyerTaxRate: 0, shipping: { raw: 0, graded: 0 } },
        grading: { shippingPerCard: 0, PSA: [{ tier: "Fixture only", fee: 0, maxDeclaredValue: 1000 }], CGC: [] },
    };
    const listing = { price: 100.01, shipping: 0 };
    const path = gradePath({
        listing,
        identity: null,
        condition: { rawCondition: "NEAR_MINT", gradeRange: { low: 6, likely: null, high: 8 }, authenticity: { concern: "NONE_SEEN", reasons: [] } },
        gradedPricing: { PSA: { status: "PRICED", byGrade: [salesSummary("PSA", 6, [100, 100, 100]), salesSummary("PSA", 7, [100.01, 100.01, 100.01]), salesSummary("PSA", 8, [100.01, 100.01, 100.01])] } },
    }, "PSA", listing, 0, money);
    assert.equal(path.status, "PRICED");
    if (path.status !== "PRICED") return;
    // Equal weights give $100.006666...; monetary expected proceeds are
    // represented as $100.01 everywhere, including reuse without AI.
    assert.equal(path.expectedNet, 100.01);
    const reused = pathNumbers({ expectedNet: path.expectedNet, fixedCosts: path.fixedCosts, shipping: 0, price: listing.price }, money);
    assert.equal(path.maxBid, 100);
    assert.equal(path.profit, 0);
    assert.equal(path.clears, false);
    assert.equal(pathNumbers({ expectedNet: path.expectedNet, fixedCosts: 0, shipping: 0, price: path.maxBid }, money).clears, true);
    assert.equal(path.maxBid, reused.maxBid);
    assert.equal(path.profit, reused.profit);
    assert.equal(path.clears, reused.clears);
});

test("grading tier choice is independent of configuration order and never taxes the submission fee as acquisition", () => {
    const grading = {
        shippingPerCard: 15,
        PSA: [
            { tier: "Higher", fee: 120, maxDeclaredValue: 3000 },
            { tier: "Lower", fee: 30, maxDeclaredValue: 1000 },
            { tier: "Disabled", fee: 1, maxDeclaredValue: null },
        ],
        CGC: [],
    };
    assert.deepEqual(gradingTier("PSA", 1000, grading), { grader: "PSA", tier: "Lower", fee: 30 });
    assert.deepEqual(gradingTier("PSA", 1000.01, grading), { grader: "PSA", tier: "Higher", fee: 120 });
    assert.equal(gradingTier("PSA", 3000.01, grading), null);
});

test("sold evidence cannot price a different grader or certified grade than the photographed slab", () => {
    for (const summary of [salesSummary("PSA", 8), salesSummary("CGC", 7)]) {
        const result = underwrite({
            listing: { price: 10, shipping: 0 },
            identity: cardEvaluation().identity,
            condition: null,
            slab: { status: "OK", grader: "PSA", grade: "7", reasons: [], concerns: [] },
            slabPricing: { status: "PRICED", summary },
        }, config);
        assert.equal(result.verdict, "CANT_PRICE");
        assert.equal(result.best, null);
    }
});

test("invalid sold summaries cannot produce numerical slab advice", () => {
    for (const invalid of [{ median: Infinity }, { median: NaN }, { median: -200 }, { low: NaN }, { low: 0 }, { low: 300 }, { count: Infinity }]) {
        const result = underwrite({
            listing: { price: 10, shipping: 0 },
            identity: cardEvaluation().identity,
            condition: null,
            slab: { status: "OK", grader: "PSA", grade: "7", reasons: [], concerns: [] },
            slabPricing: { status: "PRICED", summary: { ...salesSummary("PSA", 7), ...invalid } },
        }, config);
        assert.equal(result.verdict, "CANT_PRICE");
        assert.equal(result.best, null);
    }
});
