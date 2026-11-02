import { test } from "node:test";
import assert from "node:assert/strict";
import { auctionOutlook, describeOutlook } from "../../shared/money/auction.ts";
import { rateDeal } from "../../shared/money/rating.ts";

// Recent PSA 6 Alakazam sales.
const SLAB = { price: 62, sales: [41, 55, 60, 62, 70] };

test("auction comparisons retain observed prices and a clear bid limit without inventing win odds", () => {
    const outlook = auctionOutlook(10, SLAB);

    assert.equal(outlook.salesAtOrUnder, 0);
    assert.match(describeOutlook(outlook, 10), /item-bid limit is \$10\.00.*market reference is about \$62\.00; 0 of 5 observed sales went for \$10\.00 or less/);
});

test("a raw market quote supplies a reference without assuming a sale distribution", () => {
    for (const bid of [300, 450, 600]) {
        const outlook = auctionOutlook(bid, { price: 500 });
        assert.equal(outlook.salesAtOrUnder, null); assert.equal(outlook.salesTotal, null);
        assert.equal(outlook.usualPrice, 500);
    }
});

test("an auction's market-reference gap does not override actual deal evidence or change its rating", () => {
    const best = { path: "GRADED_RESALE", status: "PRICED", label: "Resell as PSA 6", maxBid: 10, downside: 5, profit: 40, salePrice: 62, expectedNet: 50, fixedCosts: 0, shipping: 0 };
    const rating = rateDeal({
        listing: { price: 0.99, buyingOption: "AUCTION", seller: null, cardCondition: null },
        underwriting: { verdict: "BUY_GRADED", best, paths: [best], reasons: [], assumptions: [] },
        slabPricing: {
            status: "PRICED",
            summary: { grader: "PSA", grade: "6", count: 5, median: 62, low: 41, high: 70, confidence: "HIGH", dropped: {}, sales: SLAB.sales.map((price) => ({ price })) },
        },
        condition: null,
        gradingMode: "BLOCKED",
        gradedPricing: null,
    });

    assert.equal(rating.level, "STRONG");
    assert.deepEqual(rating.concerns, []);
    assert.match(rating.notes.join(" "), /0 of 5 observed sales/);
});

test("reference-price profit remains a scenario calculated with existing costs", () => {
    // The 1st Edition Neo Genesis Lugia, MP, at 87 cents with 6 days left.
    const raw = { path: "RAW", status: "PRICED", label: "Resell raw", salePrice: 1134.84 };
    const best = {
        path: "GRADE", status: "PRICED", label: "Grade with PSA", grader: "PSA",
        maxBid: 1209, expectedNet: 1695.9, fixedCosts: 364, shipping: 10, downside: 900, profit: 1300, outlook: [],
    };
    const rating = rateDeal({
        listing: { price: 0.87, buyingOption: "AUCTION", seller: null, cardCondition: null },
        underwriting: { verdict: "BUY_AND_GRADE", best, paths: [raw, best], reasons: [], assumptions: [] },
        condition: { confidence: "MEDIUM", rawCondition: "MODERATELY_PLAYED" },
        gradingMode: "FULL",
        gradedPricing: null,
        slabPricing: null,
    });

    assert.equal(rating.auction.profitAtUsual, 92.61);
    assert.match(describeOutlook(rating.auction, best.maxBid), /At that reference price, estimated profit would be \$92\.61/);
});
