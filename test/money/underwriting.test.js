import { test } from "node:test";
import assert from "node:assert/strict";
import {
    ebaySellingFees,
    netFromSale,
    acquisitionCost,
    gradingTier,
    gradeProbabilities,
    pricesByGrade,
    maxBid,
    underwrite,
} from "../../server/money/underwriting.js";

// A fixed copy of the config, so these tests don't move when you edit
// money.config.js.
const CONFIG = {
    verified: true,
    targets: { minProfit: 50, minRoi: 0.25 },
    buying: { salesTaxRate: 0.0825, assumedShippingWhenUnknown: 10 },
    selling: {
        finalValueRate: 0.1325,
        finalValueTierLimit: 7500,
        finalValueRateAboveLimit: 0.0235,
        perOrderFee: 0.4,
        perOrderFeeSmall: 0.3,
        smallOrderLimit: 10,
        typicalBuyerTaxRate: 0.08,
        promotedRate: 0,
        shipping: { raw: 5, graded: 10 },
    },
    grading: {
        shippingPerCard: 15,
        PSA: [
            { tier: "Standard", fee: 59.99, maxDeclaredValue: null },
            { tier: "Regular", fee: 79.99, maxDeclaredValue: 1499 },
            { tier: "Express", fee: 175, maxDeclaredValue: 2499 },
        ],
        CGC: [
            { tier: "Economy", fee: 20, maxDeclaredValue: 1000 },
            { tier: "Unlimited Value", fee: 300, percentOfValue: 0.01, maxDeclaredValue: Infinity },
        ],
    },
};

// Neo Genesis Lugia (Unlimited), Lightly Played, PSA 6 to 8 likely 7,
// with the real raw prices and PSA medians, listed at $300 + $5.
function lugiaEvaluation(overrides = {}) {
    return {
        listing: { price: 300, shipping: 5, buyingOption: "AUCTION" },
        identity: {
            status: "IDENTIFIED",
            set: "Neo Genesis",
            cardNumber: "009/111",
            printing: "UNLIMITED",
            reasons: [],
        },
        condition: {
            rawCondition: "LIGHTLY_PLAYED",
            gradeRange: { low: 6, likely: 7, high: 8 },
            authenticity: { concern: "NONE_SEEN", reasons: [] },
        },
        rawPricing: {
            status: "PRICED",
            prices: [
                { condition: "NEAR_MINT", price: 531.39 },
                { condition: "LIGHTLY_PLAYED", price: 446.25 },
            ],
        },
        gradedPricing: {
            PSA: {
                status: "PRICED",
                byGrade: [
                    { grade: 6, count: 20, median: 565 },
                    { grade: 7, count: 20, median: 810 },
                    { grade: 8, count: 19, median: 1245 },
                ],
            },
            CGC: { status: "PRICE_UNAVAILABLE", reason: "No verified CGC sales." },
        },
        ...overrides,
    };
}

const pathOf = (result, label) => result.paths.find((path) => path.label === label);

// Fees and costs

test("eBay fees: a percentage of what the buyer pays, tiered, plus the per-order fee", () => {
    assert.equal(ebaySellingFees(100, CONFIG.selling), 14.71);
    assert.equal(ebaySellingFees(10000, CONFIG.selling), 1071.7);
    assert.equal(ebaySellingFees(5, CONFIG.selling), 1.02);
});

test("what you keep from a sale, and what a purchase costs", () => {
    assert.equal(netFromSale(565, "graded", CONFIG.selling), 473.75);
    assert.equal(acquisitionCost(300, 5, CONFIG.buying), 330.16);
});

test("grading uses the cheapest service level whose cap covers the card", () => {
    assert.deepEqual(gradingTier("PSA", 1200, CONFIG.grading), { grader: "PSA", tier: "Regular", fee: 79.99 });
    assert.deepEqual(gradingTier("PSA", 2000, CONFIG.grading), { grader: "PSA", tier: "Express", fee: 175 });
    assert.equal(gradingTier("PSA", 5000, CONFIG.grading), null);
    assert.deepEqual(gradingTier("CGC", 800, CONFIG.grading), { grader: "CGC", tier: "Economy", fee: 20 });
    assert.deepEqual(gradingTier("CGC", 50000, CONFIG.grading), { grader: "CGC", tier: "Unlimited Value", fee: 800 });
});

// Grades and prices

test("the grade range becomes probabilities in code", () => {
    const likely = gradeProbabilities({ low: 6, likely: 7, high: 8 }).map((g) => g.probability);
    const limited = gradeProbabilities({ low: 6, likely: null, high: 8 }).map((g) => g.probability);

    assert.deepEqual(likely, [0.25, 0.5, 0.25]);
    assert.deepEqual(limited.map((p) => p.toFixed(3)), ["0.333", "0.333", "0.333"]);
});

test("a grade with no sales takes the next lower grade's price, and with nothing below there's no floor", () => {
    const filled = pricesByGrade(
        [
            { grade: 6, count: 3, median: 565 },
            { grade: 7, count: 0, median: null },
            { grade: 8, count: 4, median: 1245 },
        ],
        { low: 6, high: 8 }
    );
    const noFloor = pricesByGrade(
        [
            { grade: 6, count: 0, median: null },
            { grade: 7, count: 5, median: 810 },
        ],
        { low: 6, high: 7 }
    );

    assert.deepEqual(filled.prices[7], { price: 565, filledFrom: 6 });
    assert.equal(noFloor.ok, false);
});

test("the max bid clears both the minimum profit and the minimum return", () => {
    assert.equal(maxBid({ expectedNet: 1000, fixedCosts: 100, shipping: 5 }, CONFIG), 641);
});

