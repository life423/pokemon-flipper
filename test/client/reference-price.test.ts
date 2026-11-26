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
import { PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import { createBuyerListingReviewer } from "../../server/analysis/wait-skip-review.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";

test("best current buy shows an honest losing resale scenario and seller risk", async t => {
    const server = await createServer({ configFile: path.resolve("client/vite.config.js"), envFile: false, appType: "custom", logLevel: "silent",
        server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => server.close());
    const { BestCurrentBuy } = await server.ssrLoadModule("/src/components/BestCurrentBuy.tsx");
    const reference = { title: "Mewtwo 10/102 Base Set Unlimited Holo PSA 8", url: "https://www.ebay.com/itm/123456789012",
        price: 190, shipping: 5.95, ceiling: 150, identity: "LISTING", coverage: { found: 40, checked: 3 },
        pricing: { resale: 220, totalCost: 212.12, profit: -50, roi: -.236, sales: 4 },
        seller: { username: "example", feedbackScore: 3, feedbackPercentage: 90 } };
    const render = (value = reference) => renderToStaticMarkup(createElement(BestCurrentBuy, { reference: { ...value, basis: "Compared with PSA 8 sales of this printing" } }));
    const markup = render();
    assert.match(markup, /Best value among checked listings/);
    assert.match(markup, /\$7\.88 below sold estimate/);
    assert.match(markup, /\$16\.17 estimated tax/);
    assert.match(markup, /\$212\.12/);
    assert.match(markup, /Projected resale loss/);
    assert.match(markup, /Outside Deals because a resale/);
    assert.match(markup, /\$162\.12 after selling costs/);
    assert.match(markup, /-24% return/);
    assert.match(markup, /4 matched sales/);
    assert.match(markup, /photos not checked/);
    assert.match(markup, /limited or weak seller feedback/);
    assert.match(markup, /3 listings checked from 40 fetched/);
    assert.doesNotMatch(markup, /Guaranteed|Profitable deal|AI review/i);
    assert.equal(render({ ...reference, url: "https://example.com/fake" }), "", "purchase action only links to a validated eBay listing");
    const profitable = render({ ...reference, pricing: { ...reference.pricing, profit: 15, roi: .1 } });
    assert.match(profitable, /Projected resale profit/);
    assert.doesNotMatch(profitable, /Projected resale loss|Outside Deals/);
    const labelChecked = { ...reference, identity: "LABEL", seller: { username: "example", feedbackScore: 350, feedbackPercentage: 100 } };
    assert.match(render(labelChecked), /Fair buy for a collector/);
    assert.match(render(labelChecked), /Matched the card and PSA label/);
    assert.doesNotMatch(render({ ...labelChecked, seller: reference.seller }), /Fair buy for a collector/);
    assert.match(render({ ...reference, shipping: 0 }), /free shipping/);
});

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
    assert.match(card, /Wait for resale evidence/);
    assert.doesNotMatch(card, /Max price:|Est\. net profit|Offer \$|Below your price limit/);
    const decision = render(FinancialDecision);
    assert.match(decision, /Wait for resale evidence/);
    assert.doesNotMatch(decision, /Run full research|Max price|Your review needed/);
    const details = render(AnalysisDetails, { onReanalyze() {}, minGrade: 0, reviewing: false });
    assert.doesNotMatch(details + card + decision, /\$500/);
    assert.doesNotMatch(details + decision, /TCGplayer/i);
    assert.match(card, /TCGplayer market<\/dt><dd>Unverified<\/dd>/);
    assert.doesNotMatch(details, /Clears your targets|Selected strategy: sell raw|Suggested offer|Walk away above/);
    const panel = render(DetailPanel, { analysis: { status: "done", evaluation: value }, includeOffers: false,
        onClose() {}, onAnalyze() {}, onPhotoReview() {}, onRefreshPrices() {},
        priceRefresh: { status: "error", evidenceKey: "saved", message: "Price research unavailable" } });
    assert.match(panel, /Refresh pricing/);
    assert.match(panel, /Reanalyze full listing \(paid\)/);
    assert.match(panel, /Pricing refresh failed\. Price research unavailable/);
    assert.doesNotMatch(panel, /Your saved assessment is still shown/);
    assert.match(panel, /AI photo review complete/);
    assert.doesNotMatch(render(PathCard, { path: value.underwriting.best, auction: true, referenceReason: "Unverified resale reference" }), /Max bid|Profit at your max bid/);
    // An older saved verdict must not revive a recommendation, even when a
    // genuine photo concern also requires attention.
    value.underwriting.verdict = "BUY_RAW";
    value.condition!.authenticity = { concern: "UNCERTAIN", reasons: ["Unresolved physical authenticity evidence."] };
    const stale = render(DealCard, { analysis: { status: "done", evaluation: value }, selected: false, onOpen() {}, years: {} });
    assert.match(stale, /Wait/);
    assert.doesNotMatch(stale, /Your review needed/);
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
    assert.match(card, /Wait for shipping/);
    assert.match(card + decision, /Modeled net profit at asking/);
    assert.match(card + decision + details, /Provisional max price/);
    assert.doesNotMatch(card + decision + details, /Free shipping|Clears your targets|Below your price limit|Suggested offer|Selected strategy/);
});

