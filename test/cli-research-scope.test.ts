import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCliResearchScope } from "../scripts/review/research-scope.ts";
import { getAiUsageContext, withAiUsageContext } from "../server/ai/usage-context.ts";
import { createSearchBrowseBudget } from "../server/ebay/search-budget.ts";
import { createDailyBrowseBudget } from "../server/ebay/daily-budget.ts";

test("one CLI command retains its research ID through nested, parallel and later follow-up work", async () => {
    const command = createCliResearchScope();
    const first = command(() => getAiUsageContext().searchId);
    assert.ok(first);
    assert.match(first, /^[a-zA-Z0-9_-]{1,80}$/);
    const concurrent = await command(() => Promise.all(["one", "two"].map(listingId => withAiUsageContext({ listingId }, async () => {
        await Promise.resolve();
        return getAiUsageContext();
    }))));
    assert.deepEqual(concurrent, [{ searchId: first, listingId: "one" }, { searchId: first, listingId: "two" }]);
    assert.equal(command(() => getAiUsageContext().searchId), first);
    assert.deepEqual(getAiUsageContext(), {});
    assert.notEqual(createCliResearchScope()(() => getAiUsageContext().searchId), first);
});

test("CLI follow-up and new commands honor the same daily Browse reserve", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-cli-scope-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const budget = createSearchBrowseBudget({ directory });
    const daily = createDailyBrowseBudget({ file: path.join(directory, "daily.json") });
    const observed = { used: 0, limit: 4, remaining: 4, resetsAt: new Date(Date.now() + 3600_000).toISOString(), braking: false };
    const command = createCliResearchScope();
    const reserve = () => budget.reserve(getAiUsageContext().searchId, async () => { await daily(observed); });
    await command(() => Promise.all(Array.from({ length: 3 }, reserve)));
    await assert.rejects(command(reserve), { code: "EBAY_DAILY_BUDGET" });
    await assert.rejects(createCliResearchScope()(reserve), { code: "EBAY_DAILY_BUDGET" });
    assert.equal((await command(() => budget.status(getAiUsageContext().searchId)))?.used, 3);
    assert.equal((await daily(observed, { consume: false })).remaining, 1);
});
