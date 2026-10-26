import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewBudget } from "../scripts/review/request-budget.ts";

test("review transport caps block before spending another provider request, including retry attempts", () => {
    const budget = new ReviewBudget({ ai: 2, ebayBrowse: 1, prices: 1 });
    budget.reserve("ai", "one"); budget.reserve("ai", "one");
    assert.throws(() => budget.reserve("ai", "two"), /request was not sent/);
    budget.reserve("ebayBrowse", "one");
    assert.throws(() => budget.reserve("ebayBrowse", "two"), /ebayBrowse total cap/);
    assert.deepEqual(budget.used, { ai: 2, ebayBrowse: 1, prices: 0 });
});
test("discovery caps share the global AI ceiling but are counted separately per query", () => {
    const budget = new ReviewBudget({ ai: 10, ebayBrowse: 1, prices: 1 }, 1);
    budget.reserve("ai", "one", "photo_discovery");
    assert.throws(() => budget.reserve("ai", "one", "photo_discovery"), /discovery photo cap/);
    budget.reserve("ai", "two", "photo_discovery");
    budget.reserve("ai", "one", "photo_check");
    assert.equal(budget.used.ai, 3);
    assert.equal(budget.blocked["new discovery photo cap"], 1);
});
