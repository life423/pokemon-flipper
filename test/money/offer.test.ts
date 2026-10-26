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

test("too pricey at asking: offer the max price, the most that still clears", () => {
    const plan = offerPlan(500, 460);

    assert.equal(plan.offer, 460);
    assert.equal(plan.clearsAtAsking, false);
    assert.equal(plan.longShot, false);
    assert.match(describeOffer(plan, 500), /8% under asking/);
});

test("an offer more than 10% under asking is a long shot", () => {
    const plan = offerPlan(1000, 500);

    assert.equal(plan.longShot, true);
    assert.match(describeOffer(plan, 1000), /10% offer-discovery cutoff/);
});

test("no offer when nothing clears at any price", () => {
    assert.equal(offerPlan(100, 0), null);
});


test("the 10% offer cutoff survives rounding and rejects the screenshot examples", () => {
    assert.equal(offerPlan(125, 76).longShot, true);
    assert.equal(offerPlan(600, 417).longShot, true);
    assert.equal(offerPlan(650, 418).longShot, true);
    const plan = offerPlan(125, 113);
    assert.equal(plan.offer, 112.5);
    assert.equal(plan.longShot, false);
    assert.ok(plan.offer >= 125 * 0.9);
    assert.ok(plan.offer <= plan.walkAway);
});
