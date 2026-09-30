import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateFlipMetrics } from "../public/flip.js";

test("computes profit and ROI when there's a resale estimate", () => {
    const metrics = calculateFlipMetrics({
        currentPrice: 100,
        shipping: 0,
        estimatedResalePrice: 200,
    });

    // $100 + $8.25 tax = $108.25 in; $200 - $26 fees - $6 shipping out.
    assert.equal(metrics.acquisitionCost, 108.25);
    assert.equal(metrics.estimatedProfit, 59.75);
    assert.ok(Math.abs(metrics.roi - 55.196) < 0.01);
});

test("unknown shipping counts as zero", () => {
    const metrics = calculateFlipMetrics({
        currentPrice: 50,
        shipping: null,
        estimatedResalePrice: null,
    });

    assert.equal(metrics.subtotal, 50);
});

test("no resale estimate means no fees, profit, or ROI", () => {
    const metrics = calculateFlipMetrics({
        currentPrice: 50,
        shipping: 5,
        estimatedResalePrice: null,
    });

    assert.equal(metrics.estimatedSellingFees, null);
    assert.equal(metrics.estimatedProfit, null);
    assert.equal(metrics.roi, null);
});
