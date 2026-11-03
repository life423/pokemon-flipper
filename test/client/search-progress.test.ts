import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

// Vite handles the real TSX/CSS modules in middleware mode: no listening app,
// browser request or provider is involved in these progress-state regressions.
test("AI assessment progress is visible throughout searching and respects pause, Stop and failures", async t => {
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../client/vite.config.js", import.meta.url)),
        server: { middlewareMode: true, hmr: false, ws: false, watch: null }, logLevel: "error" });
    t.after(() => vite.close());
    const { SearchProgress } = await vite.ssrLoadModule("/src/components/SearchProgress.tsx");
    const defaults = { phase: "filtering", query: "1999 base set holo", error: null, ebayTotal: 1000, checked: 25, total: 100,
        ai: { done: 5, target: 20, analyzing: 3, waiting: 12, failed: 1 },
        stats: { junk: 0, dropped: 0, unchecked: 0, deals: 1 }, usage: null, onStop: () => {} };
    const render = (change: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(SearchProgress, { ...defaults, ...change }));
    const status = (markup: string) => markup.match(/<div[^>]+data-ai-state="([^"]+)"[^>]*>([\s\S]*?)<\/div>/)!;
    for (const phase of ["finding", "filtering", "ai"]) {
        const markup = render({ phase });
        const [, state, content] = status(markup);
        assert.equal(state, "working");
        assert.match(content, /AI assessing 3 cards/);
        assert.match(content, /4 completed/);
        assert.match(content, /1 failed/);
        assert.ok(markup.indexOf('data-ai-state="working"') < markup.indexOf('inert=""'), "the indicator is outside collapsed details");
    }
    assert.match(status(render({ ai: { ...defaults.ai, analyzing: 1 } }))[2], /AI assessing 1 card</);
    for (const [phase, paused, expected] of [["filtering", true, "paused"], ["paused", true, "paused"], ["stopped", true, "stopped"], ["done", false, "idle"]] as const) {
        const [, state, content] = status(render({ phase, ai: { ...defaults.ai, analyzing: phase === "done" ? 0 : 3, paused } }));
        assert.equal(state, expected);
        assert.doesNotMatch(content, /AI assessing|aria-hidden/);
        assert.match(content, /4 completed/);
    }
    for (const phase of ["finding", "filtering"]) {
        const metadataContinues = render({ phase, ai: { ...defaults.ai, analyzing: 1, paused: true } });
        assert.match(metadataContinues, new RegExp(`data-phase="${phase}"`));
        assert.equal(status(metadataContinues)[1], "paused");
        assert.match(status(metadataContinues)[2], /AI analysis paused/);
        assert.match(status(metadataContinues)[2], /1 in progress/);
        assert.match(metadataContinues, /aria-label="Stop search"/);
        assert.match(metadataContinues, /role="progressbar"/);
        assert.match(metadataContinues, /Listing checks are still running/);
        assert.doesNotMatch(metadataContinues, /New checks are stopped|Analysis paused:|AI assessing/);
    }
    const budgetPaused = render({ phase: "paused", ai: { ...defaults.ai, analyzing: 0, paused: true } });
    assert.match(budgetPaused, /Analysis paused:/);
    assert.doesNotMatch(budgetPaused, /Done:|data-state="complete"|role="progressbar"|Scanning listings|\d+%/);
    const pendingBudget = render({ phase: "paused", ai: { done: 2, target: 47, analyzing: 0, waiting: 45, failed: 0, paused: true },
        stats: { junk: 0, dropped: 0, unchecked: 45, deals: 0 } });
    assert.match(status(pendingBudget)[2], /2 completed/);
    assert.match(status(pendingBudget)[2], /45 awaiting analysis/);
    assert.doesNotMatch(status(pendingBudget)[2], /failed/);
    assert.match(pendingBudget, /Screening incomplete/);
    assert.doesNotMatch(pendingBudget, /Couldn&#x27;t verify|Couldn't verify/);
    const mixedPause = render({ phase: "paused", ai: { done: 5, target: 53, analyzing: 3, waiting: 45, failed: 2, paused: true },
        stats: { junk: 0, dropped: 0, unchecked: 49, deals: 0 } });
    assert.match(status(mixedPause)[2], /3 completed/);
    assert.match(status(mixedPause)[2], /45 awaiting analysis/);
    assert.match(status(mixedPause)[2], /3 in progress/);
    assert.match(status(mixedPause)[2], /2 failed/);
    const phasePaused = render({ phase: "paused", checked: 2, total: 3, ai: { ...defaults.ai, paused: false } });
    assert.match(status(phasePaused)[2], /AI analysis paused/);
    assert.doesNotMatch(phasePaused, /AI assessing|role="progressbar"|67%/);
    const [, idleState, idle] = status(render({ phase: "finding", ai: { done: 0, target: 0, analyzing: 0, waiting: 0, failed: 0 } }));
    assert.equal(idleState, "idle"); assert.match(idle, /No full card assessments running/); assert.match(idle, /0 completed/);

    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "0" } });
    try {
        const expanded = render();
        assert.ok(!expanded.includes('inert=""'));
        assert.match(status(expanded)[2], /AI assessing 3 cards/);
        assert.match(expanded, /Results appear as each assessment finishes/);
        const expandedPause = render({ phase: "paused", checked: 2, total: 3, ai: { ...defaults.ai, paused: true } });
        assert.match(expandedPause, /New checks are stopped/);
        assert.match(expandedPause, /New AI assessments are paused/);
        assert.doesNotMatch(expandedPause, /Scanning listings|Searching eBay|role="progressbar"|67%|AI assessing|class="[^"]*(?:dots|indeterminate)/);
        const expandedBudget = render({ phase: "paused", ai: { done: 2, target: 47, analyzing: 0, waiting: 45, failed: 0, paused: true },
            stats: { junk: 0, dropped: 0, unchecked: 45, deals: 0 } });
        assert.match(expandedBudget, /45 listings await AI assessment/);
        assert.match(expandedBudget, /These listings have not failed verification/);
    } finally {
        if (previous) Object.defineProperty(globalThis, "localStorage", previous);
        else Reflect.deleteProperty(globalThis, "localStorage");
    }
});