test("raw asking quotes remain references in the buyer interface", async t => {
    const server = await createServer({ configFile: path.resolve("client/vite.config.js"), envFile: false, appType: "custom", logLevel: "silent",
        server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => server.close());
    const { DealCard } = await server.ssrLoadModule("/src/components/DealCard.tsx");
    const { FinancialDecision } = await server.ssrLoadModule("/src/components/analysis/FinancialDecision.tsx");
    const { AnalysisDetails } = await server.ssrLoadModule("/src/components/analysis/AnalysisDetails.tsx");
    const { AuctionSummary } = await server.ssrLoadModule("/src/components/AuctionSummary.tsx");
    const now = Date.parse("2026-11-24T15:00:00Z"), stamp = new Date(now).toISOString();
    const targets = { minProfit: 0, minRoi: 0 }, evaluation = cardEvaluation(targets);
    Object.assign(evaluation.listing, { buyingOption: "FIXED_PRICE", availability: "ACTIVE", endTime: null, price: 20, shipping: 0 });
    const listing = { ...evaluation.listing, currentPrice: evaluation.listing.price, images: [], isGraded: false };
    const sold = salesSummary("RAW", "LIGHTLY_PLAYED", [68, 70, 72]);
    for (const [i, sale] of sold.sales.entries()) Object.assign(sale, {
        soldAt: new Date(now - [5, 45, 65][i] * 86_400_000).toISOString(), saleType: "fixed_price", url: `https://www.ebay.com/itm/${120000020000 + i}`,
    });
    evaluation.gradedPricing = null;
    evaluation.rawPricing = { status: "PRICED", conditionEvidence: "TCGPLAYER", printing: "UNLIMITED", finish: "HOLO", ebayComps: [sold], prices: [{
        condition: "LIGHTLY_PLAYED", price: 63, updatedAt: stamp, basis: "TCGPLAYER_OFFERS",
        offers: { source: "TCGPLAYER", currency: "USD", condition: "LIGHTLY_PLAYED", printing: "Unlimited Holofoil", checkedAt: stamp,
            snapshotAt: stamp, method: "LOWEST_DELIVERED_COMPETITION", marketCondition: "Lightly Played", price: 63, low: 63, median: 63, high: 63,
            marketPrice: 68, sellerCount: 1, offers: [{ id: "offer-1", sellerId: "seller-1", sellerName: "Fixture", price: 60, shipping: 3, total: 63, quantity: 1, snapshotAt: stamp }] },
    }] };
    evaluation.underwriting = underwrite(evaluation, { ...MONEY_CONFIG, targets });
    assert.equal(evaluation.underwriting.best, null);
    const props = { listing, evaluation, now, targets };
    const renderCard = () => renderToStaticMarkup(createElement(DealCard, { ...props, analysis: { status: "done", evaluation }, selected: false,
        onOpen() {}, years: {}, includeOffers: false }));
    const renderDecision = () => renderToStaticMarkup(createElement(FinancialDecision, props));
    const card = renderCard();
    const decision = renderDecision();
    const details = renderToStaticMarkup(createElement(AnalysisDetails, { ...props, minGrade: 0, reviewing: false }));
    assert.doesNotMatch(card + decision, /Buy ·|Buy this copy|Max item price/i);
    assert.match(details, /TCGplayer/i);
    const auction = renderToStaticMarkup(createElement(AuctionSummary, { evaluation, targets, now }));
    assert.match(auction, /No reliable bid limit/);
});

test("the live buyer-review path displays only the verified resale route and counts a supported lower-condition floor", async t => {
    const server = await createServer({ configFile: path.resolve("client/vite.config.js"), envFile: false, appType: "custom", logLevel: "silent",
        server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => server.close());
    const { DealCard } = await server.ssrLoadModule("/src/components/DealCard.tsx");
    const { DetailPanel } = await server.ssrLoadModule("/src/components/DetailPanel.tsx");
    const now = Date.parse("2026-11-25T17:20:00Z"), stamp = new Date(now).toISOString();
    const searchId = "0151ea5e-490c-422f-a4ee-a830b11cecef", id = "v1|123456789012|0";
    const targets = { minProfit: 0, minRoi: 0 };
    const evaluation = cardEvaluation(targets);
    Object.assign(evaluation.listing, { id, title: "Alakazam Base Set 1/102 Unlimited Holo", buyingOption: "FIXED_PRICE",
        endTime: null, availability: "ACTIVE", price: 60, shipping: 5, termsCheckedAt: stamp, photos: [] });
    Object.assign(evaluation.identity!, { name: "Alakazam", cardNumber: "1/102" });
    Object.assign(evaluation, { answeredAt: stamp, pricesCheckedAt: stamp, pricingVersion: PRICING_VERSION,
        assessmentVersion: "fixture/bounded-prompts-4", conditionVersion: "fixture/bounded-condition-1/prompts-1" });
    evaluation.photoCheck!.cardCount = "ONE";
    const comp = (grader: string, grade: number | string, prices: number[]) => {
        const summary = salesSummary(grader, grade, prices);
        for (const [i, sale] of summary.sales.entries()) Object.assign(sale, {
            soldAt: new Date(now - (i + 1) * 86_400_000).toISOString(), saleType: "fixed_price",
            url: `https://www.ebay.com/itm/${120000020000 + 100 * (typeof grade === "number" ? grade : 5) + i}`,
            title: evaluation.listing.title + (typeof grade === "number" ? ` ${grader} ${grade}` : ""),
            ...(grader === "RAW" && { photoCondition: "LIGHTLY_PLAYED", conditionEvidence: ["Whitening along the back edge."] }),
        });
        return summary;
    };
    const raw = comp("RAW", "LIGHTLY_PLAYED", [105, 110, 115]);
    evaluation.rawPricing = { status: "PRICED", printing: "UNLIMITED", variant: "Unlimited Holofoil", conditionEvidence: "AI_PHOTOS",
        sellerConditionComps: null, prices: [{ condition: "LIGHTLY_PLAYED", basis: "EBAY_SOLD", price: 110, updatedAt: stamp, comps: raw }] };
    evaluation.gradedPricing = { PSA: { status: "PRICED", grader: "PSA", printing: "UNLIMITED", variant: "Unlimited Holofoil",
        byGrade: [comp("PSA", 6, [120, 125, 130]), comp("PSA", 7, [320, 325, 330]), comp("PSA", 8, [445, 450, 455])] } };
    const unexpected = async (): Promise<never> => assert.fail("provider or storage write called from saved-only review");
    const read = createBuyerListingReviewer({ now: () => now,
        discovery: async () => ({ searchId, savedAt: stamp, discovery: { total: 1, found: 1, skipped: 0, deferred: 0, retainedIds: [id] } }),
        inventory: async () => null, snapshot: async () => ({ version: 1, searchId, contextKey: "fixture", evidenceKey: "fixture", evaluation }),
        restorePhotoReview: async value => value, restoreSales: async () => undefined, evaluate: unexpected, deeper: unexpected,
        supplement: unexpected, save: unexpected });
    const review = () => read(searchId, id, targets, false, false, new AbortController().signal);
    const checked = await review();
    assert.equal(checked.decision, "BUY");
    assert.equal(checked.evaluation?.underwriting?.best?.path, "GRADE", "preserve the modeled alternative");
    assert.equal(checked.evaluation?.underwriting?.best?.downside, -47.11);
    assert.equal(checked.verifiedPurchase?.path.path, "RAW");
    assert.equal(checked.verifiedPurchase?.path.profit, 17.08);
    assert.equal(checked.verifiedPurchase?.maxItemPrice, 75.77);
    const listing: ListingSummary = { ...evaluation.listing, currentPrice: evaluation.listing.price, images: [], isGraded: false };
    const props = { listing, now, targets, automaticDecision: checked, analysis: { status: "done", evaluation: checked.evaluation },
        includeOffers: false, onClose() {}, onAnalyze() {}, onPhotoReview() {}, selected: false, years: {}, onOpen() {} };
    const card = renderToStaticMarkup(createElement(DealCard, props));
    const panel = renderToStaticMarkup(createElement(DetailPanel, props));
    for (const html of [card, panel]) {
        assert.match(html, /\$75\.77/);
        assert.doesNotMatch(html, /Buy \+ grade|\$159\.31/);
    }
    assert.match(card, /\$17\.08/);
    assert.match(panel, /Grade with PSA · modeled alternative/);
    assert.doesNotMatch(panel, /PSA · selected/);
    assert.match(card, /3 matching sold comps \/ 60 days/);
    for (const change of [{ now: now + BEST_BUY_TERMS_MAX_AGE_MS }, { targets: { ...targets, minProfit: 20 } },
        { analysis: { ...props.analysis, evaluation: { ...checked.evaluation!, listing: { ...checked.evaluation!.listing, shippingDestination: "11111" } } } }]) {
        for (const Component of [DealCard, DetailPanel]) {
            const stale = renderToStaticMarkup(createElement(Component, { ...props, ...change }));
            assert.match(stale, /verified price or purchase terms need a fresh check/);
            assert.doesNotMatch(stale, /\$75\.77|\$159\.31|Buy \+ grade/);
        }
    }

    evaluation.listing.price = 40;
    evaluation.condition!.rawCondition = "NEAR_MINT";
    evaluation.condition!.gradeRange = null;
    evaluation.gradedPricing = null;
    evaluation.rawPricing.prices![0] = { ...evaluation.rawPricing.prices![0], price: 100, comps: comp("RAW", "LIGHTLY_PLAYED", [95, 100, 105]) };
    const floor = await review();
    assert.equal(floor.decision, "BUY");
    assert.equal(floor.verifiedPurchase?.path.priceCondition, "LIGHTLY_PLAYED");
    assert.equal(floor.verifiedPurchase?.path.profit, 30.20);
    assert.equal(floor.verifiedPurchase?.maxItemPrice, 67.89);
    assert.match(floor.reason, /photo-checked Lightly Played resale floor of \$100\.00/);
    assert.match(floor.reason, /3 observed matching Lightly Played raw sales in the last 60 days/);
    const floorCard = renderToStaticMarkup(createElement(DealCard, { ...props, listing: { ...listing, currentPrice: 40 },
        automaticDecision: floor, analysis: { status: "done", evaluation: floor.evaluation } }));
    assert.match(floorCard, /3 matching sold comps \/ 60 days/);
    evaluation.rawPricing.prices![0].comps!.sales[0].conditionEvidence = [];
    assert.equal((await review()).decision, "WAIT", "unverified condition evidence cannot support the floor");
});
