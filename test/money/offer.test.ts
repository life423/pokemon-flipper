import { test } from "node:test";
import assert from "node:assert/strict";
import { describeOffer, offerPlan, roundOffer } from "../../shared/money/offer.ts";

test("offers round down to deliberate-looking numbers", () => {
    assert.equal(roundOffer(127.5), 125);
    assert.equal(roundOffer(743), 740);
    assert.equal(roundOffer(2553), 2550);
});

test("already a deal: open 15% under asking, and full price still clears", () => {
    const plan = offerPlan(150, 745);

    assert.equal(plan.offer, 125);
    assert.equal(plan.walkAway, 745);
    assert.equal(plan.clearsAtAsking, true);
    assert.match(describeOffer(plan, 150), /already a deal/);
});

test("too pricey at asking: offer the max price, the most that still clears", () => {
    const plan = offerPlan(500, 420);

    assert.equal(plan.offer, 420);
    assert.equal(plan.clearsAtAsking, false);
    assert.equal(plan.longShot, false);
    assert.match(describeOffer(plan, 500), /16% under asking/);
});

test("an offer more than 40% under asking is a long shot", () => {
    const plan = offerPlan(1000, 500);

    assert.equal(plan.longShot, true);
    assert.match(describeOffer(plan, 1000), /long shot/);
});

test("no offer when nothing clears at any price", () => {
    assert.equal(offerPlan(100, 0), null);
});
