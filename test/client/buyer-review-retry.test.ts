import test from "node:test";
import assert from "node:assert/strict";
import { BUYER_REVIEW_FAILURE_CODES, BUYER_REVIEW_MAX_ATTEMPTS, buyerReviewFailure, buyerReviewRetryAt, isBuyerReviewFailure } from "../../shared/wait-skip-review.ts";

test("temporary review recovery honors the actual cooldown and allows only two additional attempts", () => {
    const now = 10_000, failure = buyerReviewFailure(undefined, true);
    assert.deepEqual(failure, { code: "PROVIDER_TEMPORARY", retryable: true });
    assert.equal(buyerReviewRetryAt(failure, now + 180_000, 1, now), now + 180_000, "a long provider cooldown is never shortened");
    assert.equal(buyerReviewRetryAt(failure, now - 1, 1, now), now + 1500, "an elapsed cooldown still has a finite backoff");
    assert.equal(buyerReviewRetryAt(failure, now - 1, 2, now), now + 3000);
    assert.equal(BUYER_REVIEW_MAX_ATTEMPTS, 3);
    assert.equal(buyerReviewRetryAt(failure, now, 3, now), undefined);
    for (const invalid of [undefined, NaN, Infinity, -1]) assert.equal(buyerReviewRetryAt(failure, invalid, 1, now), undefined);
});

test("budget, held-charge, configuration, storage and permanent results never become automatic retries", () => {
    for (const code of BUYER_REVIEW_FAILURE_CODES.filter(code => code !== "PROVIDER_TEMPORARY")) {
        const failure = buyerReviewFailure(code, true);
        assert.equal(failure.retryable, false, code);
        assert.equal(buyerReviewRetryAt(failure, 20_000, 1, 10_000), undefined, code);
        assert.equal(isBuyerReviewFailure({ code, retryable: true }), false, code);
    }
    assert.equal(buyerReviewRetryAt(undefined, 20_000, 1, 10_000), undefined);
    assert.equal(buyerReviewRetryAt(buyerReviewFailure(undefined, false), 20_000, 1, 10_000), undefined);
    assert.equal(isBuyerReviewFailure({ code: "unknown", retryable: true }), false);
});
