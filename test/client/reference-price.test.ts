import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { addBinMarketComparisons } from "../../shared/bin-market-comparison.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";
import { displayAnalysis } from "../../client/src/analysis-state.ts";
import { groupSearchResults } from "../../client/src/search/results.ts";
import type { ActiveReference, ListingSummary } from "../../shared/types.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";

test("the result card explains a two-market price lead while a verified loss stays in Projected losses", async t => {
    const server = await createServer({ configFile: path.resolve("client/vite.config.js"), envFile: false, appType: "custom", logLevel: "silent",
        server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => server.close());
    const { DealCard } = await server.ssrLoadModule("/src/components/DealCard.tsx");
    const value = cardEvaluation();
    value.listing = { ...value.listing, buyingOption: "FIXED_PRICE", availability: "ACTIVE", price: 90, shipping: 0, termsCheckedAt: new Date().toISOString() };
    value.condition!.gradeRange = null;
    value.photoCheck!.cardCount = "ONE";
    value.gradedPricing = null;
    const summary = salesSummary("RAW", "LIGHTLY_PLAYED", [95, 100, 105]);
    summary.windowDays = 90;
    for (const sale of summary.sales) Object.assign(sale, { saleType: "fixed_price", photoCondition: "LIGHTLY_PLAYED", conditionEvidence: ["Visible edge wear."] });
    value.rawPricing = { status: "PRICED", conditionEvidence: "AI_PHOTOS", prices: [{ condition: "LIGHTLY_PLAYED", basis: "EBAY_SOLD", price: 100, updatedAt: summary.newestSale, comps: summary }] };
    const comparisonRows = [90, 100, 110, 125].map((price, i): ListingSummary => ({
        ...value.listing, id: String(i), currentPrice: price, isGraded: false, images: [], cardCondition: "Lightly Played",
        buyingOption: "FIXED_PRICE", screen: { status: "UNSCREENED", reason: null, card: null, bestCase: null, assumed: null,
            soldEvidence: { status: "AVAILABLE", exactScope: true, note: "", references: [{ recordId: 1, name: "Venusaur", set: "Base Set",
                cardNumber: "15/102", printing: "UNLIMITED", finish: "HOLO", condition: "LIGHTLY_PLAYED", grader: null, grade: null, summary }] } },
    }));
    const row = addBinMarketComparisons(comparisonRows, [], Date.now())[0];
    value.underwriting = underwrite(value, MONEY_CONFIG);
    assert.equal(value.underwriting.verdict, "PASS");
    const render = () => renderToStaticMarkup(createElement(DealCard, {
        listing: row, analysis: { status: "done", evaluation: value }, now: Date.now(), includeOffers: false, selected: false, onOpen() {}, years: {},
    }));
    assert.match(render(), /10% below both medians at search time/);
    assert.match(render(), /\$110\.00 median across 3 other Buy It Now listings/);
    const grouped = groupSearchResults([row], { [row.id]: { status: "done", evaluation: value } }, false, new Set());
    assert.deepEqual(grouped.deals, []);
    assert.deepEqual(grouped.losses.map(listing => listing.id), [row.id]);
    value.listing.shipping = null;
    assert.doesNotMatch(render(), /below both medians/);
});

test("a raw deal explains when sold photos support a lower-condition resale floor", async t => {
    const server = await createServer({ configFile: path.resolve("client/vite.config.js"), envFile: false, appType: "custom", logLevel: "silent",
        server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => server.close());
    const { DealCard } = await server.ssrLoadModule("/src/components/DealCard.tsx");
    const { CompsRow } = await server.ssrLoadModule("/src/components/analysis/PricingSections.tsx");
    const targets = { minProfit: 0, minRoi: 0 }, value = cardEvaluation(targets);
    value.listing = { ...value.listing, buyingOption: "FIXED_PRICE", price: 40, shipping: 5 };
    value.photoCheck!.cardCount = "ONE";
    value.condition!.rawCondition = "NEAR_MINT";
    value.condition!.gradeRange = null;
    value.gradedPricing = null;
    const comps = salesSummary("RAW", "LIGHTLY_PLAYED", [95, 100, 105]);
    for (const sale of comps.sales) Object.assign(sale, { photoCondition: "LIGHTLY_PLAYED", conditionEvidence: ["Whitening visible on the bottom edge."] });
    value.rawPricing = { status: "PRICED", conditionEvidence: "AI_PHOTOS", prices: [{ condition: "LIGHTLY_PLAYED", basis: "EBAY_SOLD", price: 100, updatedAt: comps.newestSale, comps }] };
    value.underwriting = underwrite(value, { ...MONEY_CONFIG, targets });
    assert.equal(value.underwriting.verdict, "BUY_RAW");
    const render = () => renderToStaticMarkup(createElement(DealCard, {
        listing: { ...value.listing, currentPrice: 40, isGraded: false, images: [] }, analysis: { status: "done", evaluation: value },
        targets, now: Date.now(), includeOffers: false, selected: false, onOpen() {}, years: {},
    }));
    assert.match(render(), /Photos support Near Mint\. The \$100\.00 resale estimate uses 3 photo-checked Lightly Played sales\./i);
    assert.match(renderToStaticMarkup(createElement(CompsRow, { summary: comps })), /Whitening visible on the bottom edge/);
    value.rawPricing.conditionEvidence = "SELLER_TEXT";
    assert.doesNotMatch(render(), /photo-checked Lightly Played sales/i);
});

test("saved unsupported raw prices are hidden from the card and analysis", async t => {
    const server = await createServer({ configFile: path.resolve("client/vite.config.js"), envFile: false, appType: "custom", logLevel: "silent",
        server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => server.close());
    const { DealCard } = await server.ssrLoadModule("/src/components/DealCard.tsx");
    const { DetailPanel } = await server.ssrLoadModule("/src/components/DetailPanel.tsx");
    const { FinancialDecision, PathCard } = await server.ssrLoadModule("/src/components/analysis/FinancialDecision.tsx");
    const { AnalysisDetails } = await server.ssrLoadModule("/src/components/analysis/AnalysisDetails.tsx");
    const targets = { minProfit: 0, minRoi: 0 }, value = cardEvaluation(targets);
    value.listing = { ...value.listing, buyingOption: "FIXED_PRICE", price: 380, shipping: 0 };
    value.photoCheck!.cardCount = "ONE";
    value.condition!.rawCondition = "MODERATELY_PLAYED"; value.condition!.gradeRange = null;
    value.rawPricing = { status: "PRICED", prices: [{ condition: "MODERATELY_PLAYED", price: 500, basis: "EBAY_SOLD", updatedAt: null }] };
    value.gradedPricing = null;
    value.underwriting = underwrite(value, { ...MONEY_CONFIG, targets });
    Object.assign(value.rawPricing!.prices![0], { basis: "TCGPLAYER" });
    const listing = { ...value.listing, currentPrice: 380, isGraded: false, images: [], bestOffer: true };
    const props = { listing, evaluation: value, targets, now: Date.now() };
    const render = (component: any, other: object = {}) => renderToStaticMarkup(createElement(component, { ...props, ...other }));
    assert.equal(value.underwriting.verdict, "BUY_RAW", "simulate a stale saved verdict");
    const card = render(DealCard, { analysis: { status: "done", evaluation: value }, selected: false, onOpen() {}, years: {} });
    assert.match(card, /Price unconfirmed/);
    assert.doesNotMatch(card, /Max price:|Est\. net profit|Offer \$|Below your price limit/);
    const decision = render(FinancialDecision);
    assert.match(decision, /Resale price unconfirmed/);
    assert.doesNotMatch(decision, /Run full research|Max price|Your review needed/);
    const details = render(AnalysisDetails, { onReanalyze() {}, minGrade: 0, reviewing: false });
    assert.doesNotMatch(details + card + decision, /\$500|TCGplayer/i);
    assert.doesNotMatch(details, /Clears your targets|Selected strategy: sell raw|Suggested offer|Walk away above/);
    const panel = render(DetailPanel, { analysis: { status: "done", evaluation: value }, includeOffers: false,
        onClose() {}, onAnalyze() {}, onPhotoReview() {}, onRefreshPrices() {},
        priceRefresh: { status: "error", evidenceKey: "saved", message: "Price research unavailable" } });
    assert.match(panel, /Refresh pricing/);
    assert.match(panel, /Reanalyze full listing \(paid\)/);
    assert.match(panel, /Pricing refresh failed\. Price research unavailable Your saved assessment is still shown\./);
    assert.match(panel, /AI photo review complete/);
    assert.doesNotMatch(render(PathCard, { path: value.underwriting.best, auction: true, referenceReason: "Unverified resale reference" }), /Max bid|Profit at your max bid/);
    // An older saved verdict must not revive a recommendation, even when a
    // genuine photo concern also requires attention.
    value.underwriting.verdict = "BUY_RAW";
    value.condition!.authenticity = { concern: "UNCERTAIN", reasons: ["Unresolved physical authenticity evidence."] };
    const stale = render(DealCard, { analysis: { status: "done", evaluation: value }, selected: false, onOpen() {}, years: {} });
    assert.match(stale, /Your review needed/);
    assert.doesNotMatch(stale, /Max price:|Est\. net profit|Offer \$/);
    assert.doesNotMatch(render(AnalysisDetails, { onReanalyze() {}, minGrade: 0, reviewing: false }), /Suggested offer|Walk away above|Est\. profit if accepted/);
    value.underwriting.verdict = "NEEDS_REVIEW";
    assert.doesNotMatch(render(FinancialDecision), /Max price|Below your price limit/);
    assert.doesNotMatch(render(AnalysisDetails, { onReanalyze() {}, minGrade: 0, reviewing: false }), /Suggested offer|Walk away above|Est\. profit if accepted/);
});

test("a supported auction loss shows the current bid scenario even when no profitable bid exists", async t => {
    const server = await createServer({ configFile: path.resolve("client/vite.config.js"), envFile: false, appType: "custom", logLevel: "silent",
        server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => server.close());
    const { AuctionSummary } = await server.ssrLoadModule("/src/components/AuctionSummary.tsx");
    const value = cardEvaluation();
    value.listing.shipping = 0;
    value.gradedPricing = null;
    value.rawPricing!.prices[0].price = 5;
    value.underwriting = underwrite(value);
    assert.equal(value.underwriting.verdict, "PASS");
    assert.equal(value.underwriting.best?.maxBid, 0);
    const markup = renderToStaticMarkup(createElement(AuctionSummary, { evaluation: value, targets: MONEY_CONFIG.targets, now: Date.now() }));
    assert.match(markup, /No bid price meets your targets/);
    assert.match(markup, /At current bid \$36\.60/);
    assert.match(markup, /Est\. net loss/);
    assert.match(markup, /\$41\.65/);
});

test("expired Buy It Now competition leaves Deals and the direct listing keeps photos and an explicit refresh", async t => {
    const server = await createServer({ configFile: path.resolve("client/vite.config.js"), envFile: false, appType: "custom", logLevel: "silent",
        server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => server.close());
    const { DetailPanel } = await server.ssrLoadModule("/src/components/DetailPanel.tsx");
    const targets = { minProfit: 0, minRoi: 0 }, evaluation = cardEvaluation(targets);
    const checkedAt = "2026-11-09T12:00:00Z", now = Date.parse(checkedAt) + 120_000;
    const photo = "https://i.ebayimg.com/images/g/offline/s-l1600.jpg";
    evaluation.listing = { ...evaluation.listing, buyingOption: "FIXED_PRICE", price: 40, shipping: 0, bids: 0, endTime: null, photos: [photo] };
    evaluation.pricesCheckedAt = checkedAt;
    evaluation.rawPricing = null;
    evaluation.gradedPricing = null;
    evaluation.condition = null;
    evaluation.photoCheck!.holder = "GRADED_SLAB";
    evaluation.slab = { status: "OK", grader: "PSA", grade: "7", gradeQualifier: null, certNumber: null, certUrl: null,
        labelText: "PSA 7", caseCondition: "INTACT", reasons: [], concerns: [] };
    const activeReference: ActiveReference = { checkedAt, grader: "PSA", grade: "7", lowestTotal: 250, resalePrice: 225, discountRate: .1, listings: [
        { id: "comp", title: "Venusaur PSA 7", url: "https://www.ebay.com/itm/123456789012", price: 250, shipping: 0,
            total: 250, seller: evaluation.listing.seller!, certNumber: "comp-cert", checkedAt },
    ] };
    evaluation.slabPricing = { status: "PRICED", summary: salesSummary(), activeReference };
    const listing: ListingSummary = { ...evaluation.listing, currentPrice: 40, isGraded: true, images: [photo] };
    const display = (at: number) => displayAnalysis({ status: "done", evidenceKey: "saved-photos", evaluation }, targets, at, listing);
    const group = (at: number) => groupSearchResults([listing], { [listing.id]: display(at) }, true, new Set());
    assert.deepEqual(group(now - 1).deals, [listing]);
    assert.deepEqual(group(now).deals, []);
    assert.deepEqual(group(now).candidates, [listing]);
    assert.equal(evaluation.slabPricing.activeReference, activeReference);

    evaluation.slabPricing = { status: "PRICED", activeReference };
    const renderDirect = (at: number) => renderToStaticMarkup(createElement(DetailPanel, { listing, analysis: display(at), now: at, targets,
        includeOffers: true, onClose() {}, onAnalyze() {}, onRefreshPrices() { assert.fail("pricing may refresh only after a click"); }, onPhotoReview() {} }));
    assert.match(renderDirect(now - 1), /Current Buy It Now competition/);
    const stale = renderDirect(now);
    assert.match(stale, /Refresh pricing/);
    assert.match(stale, /AI photo review complete/);
    assert.match(stale, /offline\/s-l1600\.jpg/);
    assert.doesNotMatch(stale, /Current Buy It Now competition|\$225\.00|Max price:/);
});

test("unquoted Buy It Now shipping labels estimated profit and limits as provisional", async t => {
    const server = await createServer({ configFile: path.resolve("client/vite.config.js"), envFile: false, appType: "custom", logLevel: "silent",
        server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => server.close());
    const { DealCard } = await server.ssrLoadModule("/src/components/DealCard.tsx");
    const { FinancialDecision } = await server.ssrLoadModule("/src/components/analysis/FinancialDecision.tsx");
    const { AnalysisDetails } = await server.ssrLoadModule("/src/components/analysis/AnalysisDetails.tsx");
    const targets = { minProfit: 0, minRoi: 0 }, evaluation = cardEvaluation(targets);
    Object.assign(evaluation.listing, { buyingOption: "FIXED_PRICE", availability: "ACTIVE", endTime: null, bestOffer: true });
    const listing = { ...evaluation.listing, currentPrice: evaluation.listing.price, images: [], isGraded: false };
    const now = Date.now(), props = { listing, evaluation, now, targets };
    evaluation.underwriting = underwrite(evaluation, { ...MONEY_CONFIG, targets });
    assert.equal(evaluation.underwriting.shippingUnconfirmed, true);
    const card = renderToStaticMarkup(createElement(DealCard, { ...props, analysis: { status: "done", evaluation }, selected: false, onOpen() {}, years: {}, includeOffers: true }));
    const decision = renderToStaticMarkup(createElement(FinancialDecision, props));
    const details = renderToStaticMarkup(createElement(AnalysisDetails, { ...props, minGrade: 0, reviewing: false }));
    assert.match(card, /Shipping unconfirmed/);
    assert.match(card + decision, /Modeled net profit at asking/);
    assert.match(card + decision + details, /Provisional max price/);
    assert.doesNotMatch(card + decision + details, /Free shipping|Clears your targets|Below your price limit|Suggested offer|Selected strategy/);
});
