import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { AiUsageDay, HuntProgress } from "../../shared/ai-usage.ts";
import { fetchAiUsage, restoreWatchBudget } from "../../client/src/api.ts";

test("hunt progress reports current observations and keeps timers out of the live announcement", async t => {
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../client/vite.config.js", import.meta.url)),
        envFile: false, appType: "custom", logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
    t.after(() => vite.close());
    const { HuntProgressPanel } = await vite.ssrLoadModule("/src/components/DealHunt.tsx");
    const startedAt = Date.now() - 8000;
    const hunt: HuntProgress = { searchId: "hunt", phase: "reviewing", action: "inspect_photos", cohort: "Charizard Base Set",
        startedAt: new Date(startedAt + 2).toISOString(), updatedAt: new Date(startedAt + 3000).toISOString(),
        discovered: 80, screened: 12, retained: 3, reviewed: 1, photos: 1, scans: 1 };
    const usage: AiUsageDay = { dayUtc: "2026-11-25", searchId: "hunt", calls: 7, stages: [{ step: "Inspect photos", model: "fixture",
        calls: 7, failed: 0, images: 4, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }] };
    const render = (snapshot?: HuntProgress, account = usage) => renderToStaticMarkup(createElement(
        HuntProgressPanel, { searchId: "hunt", startedAt, usage: { ...account, hunt: snapshot }, onStop() {} },
    ));

    const active = render(hunt);
    assert.match(active, /role="progressbar" aria-label="Hunt activity"/);
    assert.match(active, /<h2[^>]*>Reading the listing photos<\/h2>/);
    assert.match(active, /Charizard Base Set/);
    assert.match(render({ ...hunt, guidance: "The last copy had a crease. Check the next photographed copy." }), /last copy had a crease/);
    assert.match(active, /80 listings found · 12 pricing checks · 3 candidates · 1 copy checked · 1 copy with photos checked/);
    const announced = active.match(/role="status"[^>]*>(.*?)<\/div>/)?.[1] ?? "";
    assert.match(announced, /Reading the listing photos/);
    assert.doesNotMatch(announced, /Elapsed|Last activity/);
    assert.match(active, /Elapsed \d+s · Last activity (just now|\d+s ago)/);
    assert.doesNotMatch(active, /aria-valuenow|\d+%|Max item price/);
    assert.match(render({ ...hunt, phase: "pricing", action: "find_listings" }), /Comparing recent sales/);
    assert.match(render({ ...hunt, phase: "discovering", action: "find_listings" }), /Finding matching listings/);
    assert.match(render({ ...hunt, action: "resolve_printing" }), /Checking the printing marks/);
    assert.doesNotMatch(render({ ...hunt, discovered: 0 }), /0 listings found/);

    for (const stale of [{ ...hunt, searchId: "other" }, { ...hunt, startedAt: new Date(startedAt - 60_000).toISOString() }]) {
        const fallback = render(stale);
        assert.doesNotMatch(fallback, /Charizard Base Set|copies checked|Last activity/);
        assert.match(fallback, /Recorded for this search · 7 AI requests logged · 4 images submitted for analysis/);
    }
    assert.doesNotMatch(render(undefined, { ...usage, searchId: "other" }), /7 AI requests logged/);
    const held = render({ ...hunt, phase: "failed", completedAt: hunt.updatedAt });
    assert.match(held, /Hunt interrupted/);
    assert.doesNotMatch(held, /role="progressbar"/);
    assert.doesNotMatch(held, /Reading the listing photos|>Stop<\/button>/);
});

test("a watch hunt requests progress for the child while retaining the original usage account", async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const paths: string[] = [];
    globalThis.fetch = async input => {
        paths.push(String(input));
        return Response.json({ dayUtc: "2026-11-25", calls: 0, stages: [] });
    };
    const root = "11111111-2222-4333-8444-555555555555";
    const child = "22222222-3333-4444-8555-666666666666";
    restoreWatchBudget(child, root);
    await fetchAiUsage(child, child);
    await fetchAiUsage(root, root);
    await fetchAiUsage();
    assert.deepEqual(paths, [
        `/api/ai-usage?searchId=${root}&huntId=${child}`,
        `/api/ai-usage?searchId=${root}`,
        "/api/ai-usage",
    ]);
});
