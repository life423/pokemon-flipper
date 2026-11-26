import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { analysisBlockPolicy } from "../../client/src/search/presentation.ts";

test("guard failures show their cause once and offer a same-search manual retry", async t => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; assert.fail("rendering a blocked notice must not call providers"); });
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../client/vite.config.js", import.meta.url)), envFile: false,
        server: { middlewareMode: true, hmr: false, ws: false, watch: null }, logLevel: "error" });
    t.after(() => vite.close());
    const { AnalysisBlockedNotice, App } = await vite.ssrLoadModule("/src/App.tsx");
    const code = "AI_ACCOUNTING";
    const detail = analysisBlockPolicy(code).detail;
    const repeated = renderToStaticMarkup(createElement(AnalysisBlockedNotice, { code, message: detail, onRetry: () => {} }));
    assert.equal(repeated.split(detail).length - 1, 1);
    const exact = renderToStaticMarkup(createElement(AnalysisBlockedNotice, { code, message: "Paid AI could not durably update its spending ledger.", onRetry: () => {} }));
    assert.match(exact, /AI spending records unavailable/);
    assert.match(exact, /Paid AI could not durably update its spending ledger/);
    assert.doesNotMatch(exact, /allowance/);
    const oldAccounting = "Paid AI could not durably update its spending ledger. No new work is authorized. Cached results and screened candidates remain available.";
    const restored = renderToStaticMarkup(createElement(AnalysisBlockedNotice, { code: "AI_BUDGET", message: oldAccounting, onRetry: () => {} }));
    assert.match(restored, /data-analysis-block="AI_ACCOUNTING"/);
    assert.match(restored, /Retry when accounting is available/);
    assert.equal(restored.split(oldAccounting).length - 1, 1);
    const oldGeneric = "New analysis is stopped. Matching listings can still finish loading; retrying cannot increase this search's AI allowance.";
    const unknownCause = renderToStaticMarkup(createElement(AnalysisBlockedNotice, { code: "AI_BUDGET", message: oldGeneric, onRetry: () => {} }));
    assert.match(unknownCause, /Retry AI checks/);
    assert.doesNotMatch(unknownCause, /AI allowance/);
    for (const [code, label] of [["AI_BUDGET", "Retry AI checks"], ["AI_ACCOUNTING", "Retry when accounting is available"],
        ["AI_INPUT_PREFLIGHT", "Retry AI input check"], ["AI_PAUSED", "Retry after AI is resumed"], ["AI_CREDITS", "Retry after adding credits"], ["STORAGE_UNAVAILABLE", "Retry when storage is available"], ["PRICE_RESEARCH_UNAVAILABLE", "Retry when accounting is available"],
        ["PRICE_RESEARCH_BUDGET", "Retry with current request policy"], ["EBAY_DAILY_BUDGET", "Retry after quota resets"],
        ["EBAY_BUDGET_ACCOUNTING", "Retry when accounting is available"], ["EBAY_AUTH", "Retry after fixing eBay access"]] as const) {
        const html = renderToStaticMarkup(createElement(AnalysisBlockedNotice, { code, message: "Temporary availability problem.", onRetry: () => {} }));
        assert.match(html, new RegExp(`<button[^>]*>${label}</button>`));
        assert.doesNotMatch(html, /Resume AI analysis/);
    }
    assert.equal(analysisBlockPolicy("PRICE_RESEARCH_BUDGET").stopListingStream, true);
    assert.equal(analysisBlockPolicy("PRICE_RESEARCH_UNAVAILABLE").stopListingStream, true);
    const app = renderToStaticMarkup(createElement(App));
    const views = app.match(/<div[^>]*aria-label="Show">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(views, "the result views remain present before a search");
    assert.match(views, /^<button[^>]*aria-pressed="true"[^>]*><span[^>]*data-view="deals"/);
    assert.equal(requests, 0);
});
