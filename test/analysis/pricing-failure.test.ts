import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluationFailure } from "../../server/analysis/failure.ts";
import { PriceResearchBudgetError } from "../../server/pricing/research-budget.ts";

test("local price guards stay separate from exhausted AI credits and transient provider retries", () => {
    assert.deepEqual(evaluationFailure(new PriceResearchBudgetError("Search allowance reached", "LIMIT")), {
        status: 503, code: "PRICE_RESEARCH_BUDGET", error: "Search allowance reached", retryable: false,
    });
    for (const reason of ["SCOPE", "ACCOUNT", "STORAGE", "LOCK", "STATE"] as const) {
        const result = evaluationFailure(new PriceResearchBudgetError("Price accounting unavailable", reason));
        assert.equal(result.code, "PRICE_RESEARCH_UNAVAILABLE");
        assert.equal(result.retryable, false);
        assert.equal(result.status, 503);
        assert.equal("retryAfterMs" in result, false);
    }
});
