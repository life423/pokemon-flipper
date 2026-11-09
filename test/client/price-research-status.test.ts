import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { CLIENT_ROOT } from "../../server/lib/paths.ts";
import { isolatedDataDir } from "../fixtures/isolated-data.ts";
import type { PricingResearchUsage } from "../../shared/pricing-usage.ts";

test("price research distinguishes requests, provider credits and incomplete accounting without provider work", async t => {
    t.mock.method(globalThis, "fetch", async () => assert.fail("usage rendering must not call a provider"));
    const vite = await createServer({ root: CLIENT_ROOT, configFile: false, envFile: false, cacheDir: `${isolatedDataDir}/price-usage-vite-cache`,
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", logLevel: "error" });
    t.after(() => vite.close());
    const { PriceResearchStatus } = await vite.ssrLoadModule("/src/components/PriceResearchStatus.tsx");
    const usage: PricingResearchUsage = { searchId: "offline-search", limit: 64, used: 9, remaining: 55,
        completed: 7, pending: 1, unresolved: 1, reportedCredits: 106, unreportedCreditAttempts: 3,
        returnedRows: 123, unreportedRowAttempts: 2,
        provider: { limit: 20_000, remaining: 19_872, balance: null, resetSeconds: 1000 } };
    const html = renderToStaticMarkup(createElement(PriceResearchStatus, { usage }));
    assert.match(html, /9 \/ 64/);
    assert.match(html, /Reported credits <b>106<\/b>/);
    assert.match(html, /106<\/b> \+ unknown/);
    assert.match(html, /Last provider report: <b>19,872<\/b> daily credits left/);
    assert.match(html, /2<\/b> requests awaiting full accounting/);
    assert.match(html, /Credit usage is incomplete for 3 requests/);
    assert.match(html, /separately from the OpenAI budget/);
    assert.doesNotMatch(html, /\$|123 credits/);
    const unknown = renderToStaticMarkup(createElement(PriceResearchStatus, { usage: { ...usage, provider: null } }));
    assert.doesNotMatch(unknown, /daily credits left/);
    assert.match(unknown, /incomplete for 3 requests/);
    const noHeaders = renderToStaticMarkup(createElement(PriceResearchStatus, { usage: { ...usage, provider: null, reportedCredits: 0, unreportedCreditAttempts: 9 } }));
    assert.match(noHeaders, /Reported credits <b>Not reported<\/b>/);
    const confirmedFree = renderToStaticMarkup(createElement(PriceResearchStatus, { usage: { ...usage, reportedCredits: 0, unreportedCreditAttempts: 0 } }));
    assert.match(confirmedFree, /Reported credits <b>0<\/b>/);
    assert.equal(renderToStaticMarkup(createElement(PriceResearchStatus, { usage: null })), "");
});
