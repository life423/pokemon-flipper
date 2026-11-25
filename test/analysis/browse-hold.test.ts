import "../fixtures/isolated-data.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { evaluationFailure } from "../../server/analysis/failure.ts";
import { EbayBudgetError } from "../../server/ebay/daily-budget.ts";
import { EbayAuthenticationError } from "../../server/ebay/api.ts";
import { buyerReviewFailure } from "../../shared/wait-skip-review.ts";
import { buyerReviewGlobalHold } from "../../client/src/search/useBuyerReviews.ts";

test("eBay daily, accounting and access failures stay typed across wrapped provider calls and stop the shared queue", () => {
    for (const [error, code] of [
        [new EbayBudgetError("Daily reserve protected", "QUOTA"), "EBAY_DAILY_BUDGET"],
        [new EbayBudgetError("Recorded usage unavailable", "ACCOUNTING"), "EBAY_BUDGET_ACCOUNTING"],
        [new EbayAuthenticationError("Access rejected"), "EBAY_AUTH"],
    ] as const) {
        for (const input of [error, new Error("SDK transport interrupted", { cause: error })]) {
            const failure = evaluationFailure(input);
            assert.equal(failure.status, 503);
            assert.equal(failure.code, code);
            assert.equal(failure.retryable, false);
            assert.equal(failure.scope, "search");
            assert.equal(buyerReviewGlobalHold(buyerReviewFailure(failure.code, failure.retryable, failure.scope)), code);
        }
    }
});
