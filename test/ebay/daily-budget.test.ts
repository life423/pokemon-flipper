import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDailyBrowseBudget, paceBrowse, EbayBudgetError, ebayBudgetFailure } from "../../server/ebay/daily-budget.ts";
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
test("independent instances preserve the shared reserve under 100 concurrent reservations", async t => {
    const file = await temporary(t), a = createDailyBrowseBudget({ file }), b = createDailyBrowseBudget({ file });
    const observed = snapshot(7);
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => (index % 2 ? a : b)(observed)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 6);
    assert.ok(results.filter(result => result.status === "rejected").every(result => ebayBudgetFailure(result.reason)?.code === "EBAY_DAILY_BUDGET"),
        JSON.stringify(results.filter(result => result.status === "rejected" && !(result.reason instanceof EbayBudgetError)).map(result => String(result.reason))));
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).used, 6);
    const status = await b(observed, { consume: false });
    assert.equal(status.remaining, 1, "a stale Analytics sample cannot refill the displayed allowance");
    assert.equal(status.braking, true, "the reserve rounds up for nonmultiples of 10");
    await assert.rejects(createDailyBrowseBudget({ file })(observed), { code: "EBAY_DAILY_BUDGET" }, "restart cannot reset the counter");
});
test("an old daily quota lock stays owned after a suspended process exceeds the lease wait", async t => {
    const file = await temporary(t), lock = `${file}.lock`;
    const at = Date.now(), suspendedAt = new Date(at - 45_000);
    await fs.writeFile(lock, "suspended-owner");
    await fs.utimes(lock, suspendedAt, suspendedAt);
    let timeRead = false;
    t.mock.method(Date, "now", () => {
        if (timeRead) return at + 11_000;
        timeRead = true;
        return at;
    });
    try {
        await assert.rejects(createDailyBrowseBudget({ file, now: () => at })(null), /quota accounting is busy/);
        assert.equal(await fs.readFile(lock, "utf8"), "suspended-owner");
        await assert.rejects(fs.access(file), { code: "ENOENT" });
    } finally { await fs.unlink(lock).catch(() => {}); }
});
test("the reserve, provider high-water usage and real reset are respected", async t => {
    const file = await temporary(t); let at = Date.now(); const reserve = createDailyBrowseBudget({ file, now: () => at });
    const observed = snapshot(10, 2);
    assert.equal((await reserve(observed)).remaining, 1);
    await assert.rejects(reserve(observed), { code: "EBAY_DAILY_BUDGET" });
    at = Date.parse(observed.resetsAt!) + 1;
    const nextDay = { ...snapshot(10), resetsAt: new Date(at + 3600000).toISOString() };
    assert.equal((await reserve(nextDay)).remaining, 9);
});
test("typed eBay holds survive wrapping and cyclic error causes", () => {
    const hold = new EbayBudgetError("Daily reserve", "QUOTA");
    assert.equal(ebayBudgetFailure(new Error("Lookup failed", { cause: hold })), hold);
    const cycle = new Error("Cycle"); cycle.cause = cycle;
    assert.equal(ebayBudgetFailure(cycle), null);
});
test("invalid accounting fails closed without sending requests", async t => {
    const file = await temporary(t);
    await assert.rejects(createDailyBrowseBudget({ file })({ ...snapshot(10), remaining: NaN }), /invalid/);
    for (const invalid of ["{}", "null", "0"]) {
        await fs.writeFile(file, invalid);
        await assert.rejects(createDailyBrowseBudget({ file })(snapshot(10)), { code: "EBAY_BUDGET_ACCOUNTING" });
        assert.equal(await fs.readFile(file, "utf8"), invalid);
    }
});
test("the Browse transport preserves the daily reserve even for direct nested API calls", async t => {
    offlineEbayCredentials(t); let browse = 0;
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (String(url).includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (String(url).includes("rate_limit")) return Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse", rates: [{ count: 4, limit: 5, remaining: 1, reset: snapshot(5).resetsAt }] }] }] });
        browse++; return Response.json({});
    });
    await ebayUsage({ fresh: true });
    await assert.rejects(ebayGet("/buy/browse/v1/item/direct-nested-request"), { code: "EBAY_DAILY_BUDGET" });
    assert.equal(browse, 0);
});

test("two callers share the pace under high Browse usage, and a cancelled wait spends no slot", async t => {
    const file = await temporary(t);
    let at = Date.parse("2026-11-25T20:00:00Z");
    const snapshot = { provider: "EBAY", label: "eBay Browse", limit: 5000, remaining: 4250,
        usedInWindow: 53, windowMinutes: 15, warning: null, observedAt: new Date(at).toISOString(),
        resetsAt: new Date(at + 10 * 3600000).toISOString() } as const;
    const first = () => assert.fail("the first dispatch is immediate");
    await paceBrowse(file, snapshot, undefined, () => at, first);
    const before = await fs.readFile(file, "utf8");
    const cancel = new AbortController();
    await assert.rejects(paceBrowse(file, snapshot, cancel.signal, () => at, async () => { cancel.abort(); }), { name: "AbortError" });
    assert.equal(await fs.readFile(file, "utf8"), before);
    const sleeps: number[] = [];
    await paceBrowse(file, snapshot, undefined, () => at, async ms => { sleeps.push(ms); at += ms; });
    assert.deepEqual(sleeps, [9600]);
});
