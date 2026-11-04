import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { applySoldPriceScreen } from "../../shared/money/sold-screen.ts";
import type { CompSummary, ListingSummary, ScreeningSoldEvidence, ScreeningSoldReference } from "../../shared/types.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

const now = Date.parse("2026-11-03T18:00:00Z");
const base: ListingSummary = { id: "offline-sold-screen", title: "Example Card 4/102 English", currentPrice: 40, shipping: 5,
    isGraded: false, buyingOption: "FIXED_PRICE", bids: 0, endTime: null, images: [], seller: null, url: "https://www.ebay.com/itm/123456789012" };
function summary(grader = "RAW", grade = "UNSPECIFIED", median = 120, count = 3): CompSummary {
    return { grader, grade, median: count ? median : null, mean: count ? median : null, low: count ? median - 10 : null,
        high: count ? median + 10 : null, count, windowDays: 90, newestSale: count ? "2026-11-02T12:00:00Z" : null,
        confidence: count >= 3 ? "MEDIUM" : count ? "LOW" : "NONE", dropped: {},
        sales: Array.from({ length: count }, (_, index) => ({ price: median + index - 1, soldAt: "2026-11-02T12:00:00Z",
            title: `Example matching sold copy ${index + 1}`, url: `https://www.ebay.com/itm/${123456789000 + index}` })) };
}
function reference(change: Partial<ScreeningSoldReference> = {}): ScreeningSoldReference {
    return { recordId: 1, name: "Example Card", set: "Example Set", cardNumber: "4/102", printing: "UNLIMITED", finish: "HOLO",
        grader: null, grade: null, condition: null, summary: summary(), ...change };
}
function evidence(references: ScreeningSoldReference[], change: Partial<ScreeningSoldEvidence> = {}): ScreeningSoldEvidence {
    return { status: "AVAILABLE", exactScope: true, references, note: "Recent matching eBay sold transactions, before this listing's photo assessment.", ...change };
}

