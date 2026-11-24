import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";
import { GRADING_WATCH_DURATION_MS, GRADING_WATCH_INTERVAL_MS } from "../../shared/grading-watch.ts";
import { getAiUsageContext, getBudgetContext, withAiUsageContext } from "../../server/ai/usage-context.ts";
import { newWatchScanId, streamNewDeals } from "../../client/src/api.ts";

test("a watch claims at most two visible, idle checks in half an hour and announces a copy only once", async t => {
    const vite = await createServer({ configFile: path.resolve("client/vite.config.js"), envFile: false, appType: "custom", logLevel: "silent",
        server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => vite.close());
    const { startGradingWatch, takeWatchCheck, rememberGradingAlerts } = await vite.ssrLoadModule("/src/components/GradingWatch.tsx");
    const now = Date.now();
    const first = startGradingWatch(now);
    assert.equal(takeWatchCheck(first, now, true), null);
    assert.equal(takeWatchCheck(first, first.next, false), null);
    const second = takeWatchCheck(first, first.next, true);
    assert.equal(second.checks, 1);
    assert.equal(takeWatchCheck(second, first.next, true), null);
    const done = takeWatchCheck(second, now + 2 * GRADING_WATCH_INTERVAL_MS, true);
    assert.equal(done.checks, 2);
    assert.equal(takeWatchCheck(done, now + GRADING_WATCH_DURATION_MS - 1, true), null);
    assert.equal(takeWatchCheck(first, now + GRADING_WATCH_DURATION_MS, true), null);
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k), setItem: (k: string, v: string) => map.set(k, v) };
    assert.deepEqual(rememberGradingAlerts(["a", "a", "b"], now, storage), ["a", "b"]);
    assert.deepEqual(rememberGradingAlerts(["a", "c"], now + 1, storage), ["c"]);
});

test("a watch keeps the original allowance through successive discovery IDs and nested listing work", async t => {
    const owner = crypto.randomUUID(), first = newWatchScanId(owner), second = newWatchScanId(first);
    assert.notEqual(owner, first); assert.notEqual(first, second);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
        calls++;
        const headers = new Headers(init.headers);
        assert.equal(headers.get("X-Pokemon-Flipper-Watch-Budget"), owner);
        assert.equal(headers.get("X-Pokemon-Flipper-Search-Id"), second);
        assert.equal(JSON.parse(String(init.body)).gradingWatch, true);
        return new Response(JSON.stringify({ type: "done" }) + "\n");
    });
    await streamNewDeals("raw holo", { minPrice: 0, targets: { minProfit: 25, minRoi: 0.2 }, includeOffers: false,
        knownIds: ["already-assessed"], gradingWatch: true, searchRunId: second }, () => {});
    assert.equal(calls, 1);
    withAiUsageContext({ searchId: second, watchBudgetId: owner }, () => withAiUsageContext({ searchId: first, listingId: "copy" }, () => {
        assert.equal(getAiUsageContext().searchId, first);
        assert.deepEqual(getBudgetContext(), { searchId: owner, listingId: "copy" });
    }));
});