// Verdicts

test("Lugia at $300: grading with PSA clears the targets, reselling raw doesn't", () => {
    const result = underwrite(lugiaEvaluation(), CONFIG);
    const raw = pathOf(result, "Resell raw");
    const psa = pathOf(result, "Grade with PSA");

    assert.equal(result.verdict, "BUY_AND_GRADE");
    assert.equal(result.best.grader, "PSA");

    assert.equal(raw.salePrice, 446.25);
    assert.equal(raw.profit, 46.83);
    assert.equal(raw.clears, false);
    assert.equal(raw.maxBid, 273);

    assert.equal(psa.tier, "Regular");
    assert.equal(psa.expectedNet, 724.39);
    assert.equal(psa.profit, 299.24);
    assert.equal(psa.maxBid, 442);

    assert.equal(pathOf(result, "Grade with CGC").status, "UNAVAILABLE");
});

test("when no path clears, it's a pass that still names the best max bid", () => {
    const result = underwrite(lugiaEvaluation({ listing: { price: 700, shipping: 5 } }), CONFIG);

    assert.equal(result.verdict, "PASS");
    assert.equal(result.best.maxBid, 442);
    assert.match(result.reasons[0], /best max bid is \$442\.00/);
});

test("raw prices fall back to a worse condition, never a better one", () => {
    const result = underwrite(
        lugiaEvaluation({
            condition: {
                rawCondition: "MODERATELY_PLAYED",
                gradeRange: { low: 6, likely: 7, high: 8 },
                authenticity: { concern: "NONE_SEEN", reasons: [] },
            },
            rawPricing: {
                status: "PRICED",
                prices: [
                    { condition: "NEAR_MINT", price: 531.39 },
                    { condition: "LIGHTLY_PLAYED", price: 446.25 },
                    { condition: "HEAVILY_PLAYED", price: 210.54 },
                ],
            },
        }),
        CONFIG
    );

    assert.equal(pathOf(result, "Resell raw").salePrice, 210.54);
});

test("a card worth more than every service level's cap can't take the grading path", () => {
    const evaluation = lugiaEvaluation();
    evaluation.gradedPricing.PSA.byGrade[2] = { grade: 8, count: 5, median: 5000 };

    const psa = pathOf(underwrite(evaluation, CONFIG), "Grade with PSA");

    assert.equal(psa.status, "UNAVAILABLE");
    assert.match(psa.reason, /No PSA service level/);
});

test("nothing is priced for an unidentified card, and a likely fake is a pass", () => {
    const unidentified = underwrite(
        lugiaEvaluation({ identity: { status: "NEEDS_REVIEW", printing: "UNKNOWN", reasons: ["Seller and photos disagree."] } }),
        CONFIG
    );
    const fake = underwrite(
        lugiaEvaluation({
            condition: {
                rawCondition: "LIGHTLY_PLAYED",
                gradeRange: { low: 6, likely: 7, high: 8 },
                authenticity: { concern: "LIKELY_FAKE", reasons: ["Wrong font."] },
            },
        }),
        CONFIG
    );

    assert.equal(unidentified.verdict, "NEEDS_REVIEW");
    assert.deepEqual(unidentified.paths, []);
    assert.equal(fake.verdict, "PASS");
});

test("unquoted shipping is assumed and said so; unchecked fees are flagged", () => {
    const result = underwrite(
        lugiaEvaluation({ listing: { price: 300, shipping: null } }),
        { ...CONFIG, verified: false }
    );

    assert.equal(result.assumptions.length, 2);
    assert.match(result.assumptions[0], /\$10\.00 is assumed/);
});

// Path 3: a graded card resold as is

function slabEvaluation(overrides = {}) {
    return {
        listing: { price: 1500, shipping: 10, buyingOption: "FIXED_PRICE" },
        identity: {
            status: "IDENTIFIED",
            set: "Neo Genesis",
            cardNumber: "009/111",
            printing: "UNLIMITED",
            reasons: [],
        },
        condition: null,
        slab: { status: "OK", grader: "PSA", grade: "9", reasons: [], concerns: [] },
        slabPricing: {
            status: "PRICED",
            summary: { grader: "PSA", grade: "9", count: 5, median: 2600, low: 2325 },
        },
        ...overrides,
    };
}

test("a PSA 9 Lugia at $1,500 clears as a buy to resell graded", () => {
    const result = underwrite(slabEvaluation(), CONFIG);

    assert.equal(result.verdict, "BUY_GRADED");
    assert.equal(result.best.label, "Resell as PSA 9");
    assert.equal(result.best.profit, 582.96);
    assert.equal(result.best.maxBid, 1628);
});

test("the same slab at $2,000 is a pass that names the max bid", () => {
    const result = underwrite(slabEvaluation({ listing: { price: 2000, shipping: 10 } }), CONFIG);

    assert.equal(result.verdict, "PASS");
    assert.match(result.reasons[0], /max bid is \$1628\.00/);
});

test("a slab that needs review, or looks fake, isn't priced", () => {
    const review = underwrite(
        slabEvaluation({ slab: { status: "NEEDS_REVIEW", reasons: ["The case looks cracked."], concerns: [] } }),
        CONFIG
    );
    const fake = underwrite(
        slabEvaluation({ slab: { status: "LIKELY_FAKE", reasons: [], concerns: ["Wrong label font."] } }),
        CONFIG
    );

    assert.equal(review.verdict, "NEEDS_REVIEW");
    assert.equal(fake.verdict, "PASS");
});
