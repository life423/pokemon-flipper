import { test } from "node:test";
import assert from "node:assert/strict";
import { describeOffer, offerPlan, roundOffer } from "../../shared/money/offer.ts";

test("offers round down to deliberate-looking numbers", () => {
    assert.equal(roundOffer(127.5), 125);
    assert.equal(roundOffer(743), 740);
    assert.equal(roundOffer(2553), 2550);
});

test("already a deal: open at most 10% under asking, and full price still clears", () => {
    const plan = offerPlan(150, 745);

    assert.equal(plan.offer, 135);
    assert.equal(plan.walkAway, 745);
    assert.equal(plan.clearsAtAsking, true);
    assert.match(describeOffer(plan, 150), /already a deal/);
});

test("open at the lowest price in the negotiation band and keep the ceiling separate", () => {
    const plan = offerPlan(500, 460);

    assert.equal(plan.offer, 425);
    assert.equal(plan.walkAway, 460);
    assert.equal(plan.clearsAtAsking, false);
    assert.equal(plan.requiresPriceDrop, false);
    assert.match(describeOffer(plan, 500), /15% under asking/);
});

test("an offer more than 15% under asking requires a price drop", () => {
    const plan = offerPlan(1000, 500);

    assert.equal(plan.requiresPriceDrop, true);
    assert.match(describeOffer(plan, 1000), /15% offer range/);
});

test("no offer when nothing clears at any price", () => {
    assert.equal(offerPlan(100, 0), null);
});

test("invalid asking prices and purchase limits cannot produce an offer", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
        assert.equal(offerPlan(value, 100), null);
        assert.equal(offerPlan(100, value), null);
    }
});


test("the 15% offer cutoff survives rounding and rejects the screenshot examples", () => {
    assert.equal(offerPlan(125, 76).requiresPriceDrop, true);
    assert.equal(offerPlan(600, 417).requiresPriceDrop, true);
    assert.equal(offerPlan(650, 418).requiresPriceDrop, true);
    const plan = offerPlan(125, 106.5);
    assert.equal(plan.offer, 106.25);
    assert.equal(plan.requiresPriceDrop, false);
    assert.ok(plan.offer >= 125 * 0.85);
    assert.ok(plan.offer <= plan.walkAway);
    assert.equal(offerPlan(125, 106.24).requiresPriceDrop, true);
    assert.equal(offerPlan(99.99, 85).offer, 85);
});
