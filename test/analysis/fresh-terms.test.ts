import { test } from "node:test";
import assert from "node:assert/strict";
import { withFreshListing } from "../../shared/fresh-listing.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import type { ListingSummary } from "../../shared/types.ts";

test("fresh server terms reach cards and repricing; later selected refreshes still win", () => {
    const e = cardEvaluation();
    Object.assign(e.listing, { title: "Updated title", price: 90, shipping: null, bids: 4, termsCheckedAt: "2026-10-30T12:00:00Z" });
    const old: ListingSummary = { id: e.listing.id, title: "Old title", url: e.listing.url, images: [], currentPrice: 1, shipping: 0, bids: 0, buyingOption: "FIXED_PRICE", endTime: null, seller: null, isGraded: false };
    const next = withFreshListing(old, e);
    assert.equal(next.currentPrice, 90); assert.equal(next.shipping, null); assert.equal(next.title, "Updated title");
    assert.equal(old.currentPrice, 1);
    const repriced = retargetEvaluation(e, { minProfit: 0, minRoi: 0 }, old);
    assert.equal(repriced.listing.price, 90); assert.equal(repriced.listing.shipping, null);
    const later = { ...next, currentPrice: 100, termsCheckedAt: "2026-10-30T12:01:00Z" };
    assert.equal(withFreshListing(later, e), later);
    assert.equal(retargetEvaluation(e, { minProfit: 0, minRoi: 0 }, later).listing.price, 100);
});
