import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDailyBrowseBudget, EbayBudgetError } from "../../server/ebay/daily-budget.ts";
import { ebayGet } from "../../server/ebay/api.ts";
import { ebayUsage } from "../../server/ebay/usage.ts";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";
import type { EbayUsage } from "../../shared/types.ts";

const snapshot = (limit: number, remaining = limit): EbayUsage => ({ limit, remaining, used: limit - remaining, resetsAt: new Date(Date.now() + 3600000).toISOString(), braking: false });
async function temporary(t: any) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-quota-test-")), file = path.join(folder, "quota.json");
    t.after(async () => { await fs.unlink(file).catch(() => {}); await fs.rmdir(folder); });
    return file;
}
test("independent instances cannot overdraw a shared daily quota under 100 concurrent reservations", async t => {
    const file = await temporary(t), a = createDailyBrowseBudget({ file }), b = createDailyBrowseBudget({ file });
    const observed = snapshot(7);
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => (index % 2 ? a : b)(observed)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 7);
    assert.ok(results.filter(result => result.status === "rejected").every(result => result.reason instanceof EbayBudgetError),
        JSON.stringify(results.filter(result => result.status === "rejected" && !(result.reason instanceof EbayBudgetError)).map(result => String(result.reason))));
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).used, 7);
    assert.equal((await b(observed, false, false)).remaining, 0, "a stale Analytics sample cannot refill the displayed allowance");
    await assert.rejects(createDailyBrowseBudget({ file })(observed), /daily allowance/, "restart cannot reset the counter");
});
test("the optional reserve, provider high-water usage and real reset are respected", async t => {
    const file = await temporary(t); let at = Date.now(); const reserve = createDailyBrowseBudget({ file, now: () => at });
    const observed = snapshot(10, 2);
    assert.equal((await reserve(observed, true)).remaining, 1);
    await assert.rejects(reserve(observed, true), /Saving/);
    assert.equal((await reserve(observed)).remaining, 0);
    await assert.rejects(reserve(observed), /daily allowance/);
    at = Date.parse(observed.resetsAt!) + 1;
    const nextDay = { ...snapshot(10), resetsAt: new Date(at + 3600000).toISOString() };
    assert.equal((await reserve(nextDay)).remaining, 9);
});
test("invalid accounting fails closed without sending requests", async t => {
    const file = await temporary(t);
    await assert.rejects(createDailyBrowseBudget({ file })({ ...snapshot(10), remaining: NaN }), /invalid/);
    await fs.writeFile(file, '{}');
    await assert.rejects(createDailyBrowseBudget({ file })(snapshot(10)), /invalid/);
});
test("the Browse transport enforces the allowance even for direct nested API calls", async t => {
    offlineEbayCredentials(t); let browse = 0;
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (String(url).includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (String(url).includes("rate_limit")) return Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse", rates: [{ count: 5, limit: 5, remaining: 0, reset: snapshot(5).resetsAt }] }] }] });
        browse++; return Response.json({});
    });
    await ebayUsage({ fresh: true });
    await assert.rejects(ebayGet("/buy/browse/v1/item/direct-nested-request"), /daily allowance/);
    assert.equal(browse, 0);
});
