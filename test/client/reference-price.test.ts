import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";
import { displayAnalysis } from "../../client/src/analysis-state.ts";
import { groupSearchResults } from "../../client/src/search/results.ts";
import type { ActiveReference, ListingSummary } from "../../shared/types.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";

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
