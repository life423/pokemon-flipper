import { test } from "node:test";
import assert from "node:assert/strict";
import { underwrite } from "../../shared/money/underwriting.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
test("nonfinite/negative acquisition terms cannot manufacture a deal or a numerical buy limit", () => {
    for (const [price, shipping] of [[NaN, 0], [Infinity, 0], [-100, 0], [10, -100], [10, Infinity], [10, NaN]]) {
        const evaluation = cardEvaluation();
        const result = underwrite({ ...evaluation, listing: { price, shipping } });
        assert.equal(result.verdict, "CANT_PRICE"); assert.equal(result.best, null);
    }
});
