import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCliResearchScope } from "../scripts/review/research-scope.ts";
import { getAiUsageContext, withAiUsageContext } from "../server/ai/usage-context.ts";
import { createSearchBrowseBudget } from "../server/ebay/search-budget.ts";

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

test("a later CLI stage cannot acquire a new allowance after this command spends25 Browse reservations", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-cli-scope-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const budget = createSearchBrowseBudget({ directory });
    const command = createCliResearchScope();
    let dailyReservations = 0;
    const reserve = () => budget.reserve(getAiUsageContext().searchId, async () => { dailyReservations++; });
    await command(() => Promise.all(Array.from({ length: 25 }, reserve)));
    await assert.rejects(command(reserve), /25-request.*cap/);
    assert.equal(dailyReservations, 25);
    await createCliResearchScope()(reserve);
    assert.equal(dailyReservations, 26, "a new explicit command has its own cap");
});
