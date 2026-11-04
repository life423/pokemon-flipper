import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { CLIENT_ROOT } from "../../server/lib/paths.ts";
import { isolatedDataDir } from "../fixtures/isolated-data.ts";
import type { ProviderUsageSnapshot } from "../../shared/provider-usage.ts";

test("daily usage warnings distinguish provider quota from dollars, stay visible outside the drawer, and need no provider calls", async t => {
    t.mock.method(globalThis, "fetch", async () => assert.fail("quota warnings must use existing telemetry"));
    const vite = await createServer({ root: CLIENT_ROOT, configFile: false, envFile: false, cacheDir: `${isolatedDataDir}/quota-usage-vite-cache`,
        optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", logLevel: "error" });
    t.after(() => vite.close());
    const { ProviderUsageNotice } = await vite.ssrLoadModule("/src/components/ProviderUsageNotice.tsx");
    const base: ProviderUsageSnapshot = { provider: "EBAY", label: "eBay", limit: 5000, remaining: 900,
        observedAt: "2026-11-04T16:00:00Z", resetsAt: "2026-11-05T00:00:00Z", usedInWindow: 300, windowMinutes: 15, warning: "LOW_AND_FAST" };
    const now = Date.parse(base.observedAt) + 1000;
    const html = renderToStaticMarkup(createElement(ProviderUsageNotice, { now, usage: [base,
        { ...base, provider: "PKMNPRICES", label: "PKMNPrices", limit: 20000, remaining: 18000, usedInWindow: 1500, warning: "FAST" }] }));
    assert.match(html, /role="alert"/);
    assert.match(html, /eBay: daily allowance is low and being used quickly/);
    assert.match(html, /900 of 5,000 daily requests left/);
    assert.match(html, /At least 300 requests used over an observed window of 15 minutes/);
    assert.match(html, /PKMNPrices: daily allowance is being used quickly/);
    assert.match(html, /18,000 of 20,000 daily credits left/);
    assert.doesNotMatch(html, /\$|paid|AI budget/);
    assert.equal(renderToStaticMarkup(createElement(ProviderUsageNotice, {})), "");
    assert.equal(renderToStaticMarkup(createElement(ProviderUsageNotice, { now, usage: [{ ...base, warning: null }] })), "");
    assert.equal(renderToStaticMarkup(createElement(ProviderUsageNotice, { now: now + 15 * 60_000, usage: [base] })), "", "stale warning cannot imply current quota");
    assert.equal(renderToStaticMarkup(createElement(ProviderUsageNotice, { now: Date.parse(base.resetsAt), usage: [base] })), "", "expired period clears even while idle");
    const low = renderToStaticMarkup(createElement(ProviderUsageNotice, { now, usage: [{ ...base, warning: "LOW", usedInWindow: null }] }));
    assert.match(low, /daily allowance is running low/);
    assert.doesNotMatch(low, /used over an observed/);
    const burst = renderToStaticMarkup(createElement(ProviderUsageNotice, { now, usage: [{ ...base, warning: "FAST", windowMinutes: 5 / 60 }] }));
    assert.match(burst, /observed window of 1 minute/);
    assert.doesNotMatch(burst, /0\.083333/);
    const olderBurst = renderToStaticMarkup(createElement(ProviderUsageNotice, { now: now + 12 * 60_000,
        usage: [{ ...base, warning: "FAST", windowMinutes: 1 }] }));
    assert.match(olderBurst, /observed window of 1 minute/);
    assert.doesNotMatch(olderBurst, /last 1 minute/, "an older retained burst is not current one-minute consumption");
});
