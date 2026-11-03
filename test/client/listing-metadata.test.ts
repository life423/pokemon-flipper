import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { ListingSummary } from "../../shared/types.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { mixedCoverageEvaluation } from "../fixtures/photo-coverage.ts";

test("cards show real listed dates, distinguish creation, and keep the card-type choice visible before a search", async t => {
    const server = await createServer({ configFile: path.resolve("client/vite.config.js"), envFile: false, appType: "custom", logLevel: "silent",
        server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => server.close());
    const { DealCard } = await server.ssrLoadModule("/src/components/DealCard.tsx");
    const { SearchControls } = await server.ssrLoadModule("/src/search/SearchControls.tsx");
    const item: ListingSummary = { id: "date-card", title: "Alakazam Base Set 1/102", currentPrice: 30, shipping: 0, bids: 0, isGraded: false,
        buyingOption: "FIXED_PRICE", endTime: null, images: [], url: "https://www.ebay.com/itm/123456789012", seller: null };
    const props = { selected: false, now: Date.parse("2026-11-02T17:00:00Z"), onOpen: () => {}, years: {} };
    const render = (listing: ListingSummary, analysis?: unknown) => renderToStaticMarkup(createElement(DealCard, { ...props, listing, analysis }));
    const listedAt = "2026-11-02T16:06:00.000Z", createdAt = "2026-11-01T14:00:00.000Z";
    const dated = render({ ...item, listedAt, createdAt });
    assert.match(dated, /Listed <time dateTime="2026-11-02T16:06:00.000Z" title="Mon, 02 Nov 2026 16:06:00 GMT">/);
    assert.ok(dated.includes(new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(listedAt))));
    assert.doesNotMatch(dated, /Created <time/);
    assert.match(render({ ...item, listedAt: "invalid", createdAt }), /Created <time dateTime="2026-11-01T14:00:00.000Z"/);
    for (const listing of [item, { ...item, listedAt: "invalid", createdAt: "invalid" }]) {
        assert.match(render(listing), /Listed time unavailable/);
        assert.doesNotMatch(render(listing), /<time|Invalid Date/);
    }
    const evaluation = cardEvaluation(); evaluation.listing.listedAt = listedAt;
    assert.match(render(item, { status: "done", evaluation }), /Listed <time dateTime="2026-11-02T16:06:00.000Z"/);
    const covered = render(item, { status: "done", evaluation: mixedCoverageEvaluation() });
    assert.doesNotMatch(covered, /Your review needed/);
    assert.match(covered, /Photo 2 \(back close-up\): Only the upper-right portion of the card back is shown\./);
    assert.match(covered, /Photo notes \(/);
    const deferred = mixedCoverageEvaluation(); deferred.researchMode = "DEFERRED_LOW_RESALE"; deferred.condition = null;
    deferred.underwriting = { verdict: "NEEDS_REVIEW", reasons: ["No condition estimate."], best: null, paths: [], assumptions: [] };
    const deferredHtml = render(item, { status: "done", evaluation: deferred });
    assert.match(deferredHtml, /Research deferred/);
    assert.doesNotMatch(deferredHtml, /Your review needed|No reliable bid limit yet/);
    const { DetailPanel } = await server.ssrLoadModule("/src/components/DetailPanel.tsx");
    const panel = renderToStaticMarkup(createElement(DetailPanel, { ...props, listing: item, analysis: { status: "done", evaluation: deferred },
        onClose: () => {}, onAnalyze: () => {}, onPhotoReview: () => {} }));
    assert.match(panel, /Automatic research deferred/);
    assert.match(panel, /Run full research \(paid; reuse photos\)/);
    assert.doesNotMatch(panel, /Your review needed/);

    const noop = () => {};
    const groups = Object.fromEntries(["new", "deals", "offers", "candidates", "review", "all"].map(view => [view, []]));
    const controls = { showSearchOptions: true, hidden: true, idle: true,
        views: { view: "all", availableViews: ["all"], groups, allTab: { current: null }, setView: noop },
        filters: { typeFilter: "all", kindFilter: "all", sort: "best", minPrice: "", maxPrice: "", minGrade: 0,
            setTypeFilter: noop, setKindFilter: noop, setSort: noop, changeMinPrice: noop, setMaxPrice: noop, changeMinGrade: noop },
        target: { targets: { minProfit: 0, minRoi: 0 }, targetInputs: { minProfit: "", minRoi: "" }, changeTarget: noop },
        settings: { includeOffers: false, autoSetting: 3, resultsSetting: 200, changeIncludeOffers: noop, changeAutoSetting: noop, changeResultsSetting: noop },
        drawer: { drawerOpen: false, setDrawerOpen: noop }, usage: null, aiUsage: null };
    for (const kind of ["all", "raw", "graded"]) {
        const html = renderToStaticMarkup(createElement(SearchControls, { ...controls, filters: { ...controls.filters, kindFilter: kind } }));
        assert.equal((html.match(/Card type/g) ?? []).length, 1);
        assert.ok(html.indexOf("Card type") < html.indexOf('hidden=""'), "the picker must be outside the hidden results toolbar");
        assert.match(html, new RegExp(`<option value="${kind}" selected="">`));
        assert.match(html, />Both<\/option>/); assert.match(html, />Raw cards<\/option>/); assert.match(html, />Graded cards<\/option>/);
        const beforeResults = html.slice(0, html.indexOf('hidden=""'));
        assert.match(beforeResults, /English cards only/);
        assert.match(beforeResults, /Identity and condition remain preliminary until photo assessment/);
        assert.match(beforeResults, /Minimum Buy It Now price/); assert.match(beforeResults, /Maximum purchase price/);
        assert.match(beforeResults, /All prices by default/);
        assert.equal((beforeResults.match(/type="number"/g) ?? []).length, 2);
        assert.equal((beforeResults.match(/placeholder="Any" value=""/g) ?? []).length, 2);
    }
    const limited = renderToStaticMarkup(createElement(SearchControls, { ...controls, filters: { ...controls.filters, minPrice: "30", maxPrice: "100" } }));
    assert.match(limited, /placeholder="Any" value="30"/); assert.match(limited, /placeholder="Any" value="100"/);
    const nonSearch = renderToStaticMarkup(createElement(SearchControls, { ...controls, showSearchOptions: false }));
    assert.equal((nonSearch.match(/Card type/g) ?? []).length, 1);
    assert.ok(nonSearch.indexOf("Card type") > nonSearch.indexOf('aria-label="Views and filters"'), "other pages retain their filter controls in the drawer");
});
