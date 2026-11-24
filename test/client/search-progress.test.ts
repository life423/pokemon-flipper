import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

// Vite handles the real TSX/CSS modules in middleware mode: no listening app,
// browser request or provider is involved in these progress-state regressions.
test("compact photo progress distinguishes loaded listings, completed assessments, pause, Stop and failures", async t => {
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../client/vite.config.js", import.meta.url)),
        server: { middlewareMode: true, hmr: false, ws: false, watch: null }, logLevel: "error" });
    t.after(() => vite.close());
    const { SearchProgress } = await vite.ssrLoadModule("/src/components/SearchProgress.tsx");
    const defaults = { phase: "filtering", query: "1999 base set holo", error: null, ebayTotal: 1000, checked: 25, total: 100,
        ai: { done: 5, target: 20, analyzing: 3, waiting: 12, failed: 1 },
        stats: { junk: 0, dropped: 0, unchecked: 0, deals: 1 }, usage: null, onStop: () => {}, canStopAssessment: false };
    const render = (change: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(SearchProgress, { ...defaults, ...change }));
    const status = (markup: string) => markup.match(/<div[^>]+data-ai-state="([^"]+)"[^>]*>([\s\S]*?)<\/div>/)!;
    for (const phase of ["finding", "filtering", "ai"]) {
        const markup = render({ phase });
        const [, state, content] = status(markup);
        assert.equal(state, "working");
        assert.match(content, /Reviewing 3 cards/);
        assert.match(markup, /25 listings loaded · 4 assessments completed/);
        assert.match(content, /1 failed/);
        assert.ok(markup.indexOf('data-ai-state="working"') < markup.indexOf('inert=""'), "the indicator is outside collapsed details");
    }
    assert.match(status(render({ ai: { ...defaults.ai, analyzing: 1 } }))[2], /Reviewing 1 card</);
    for (const [phase, paused, expected] of [["filtering", true, "paused"], ["paused", true, "paused"], ["stopped", true, "stopped"]] as const) {
        const [, state, content] = status(render({ phase, ai: { ...defaults.ai, analyzing: phase === "done" ? 0 : 3, paused } }));
        assert.equal(state, expected);
        assert.doesNotMatch(content, /Reviewing \d|aria-hidden/);
        assert.match(render({ phase, ai: { ...defaults.ai, analyzing: 3, paused } }), /4 assessments completed/);
    }
    for (const phase of ["finding", "filtering"]) {
        const metadataContinues = render({ phase, ai: { ...defaults.ai, analyzing: 1, paused: true } });
        assert.match(metadataContinues, new RegExp(`data-phase="${phase}"`));
        assert.equal(status(metadataContinues)[1], "paused");
        assert.match(status(metadataContinues)[2], /Photo reviews paused/);
        assert.match(status(metadataContinues)[2], /1 in progress/);
        assert.match(metadataContinues, /aria-label="Stop search"/);
        assert.match(metadataContinues, /role="progressbar"/);
        assert.match(metadataContinues, /Listing checks are still running/);
        assert.doesNotMatch(metadataContinues, /New checks are stopped|AI assessing/);
    }
    const budgetPaused = render({ phase: "paused", ai: { ...defaults.ai, analyzing: 0, paused: true } });
    assert.match(budgetPaused, /Photo reviews paused/);
    assert.doesNotMatch(budgetPaused, /Done:|data-state="complete"|role="progressbar"|Scanning listings|\d+%/);
    const pendingBudget = render({ phase: "paused", ai: { done: 2, target: 47, analyzing: 0, waiting: 45, failed: 0, paused: true },
        stats: { junk: 0, dropped: 0, unchecked: 45, deals: 0 } });
    assert.match(pendingBudget, /2 assessments completed/);
    assert.match(status(pendingBudget)[2], /45 awaiting assessment/);
    assert.doesNotMatch(status(pendingBudget)[2], /failed/);
    assert.match(pendingBudget, /Screening incomplete/);
    assert.doesNotMatch(pendingBudget, /Couldn&#x27;t verify|Couldn't verify/);
    const mixedPause = render({ phase: "paused", canStopAssessment: true, ai: { done: 5, target: 53, analyzing: 3, waiting: 45, failed: 2, paused: true },
        stats: { junk: 0, dropped: 0, unchecked: 49, deals: 0 } });
    assert.match(mixedPause, /3 assessments completed/);
    assert.match(status(mixedPause)[2], /45 awaiting assessment/);
    assert.match(status(mixedPause)[2], /3 in progress/);
    assert.match(status(mixedPause)[2], /2 failed/);
    assert.match(mixedPause, /aria-label="Stop search"/);
    const failedSearch = render({ phase: "error", error: "Discovery stream closed" });
    assert.match(failedSearch, /Discovery stream closed/);
    assert.doesNotMatch(failedSearch, /aria-label="Stop search"|3 in progress|Reviewing 3 cards/);
    const manualAfterFailure = render({ phase: "error", error: "Discovery stream closed", canStopAssessment: true });
    assert.match(manualAfterFailure, /aria-label="Stop search"/);
    assert.match(manualAfterFailure, /Reviewing 3 cards/);
    const phasePaused = render({ phase: "paused", checked: 2, total: 3, ai: { ...defaults.ai, paused: false } });
    assert.match(status(phasePaused)[2], /Photo reviews paused/);
    assert.doesNotMatch(phasePaused, /Reviewing \d|role="progressbar"|67%/);
    const [, idleState, idle] = status(render({ phase: "finding", ai: { done: 0, target: 0, analyzing: 0, waiting: 0, failed: 0 } }));
    assert.equal(idleState, "idle"); assert.match(idle, /Checking listing matches and prices/);
    const conflict = render({ phase: "done", ai: { done: 5, target: 5, analyzing: 0, waiting: 0, failed: 0, inconclusive: 1 } });
    assert.match(conflict, /4 assessments completed/);
    assert.match(status(conflict)[2], /1 inconclusive/);
    assert.doesNotMatch(status(conflict)[2], /failed|awaiting/);
    const held = render({ phase: "done", ai: { done: 2, target: 2, analyzing: 0, waiting: 0, failed: 0, held: 1 } });
    assert.match(held, /1 assessment completed/);
    assert.match(status(held)[2], /1 on hold/);
    assert.doesNotMatch(status(held)[2], /paused|failed|awaiting/i);
    const cleanDone = render({ phase: "done", ai: { done: 5, target: 5, analyzing: 0, waiting: 0, failed: 0 } });
    const visibleDone = cleanDone.slice(0, cleanDone.indexOf('inert=""'));
    assert.equal(status(cleanDone), null, "completed work must not leave a second status strip");
    assert.match(visibleDone, /Search complete/);
    assert.match(visibleDone, /25 listings loaded · 5 assessments completed · 1 deal/);
    assert.doesNotMatch(visibleDone, /role="progressbar"|AI|100%|No photo reviews running/);
    assert.equal((visibleDone.match(/5 assessments completed/g) ?? []).length, 1);

    const buyer = { finished: 6, total: 50, priorityDone: 4, priorityTotal: 15, priorityPhotos: 3, unavailable: 2, active: 2 };
    const prioritized = render({ phase: "done", checked: 50, total: 50, buyerProgress: buyer });
    const visible = prioritized.slice(0, prioritized.indexOf('inert=""'));
    assert.match(visible, /Checking priority listings/);
    assert.match(visible, /50 listings loaded · 6 of 50 buyer decisions ready/);
    assert.match(visible, /Checking 2 listings/);
    assert.match(visible, /4 of 15 priority listings checked/);
    assert.match(visible, /3 with photo assessments/);
    assert.match(visible, /2 checks unavailable/);
    assert.doesNotMatch(prioritized, /Reviewing photos|Reviewing 2 cards|awaiting assessment|assessments completed/);
    const sorting = render({ phase: "ai", buyerProgress: { ...buyer, priorityDone: 13, priorityUnavailable: 2 } });
    assert.match(sorting, /Sorting remaining listings/);
    const buyerDone = render({ phase: "done", checked: 50, buyerProgress: { ...buyer, finished: 48, priorityDone: 15, active: 0 } });
    assert.match(buyerDone, /Search complete/);
    assert.match(buyerDone, /48 of 50 buyer decisions ready/);
    assert.match(buyerDone, /2 checks unavailable/);
    assert.doesNotMatch(buyerDone, /Reviewing photos|awaiting assessment/);

    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "0" } });
    try {
        const expanded = render();
        assert.ok(!expanded.includes('inert=""'));
        assert.match(status(expanded)[2], /Reviewing 3 cards/);
        assert.match(expanded, /Results appear as each assessment finishes/);
        const finished = render({ phase: "done", checked: 50, total: 50,
            ai: { done: 1, target: 1, analyzing: 0, waiting: 0, failed: 0 },
            stats: { junk: 0, dropped: 0, unchecked: 49, deals: 0 } });
        assert.match(finished, /50 listings loaded · 1 assessment completed/);
        const expandedPause = render({ phase: "paused", checked: 2, total: 3, ai: { ...defaults.ai, paused: true } });
        assert.match(expandedPause, /New photo checks are paused/);
        assert.match(expandedPause, /New photo assessments are paused/);
        assert.doesNotMatch(expandedPause, /Scanning listings|Searching eBay|role="progressbar"|67%|Reviewing \d|class="[^"]*(?:dots|indeterminate)/);
        const expandedBudget = render({ phase: "paused", ai: { done: 2, target: 47, analyzing: 0, waiting: 45, failed: 0, paused: true },
            stats: { junk: 0, dropped: 0, unchecked: 45, deals: 0 } });
        assert.match(expandedBudget, /45 listings await assessment/);
        assert.match(expandedBudget, /These listings have not failed verification/);
    } finally {
        if (previous) Object.defineProperty(globalThis, "localStorage", previous);
        else Reflect.deleteProperty(globalThis, "localStorage");
    }
});

