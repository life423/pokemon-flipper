import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import type { ShortlistEntry } from "../../shared/shortlist.ts";
import type { ListingSummary } from "../../shared/types.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

test("foreign saved cards are kept for removal but never render cards or refresh controls, while unknown language stays preliminary", async t => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; assert.fail("rendering English-only results cannot dispatch a provider"); });
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../client/vite.config.js", import.meta.url)), envFile: false,
        server: { middlewareMode: true, hmr: false, ws: false, watch: null }, logLevel: "error" });
    t.after(() => vite.close());
    const { ShortlistView } = await vite.ssrLoadModule("/src/components/ShortlistView.tsx");
    const { EnglishOnlyNotice } = await vite.ssrLoadModule("/src/App.tsx");
    const now = Date.parse("2026-11-02T12:00:00Z");
    const item = (id: string): ListingSummary => ({ id, title: `Saved card ${id}`, currentPrice: 80, shipping: 0, bids: 0, isGraded: false,
        buyingOption: "FIXED_PRICE", endTime: null, images: [], url: "https://www.ebay.com/itm/123456789012", seller: null });
    const entry = (id: string): ShortlistEntry => ({ id, listing: item(id), evaluation: null,
        savedAt: new Date(now).toISOString(), checkedAt: null, notes: "Preserve my notes", ceiling: null, needsAnalysis: true });
    const english = entry("english"), unknown = entry("unknown"), foreign = entry("foreign"), foreignTitle = entry("foreign-title");
    english.listing.title += " English";
    foreignTitle.listing.title = "Venusaur Base Set Japanese";
    foreign.evaluation = cardEvaluation(); foreign.evaluation.identity!.language = "German";
    const entries = [english, unknown, foreign, foreignTitle];
    const before = structuredClone(entries), rendered: string[] = [];
    const html = renderToStaticMarkup(createElement(ShortlistView, { entries, loading: false, error: "", refreshing: false,
        refreshErrors: {}, now, onRetry: () => {}, onRefresh: async () => assert.fail("rendering cannot refresh eBay"),
        onRemove: async () => assert.fail("rendering cannot remove saved data"), onUpdate: async () => assert.fail("rendering cannot update notes"),
        renderCard: (saved: ShortlistEntry) => { rendered.push(saved.id); return createElement("p", {}, `Card ${saved.id}`); } }));
    assert.deepEqual(rendered, ["english", "unknown"]);
    assert.match(html, /English cards only/);
    assert.match(html, /2 saved listings outside the English-only scope/);
    assert.equal((html.match(/Remove saved entry/g) ?? []).length, 2);
    assert.equal((html.match(/Select for refresh/g) ?? []).length, 2);
    const excluded = html.slice(html.indexOf("<details"), html.indexOf("</details>") + "</details>".length);
    assert.doesNotMatch(excluded, /Card foreign|Select for refresh|>Refresh<|type="checkbox"/);
    assert.deepEqual(entries, before, "language exclusions must preserve saved records and notes");
    const notice = renderToStaticMarkup(createElement(EnglishOnlyNotice));
    assert.match(notice, /identified as non-English and is excluded/);
    assert.match(notice, /No additional AI analysis will start/);
    assert.doesNotMatch(notice, /<button/);
    assert.equal(requests, 0);
});
