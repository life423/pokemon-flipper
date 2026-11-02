import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { CLIENT_ROOT } from "../../server/lib/paths.ts";
import { isolatedDataDir } from "../fixtures/isolated-data.ts";
import type { AiSearchBudget } from "../../shared/ai-usage.ts";

test("search spending distinguishes settled charges and unresolved holds without treating reuse as a paid request", async t => {
    const vite = await createServer({ root: CLIENT_ROOT, configFile: false, envFile: false, cacheDir: `${isolatedDataDir}/vite-cache`,
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", logLevel: "error" });
    t.after(() => vite.close());
    const { AiBudgetStatus } = await vite.ssrLoadModule("/src/components/AiBudgetStatus.tsx");
    const budget: AiSearchBudget = { configured: true, paused: false, searchId: "offline-search", capUsd: 0.02, committedUsd: 0.006, settledUsd: 0.001,
        heldUsd: 0.005, remainingUsd: 0.014, attempts: 2, unsettledAttempts: 1 };
    const html = renderToStaticMarkup(createElement(AiBudgetStatus, { budget, calls: 2 }));
    assert.match(html, /2¢ maximum/); assert.match(html, /Reported cost/); assert.match(html, /0\.1¢/);
    assert.match(html, /Reserved \/ unresolved/); assert.match(html, /0\.5¢/); assert.match(html, /1\.4¢/);
    assert.match(html, /2 generation requests/); assert.match(html, /Unresolved requests keep their reservation/);
    assert.equal(renderToStaticMarkup(createElement(AiBudgetStatus, { budget: { ...budget, searchId: null }, calls: 0 })), "");
});
