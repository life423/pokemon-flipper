import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

test("cards and analysis hide refresh timestamps while keeping listing events, auction countdowns and sold dates", async t => {
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../client/vite.config.js", import.meta.url)),
        envFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, logLevel: "error" });
    t.after(() => vite.close());
    const { DealCard } = await vite.ssrLoadModule("/src/components/DealCard.tsx");
    const { DetailPanel } = await vite.ssrLoadModule("/src/components/DetailPanel.tsx");
    const { PhotoReview } = await vite.ssrLoadModule("/src/components/PhotoReview.tsx");
    const { SlabSection } = await vite.ssrLoadModule("/src/components/analysis/EvidenceSections.tsx");
    const { ShortlistView } = await vite.ssrLoadModule("/src/components/ShortlistView.tsx");
    const now = Date.parse("2026-11-02T18:00:00Z"), soldAt = "2026-10-30T12:00:00.000Z";
    const evaluation = cardEvaluation();
    evaluation.answeredAt = "2097-06-10T12:34:00.000Z";
    evaluation.pricesCheckedAt = "2100-06-10T12:34:00.000Z";
    evaluation.listing.photos = ["https://i.ebayimg.com/images/g/offline/s-l1600.jpg"];
    evaluation.listing.listedAt = "2026-11-02T16:00:00.000Z";
    evaluation.listing.endTime = "2026-11-03T00:00:00.000Z";
    evaluation.photoReviewKey = "offline-photo-evidence";
    evaluation.deeperPhotoReview = { inputKey: "offline-photo-evidence", reviewedAt: "2098-06-10T12:34:00.000Z",
        summary: "Offline saved review.", photoNumbers: [1], findings: [], requestedPhotos: [], usage: { inputTokens: 1, outputTokens: 1 } };
    evaluation.rawPricing!.prices![0].updatedAt = "2101-06-10T12:34:00.000Z";
    for (const pricing of Object.values(evaluation.gradedPricing!)) {
        for (const summary of pricing.byGrade!) {
            summary.newestSale = soldAt;
            for (const sale of summary.sales) sale.soldAt = soldAt;
        }
    }
    const listing = { ...evaluation.listing, currentPrice: evaluation.listing.price, isGraded: false,
        images: evaluation.listing.photos, url: "https://www.ebay.com/itm/123456789012" };
    const analysis = { status: "done", evaluation };
    const cardProps = { listing, analysis, now, selected: false, years: {}, onOpen: () => {} };
    const panelProps = { listing, analysis, now, onClose: () => {}, onAnalyze: () => { assert.fail("rendering cannot trigger analysis"); }, onPhotoReview: () => {} };
    const card = renderToStaticMarkup(createElement(DealCard, cardProps));
    const panel = renderToStaticMarkup(createElement(DetailPanel, panelProps));
    const compact = renderToStaticMarkup(createElement(PhotoReview, { listing, evaluation, compact: true }));
    assert.match(card, /Listed <time dateTime="2026-11-02T16:00:00.000Z"/);
    assert.match(card, /6h/);
    assert.match(panel, /2026-10-30T12:00:00.000Z/);
    assert.match(card, /4 of 4 photos checked/);
    assert.match(panel, /1 photos examined · saved result/);
    assert.match(compact, /Deeper AI review saved/);
    for (const html of [card, panel, compact]) {
        assert.doesNotMatch(html, /2097|2098|2099|2100|2101|date unavailable/);
    }
    const created = renderToStaticMarkup(createElement(DealCard, { ...cardProps,
        listing: { ...listing, listedAt: undefined, createdAt: "2026-11-01T14:00:00.000Z" },
        analysis: { ...analysis, evaluation: { ...evaluation, listing: { ...evaluation.listing, listedAt: undefined } } } }));
    assert.match(created, /Created <time dateTime="2026-11-01T14:00:00.000Z"/);

    const slab = { status: "OK", grader: "PSA", grade: "7", gradeQualifier: null, certNumber: "offline-cert",
        certUrl: null, labelText: "PSA 7", caseCondition: "Clear", reasons: [], concerns: [] };
    const active = { status: "PRICED", activeReference: { checkedAt: "2099-06-10T12:34:00.000Z", grader: "PSA", grade: "7",
        lowestTotal: 100, resalePrice: 95, discountRate: .05, listings: [] } };
    const slabHtml = renderToStaticMarkup(createElement(SlabSection, { slab, pricing: active }));
    assert.match(slabHtml, /Current Buy It Now competition/);
    assert.match(slabHtml, /Slab photos and labels checked/);
    assert.doesNotMatch(slabHtml, /2099/);

    const broad = { ...evaluation, underwriting: null, gradedPricing: null, marketActivity: {
        status: "AVAILABLE", scope: "RAW", variant: "Unlimited", periodDays: 30,
        observedSales: 12, activeDays: 8, dailyAverage: .4, newestSale: soldAt,
        checkedAt: "2099-06-10T12:34:00.000Z", complete: true,
    } };
    const broadAnalysis = { status: "done", evaluation: broad };
    const broadCard = renderToStaticMarkup(createElement(DealCard, { ...cardProps, analysis: broadAnalysis }));
    const broadPanel = renderToStaticMarkup(createElement(DetailPanel, { ...panelProps, analysis: broadAnalysis }));
    assert.match(broadCard, /Frequent recorded sales/);
    assert.match(broadPanel, /Latest recorded sale/);
    assert.match(broadPanel, /2026-10-30T12:00:00.000Z/);
    assert.equal(/2099/.test(broadCard + broadPanel), false, "market refresh time must not appear in visible text or card tooltips");
    assert.equal(broad.marketActivity.checkedAt, "2099-06-10T12:34:00.000Z");

    const savedEntry = { id: listing.id, listing, evaluation, savedAt: "2097-06-10T12:34:00.000Z",
        checkedAt: "2098-06-10T12:34:00.000Z", notes: "", ceiling: null, needsAnalysis: false };
    const shortlist = renderToStaticMarkup(createElement(ShortlistView, { entries: [savedEntry], loading: false, error: "", refreshing: false,
        refreshErrors: {}, now, onRetry: () => {}, onRefresh: async () => {}, onRemove: async () => {}, onUpdate: async () => {},
        renderCard: () => createElement(DealCard, cardProps) }));
    assert.match(shortlist, /Listed <time dateTime="2026-11-02T16:00:00.000Z"/);
    assert.equal(/2097|2098|2099|2100|2101|Last checked/.test(shortlist), false, "saved refresh timestamps stay internal to shortlist entries");
    assert.equal(savedEntry.checkedAt, "2098-06-10T12:34:00.000Z");

    // Internal refresh fields remain on the evidence object for cache/expiry
    // checks; rendering must neither expose nor erase them.
    assert.equal(evaluation.answeredAt, "2097-06-10T12:34:00.000Z");
    assert.equal(evaluation.deeperPhotoReview.reviewedAt, "2098-06-10T12:34:00.000Z");
    assert.equal(evaluation.pricesCheckedAt, "2100-06-10T12:34:00.000Z");
    assert.equal(evaluation.rawPricing!.prices![0].updatedAt, "2101-06-10T12:34:00.000Z");
});