test("coverage distinguishes rejected, not reached, and screened outside the results", async t => {
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../client/vite.config.js", import.meta.url)),
        server: { middlewareMode: true, hmr: false, ws: false, watch: null }, logLevel: "error" });
    t.after(() => vite.close());
    const { SearchCoverage } = await vite.ssrLoadModule("/src/search/SearchCoverage.tsx");
    const render = (report: Record<string, unknown> | null, finished = true) => renderToStaticMarkup(createElement(SearchCoverage, { finished, report }));

    const markup = render({ sourceCoverage: "PARTIAL", sourceDispositions: [
        { id: "v1|123456789012|0", outcome: "REJECTED", reason: "OTHER_SET" },
        { id: "v1|987654321098|0", outcome: "NOT_REACHED", reason: "ENOUGH_CANDIDATES" },
    ], overflow: { version: 1, stage: "SCREENING", rows: [{ id: "overflow-copy", reason: "SOLD_EVIDENCE_MISSING" }] } });
    assert.match(markup, /1 rejected · 1 not reached/);
    assert.match(markup, /Rejected \(1\)[\s\S]*?ebay\.com\/itm\/123456789012[\s\S]*?Different set/);
    assert.match(markup, /Not reached \(1\)[\s\S]*?ebay\.com\/itm\/987654321098[\s\S]*?Screening stopped after finding enough candidates/);
    assert.match(markup, /Screened, outside display limit \(1\)[\s\S]*?overflow-copy[\s\S]*?No matching sold-price evidence/);
    assert.match(markup, /Coverage is partial/);
    assert.match(markup, /Listings outside the fetched window have no individual status here/);

    assert.match(render({ sourceCoverage: "COMPLETE", sourceDispositions: [] }), /0 rejected · 0 not reached/);
    assert.match(render(null), /This search has no recorded rejection or not-reached details/);
    assert.equal(render(null, false), "");
});