test("sold-price UI keeps preliminary evidence separate from assessed prices and never starts provider work", async t => {
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../client/vite.config.js", import.meta.url)),
        envFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
    t.after(() => vite.close());
    const { SoldPriceScreening } = await vite.ssrLoadModule("/src/components/SoldPriceScreening.tsx");
    const { CompsRow } = await vite.ssrLoadModule("/src/components/analysis/PricingSections.tsx");
    const { DealCard } = await vite.ssrLoadModule("/src/components/DealCard.tsx");
    const { DetailPanel } = await vite.ssrLoadModule("/src/components/DetailPanel.tsx");
    const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("rendering stored sold evidence cannot call a provider"));
    const forbiddenAction = () => assert.fail("rendering must not analyze photos or contact the seller");
    const renderScreen = (listing: ListingSummary, compact = false) => renderToStaticMarkup(createElement(SoldPriceScreening, { listing, compact }));
    const renderCard = (listing: ListingSummary, analysis?: unknown) => renderToStaticMarkup(createElement(DealCard, {
        listing, analysis, selected: false, now, years: {}, onOpen: forbiddenAction,
    }));
    const renderDetail = (listing: ListingSummary, analysis?: unknown) => renderToStaticMarkup(createElement(DetailPanel, {
        listing, analysis, now, onClose: forbiddenAction, onAnalyze: forbiddenAction, onPhotoReview: forbiddenAction,
    }));

    await t.test("unavailable and deferred evidence stay unpriced without asking the user for manual card identification", () => {
        for (const status of ["UNAVAILABLE", "DEFERRED"] as const) {
            const listing = applySoldPriceScreen(base, evidence([], { status, note: "Matching sold prices are not available yet." }));
            const card = renderCard(listing), detail = renderDetail(listing);
            assert.match(card, /Price unconfirmed/);
            assert.match(card, /Sold-price evidence limited/);
            assert.match(detail, /Sold-price screening/);
            for (const html of [card, detail]) assert.doesNotMatch(html, /Your review needed|Est\. net profit|Estimated resale|Unverified screening ceiling|NaN|Infinity/);
            assert.doesNotMatch(renderScreen(listing), /median \$|No verified sales/);
        }
    });

    await t.test("unspecified raw conditions show sold observations as market context without inventing the live card's condition or value", () => {
        const listing = applySoldPriceScreen(base, evidence([reference()]));
        const before = structuredClone(listing);
        const detail = renderDetail(listing), card = renderCard(listing);
        assert.match(detail, /Sold condition is unspecified/);
        assert.match(detail, /market context, not a condition-matched raw valuation/);
        assert.match(detail, /Raw · Unspecified/);
        assert.match(detail, /median \$120\.00/);
        assert.match(detail, /preliminary market evidence, not a verified valuation/);
        for (const html of [card, detail]) assert.doesNotMatch(html, /Est\. net profit|Estimated resale|Unverified screening ceiling|Likely estimate|Your review needed/);
        assert.deepEqual(listing, before);
    });

    await t.test("one matched sale supports preliminary screening while keeping its low confidence visible", () => {
        const listing = applySoldPriceScreen({ ...base, isGraded: true }, evidence([
            reference({ grader: "PSA", grade: "8", summary: summary("PSA", "8", 120, 1) }),
        ]));
        assert.equal(listing.screen.soldEvidence?.status, "AVAILABLE");
        const detail = renderDetail(listing), card = renderCard(listing);
        assert.match(detail, /1 sale, median \$120\.00, Low/);
        assert.doesNotMatch(card, /Price unconfirmed/);
        assert.match(card, /Unverified screening ceiling/);
        for (const html of [card, detail]) assert.doesNotMatch(html, /Est\. net profit|Your review needed/);
    });

    await t.test("printing, finish and exact grade references remain separate instead of appearing as one blended market", () => {
        const listing = applySoldPriceScreen({ ...base, isGraded: true }, evidence([
            reference({ set: "Example Set A", grader: "PSA", grade: "8", summary: summary("PSA", "8", 120) }),
            reference({ set: "Example Set B", printing: "FIRST_EDITION", grader: "PSA", grade: "9", summary: summary("PSA", "9", 600) }),
            reference({ set: "Example Set C", finish: "REVERSE_HOLO", grader: "CGC", grade: "8.5", summary: summary("CGC", "8.5", 240) }),
        ], { exactScope: false }));
        const html = renderScreen(listing);
        assert.equal((html.match(/<details\b/g) ?? []).length, 3);
        for (const label of ["Example Set A", "Example Set B", "Example Set C", "Unlimited", "1st Edition", "Reverse holo", "PSA 8", "PSA 9", "CGC 8.5"]) assert.ok(html.includes(label), label);
        for (const median of ["$120.00", "$600.00", "$240.00"]) assert.ok(html.includes(`median ${median}`));
        assert.doesNotMatch(renderCard(listing), /Unverified screening ceiling|Est\. net profit/);
    });

    await t.test("one-page screening states its 20-row sample while existing full-price evidence retains its 40-row sample", () => {
        const value = summary("PSA", "8");
        const preliminary = renderToStaticMarkup(createElement(CompsRow, { summary: value, sampleLimit: 20, screening: true }));
        const existing = renderToStaticMarkup(createElement(CompsRow, { summary: value }));
        assert.match(preliminary, /at most 20 returned rows per lookup/);
        assert.match(preliminary, /preliminary market evidence, not a verified valuation/);
        assert.doesNotMatch(preliminary, /at most 40|The median drives the estimate/);
        assert.match(existing, /at most 40 returned rows per lookup/);
        assert.match(existing, /The median drives the estimate/);
        const empty = renderToStaticMarkup(createElement(CompsRow, { summary: summary("PSA", "8", 120, 0), screening: true, sampleLimit: 20 }));
        assert.match(empty, /No verified sales/);
        assert.doesNotMatch(empty, /median \$|Range \$|NaN/);
    });

    await t.test("an unquoted preliminary shipping assumption does not contradict the displayed ceiling", () => {
        const listing = applySoldPriceScreen({ ...base, shipping: null, isGraded: true }, evidence([
            reference({ grader: "PSA", grade: "8", summary: summary("PSA", "8") }),
        ]), { targets: { minProfit: 0, minRoi: 0 } });
        const card = renderCard(listing), detail = renderDetail(listing);
        assert.match(card, /Shipping not quoted/);
        assert.doesNotMatch(card, /\$7\.00 assumed in estimates/);
        assert.match(detail, /shipping is unknown; \$0 is used only/);
    });

    await t.test("completed assessments replace the preliminary block while retaining final financial evidence", () => {
        const listing = applySoldPriceScreen(base, evidence([reference()]));
        const analysis = { status: "done", evaluation: cardEvaluation() };
        assert.doesNotMatch(renderCard(listing, analysis), /Sold prices checked|Sold-price evidence limited/);
        assert.doesNotMatch(renderDetail(listing, analysis), /Sold-price screening/);
    });

    assert.equal(fetch.mock.callCount(), 0);
});
