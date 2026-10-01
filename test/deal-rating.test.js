import { test } from "node:test";
import assert from "node:assert/strict";
import { rateDeal } from "../deal-rating.js";

const evaluation = (overrides = {}) => ({
    listing: {
        price: 300,
        buyingOption: "FIXED_PRICE",
        cardCondition: "Near mint or better",
        seller: { username: "cards", feedbackPercentage: 99.8, feedbackScore: 1200 },
        ...overrides.listing,
    },
    gradingMode: "FULL",
    condition: { confidence: "HIGH", rawCondition: "NEAR_MINT", ...overrides.condition },
    gradedPricing: {
        PSA: {
            byGrade: [
                { grader: "PSA", grade: 8, count: 19, confidence: "HIGH" },
                { grader: "PSA", grade: 9, count: 6, confidence: "HIGH" },
            ],
        },
    },
    underwriting: {
        verdict: "BUY_AND_GRADE",
        best: {
            path: "GRADE",
            grader: "PSA",
            maxBid: 450,
            downside: 20,
            profit: 150,
            outlook: [
                { grade: 8, filledFrom: null },
                { grade: 9, filledFrom: null },
            ],
            ...overrides.best,
        },
    },
});

test("lots of room, a safe low end, solid comps, and a good seller is a strong deal", () => {
    const rating = rateDeal(evaluation());

    assert.equal(rating.level, "STRONG");
    assert.deepEqual(rating.concerns, []);
    assert.equal(rating.room, 0.333);
});

test("each concern drops the rating a level", () => {
    const thinRoom = rateDeal(evaluation({ best: { maxBid: 320 } }));
    const alsoNewSeller = rateDeal(
        evaluation({
            best: { maxBid: 320 },
            listing: { seller: { username: "new", feedbackPercentage: 0, feedbackScore: 3 } },
        })
    );

    assert.equal(thinRoom.level, "GOOD");
    assert.equal(alsoNewSeller.level, "THIN");
    assert.match(alsoNewSeller.concerns.join(" "), /3 feedback/);
});

test("a loss at the low end and thin comps are concerns", () => {
    const base = evaluation({ best: { downside: -40 } });
    base.gradedPricing.PSA.byGrade[1] = { grader: "PSA", grade: 9, count: 1, confidence: "LOW" };

    const rating = rateDeal(base);

    assert.equal(rating.level, "THIN");
    assert.match(rating.concerns.join(" "), /Loses \$40\.00/);
    assert.match(rating.concerns.join(" "), /Only 1 verified PSA 9 sale /);
});

test("a seller who oversells the condition is a concern", () => {
    const rating = rateDeal(evaluation({ condition: { rawCondition: "MODERATELY_PLAYED" } }));

    assert.match(rating.concerns.join(" "), /calls it Near Mint, but the photos look Moderately Played/);
});

test("only deals get a rating", () => {
    const passed = evaluation();
    passed.underwriting.verdict = "PASS";

    assert.equal(rateDeal(passed), null);
});
