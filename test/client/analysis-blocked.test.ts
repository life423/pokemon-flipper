import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { analysisBlockPolicy } from "../../client/src/search/presentation.ts";

test("server AI pauses and spending blocks have no impossible resume control; recoverable failures have explicit retry labels", async t => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; assert.fail("rendering a blocked notice must not call providers"); });
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../client/vite.config.js", import.meta.url)), envFile: false,
        server: { middlewareMode: true, hmr: false, ws: false, watch: null }, logLevel: "error" });
    t.after(() => vite.close());
    const { AnalysisBlockedNotice, App } = await vite.ssrLoadModule("/src/App.tsx");
    for (const code of ["AI_PAUSED", "AI_BUDGET", "PRICE_RESEARCH_BUDGET"] as const) {
        const html = renderToStaticMarkup(createElement(AnalysisBlockedNotice, { code, message: "Backend guard blocked this task.", onRetry: () => assert.fail("cannot retry a persistent guard") }));
        assert.match(html, code === "PRICE_RESEARCH_BUDGET" ? /New assessments are paused/ : /New analysis is stopped/);
        assert.match(html, new RegExp(`data-analysis-block="${code}"`));
        assert.doesNotMatch(html, /<button|Resume AI analysis/);
        assert.equal(analysisBlockPolicy(code).retryLabel, null);
    }
    for (const [code, label] of [["AI_CREDITS", "Retry after adding credits"], ["STORAGE_UNAVAILABLE", "Retry when storage is available"], ["PRICE_RESEARCH_UNAVAILABLE", "Retry when accounting is available"]] as const) {
        const html = renderToStaticMarkup(createElement(AnalysisBlockedNotice, { code, message: "Temporary availability problem.", onRetry: () => {} }));
        assert.match(html, new RegExp(`<button[^>]*>${label}</button>`));
        assert.doesNotMatch(html, /Resume AI analysis/);
    }
    assert.equal(analysisBlockPolicy("PRICE_RESEARCH_BUDGET").stopListingStream, false);
    assert.equal(analysisBlockPolicy("PRICE_RESEARCH_UNAVAILABLE").stopListingStream, true);
    const app = renderToStaticMarkup(createElement(App));
    const views = app.match(/<div[^>]*aria-label="Show">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(views, "the result views remain present before a search");
    assert.match(views, /^<button[^>]*aria-pressed="true"[^>]*>[\s\S]*?All matching/);
    assert.equal(requests, 0);
});
