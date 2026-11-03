import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { pricingSnapshotKey } from "../../shared/pricing-retries.ts";
import type { ListingSummary } from "../../shared/types.ts";

test("manual pricing retries retain cooldown, search waiting and cancellation without automatic recovery", async t => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    t.mock.method(Date, "now", () => now);
    t.mock.method(globalThis, "fetch", () => { throw new Error("Rendering retry controls cannot request providers"); });
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../client/vite.config.js", import.meta.url)),
        server: { middlewareMode: true, hmr: false, ws: false, watch: null }, logLevel: "error" });
    t.after(() => vite.close());
    const { PricingRetries } = await vite.ssrLoadModule("/src/components/PricingRetries.tsx");
    const listing: ListingSummary = { id: "saved-retry", title: "Venusaur Base Set 15/102", currentPrice: 100, shipping: 0,
        buyingOption: "FIXED_PRICE", isGraded: false, bids: 0, endTime: null, images: [], url: "", seller: null,
        screen: { status: "UNSCREENED", card: null, bestCase: null, assumed: null, reason: "Temporary price failure.",
            pricingIssue: { kind: "TEMPORARY", retryAt: new Date(now - 1).toISOString() } } };
    listing.screen!.pricingRetry = { ticket: "saved-ticket", snapshotKey: pricingSnapshotKey(listing),
        retryAt: new Date(now - 1).toISOString(), attemptsLeft: 1 };
    const defaults = { listings: [listing], analyzed: new Set<string>(), reviewCount: 0, busy: false, note: "",
        onRetry: () => {}, onCancel: () => {} };
    const render = (change = {}) => renderToStaticMarkup(createElement(PricingRetries, { ...defaults, ...change }));
    assert.match(render(), />Retry pricing \(1\)<\/button>/);
    assert.match(render(), /Up to five per batch/);
    assert.doesNotMatch(render(), /automatic recovery/);
    const searching = render({ searching: true });
    assert.match(searching, /waiting for this search to finish/);
    assert.doesNotMatch(searching, />Retry pricing/);
    const waiting = structuredClone(listing);
    waiting.screen!.pricingRetry!.retryAt = new Date(now + 30000).toISOString();
    assert.match(render({ listings: [waiting] }), /disabled="">Retry pricing in 30s/);
    assert.match(render({ busy: true }), /Cancel pricing retries/);
    assert.equal(render({ analyzed: new Set([listing.id]) }), "");
    assert.match(render({ listings: [], reviewCount: 2 }), /2 listings need attention/);
});
