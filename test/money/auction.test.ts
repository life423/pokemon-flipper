import { test } from "node:test";
import assert from "node:assert/strict";
import { auctionOutlook, describeOutlook, isLongShot } from "../../shared/money/auction.ts";
import { rateDeal } from "../../shared/money/rating.ts";

// Recent PSA 6 Alakazam sales.
const SLAB = { price: 62, sales: [41, 55, 60, 62, 70] };

test("a slab auction that never sells near the max bid is a long shot", () => {
    const outlook = auctionOutlook(10, SLAB);

    assert.equal(outlook.chance, "LONG_SHOT");
    assert.equal(outlook.salesAtOrUnder, 0);
    assert.match(describeOutlook(outlook, 10), /usually sells for about \$62\.00; 0 of 5 recent sales went for \$10\.00 or less/);
});

test("a slab auction is possible when some recent sales went that low", () => {
    assert.equal(auctionOutlook(56, SLAB).chance, "POSSIBLE");
});

test("a raw auction is judged against its market price", () => {
    assert.equal(auctionOutlook(600, { price: 500 }).chance, "LIKELY");
    assert.equal(auctionOutlook(450, { price: 500 }).chance, "POSSIBLE");
    assert.equal(auctionOutlook(300, { price: 500 }).chance, "LONG_SHOT");
});

test("only auctions are long shots", () => {
    assert.equal(isLongShot(true, SLAB, 10), true);
    assert.equal(isLongShot(false, SLAB, 10), false);
    assert.equal(isLongShot(true, null, 10), false);
});

test("a long-shot auction is rated a long shot, not a strong deal", () => {
    const best = { path: "GRADED_RESALE", status: "PRICED", label: "Resell as PSA 6", maxBid: 10, downside: 5, profit: 40, salePrice: 62 };
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

    assert.equal(rating.level, "LONG_SHOT");
    assert.equal(rating.auction.chance, "LONG_SHOT");
});

test("a likely auction shows the profit if it ends at its usual price, not at today's bid", () => {
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

    assert.equal(rating.auction.chance, "LIKELY");
    assert.equal(rating.auction.profitAtUsual, 92.61);
    assert.match(describeOutlook(rating.auction, best.maxBid), /winning there would make about \$92\.61/);
});
