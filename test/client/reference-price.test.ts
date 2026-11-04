import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";

test("reference-only prices preserve useful estimates without buy limits, offer suggestions or paid photo-retry copy", async t => {
    const server = await createServer({ configFile: path.resolve("client/vite.config.js"), envFile: false, appType: "custom", logLevel: "silent",
        server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => server.close());
    const { DealCard } = await server.ssrLoadModule("/src/components/DealCard.tsx");
    const { FinancialDecision, PathCard } = await server.ssrLoadModule("/src/components/analysis/FinancialDecision.tsx");
    const { AnalysisDetails } = await server.ssrLoadModule("/src/components/analysis/AnalysisDetails.tsx");
    const targets = { minProfit: 0, minRoi: 0 }, value = cardEvaluation(targets);
    value.listing = { ...value.listing, buyingOption: "FIXED_PRICE", price: 380, shipping: 0 };
    value.photoCheck!.cardCount = "ONE";
    value.condition!.rawCondition = "MODERATELY_PLAYED"; value.condition!.gradeRange = null;
    value.rawPricing = { status: "PRICED", prices: [{ condition: "MODERATELY_PLAYED", price: 500, basis: "TCGPLAYER", updatedAt: null }] };
    value.gradedPricing = null;
    value.underwriting = underwrite(value, { ...MONEY_CONFIG, targets });
    const listing = { ...value.listing, currentPrice: 380, isGraded: false, images: [], bestOffer: true };
    const props = { listing, evaluation: value, targets, now: Date.now() };
    const render = (component: any, other: object = {}) => renderToStaticMarkup(createElement(component, { ...props, ...other }));
    assert.equal(value.underwriting.verdict, "CANT_PRICE");
    const card = render(DealCard, { analysis: { status: "done", evaluation: value }, selected: false, onOpen() {}, years: {} });
    assert.match(card, /Price unconfirmed/);
    assert.doesNotMatch(card, /Max price:|Est\. net profit|Offer \$|Below your price limit/);
    const decision = render(FinancialDecision);
    assert.match(decision, /Resale price unconfirmed|Reference resale estimate/);
    assert.doesNotMatch(decision, /Run full research|Max price|Your review needed/);
    const details = render(AnalysisDetails, { onReanalyze() {}, minGrade: 0, reviewing: false });
    assert.match(details, /reference estimate|Downside resale value|Unknown/);
    assert.doesNotMatch(details, /Clears your targets|Selected strategy: sell raw|Suggested offer|Walk away above|Reanalyze full listing|Run full research/);
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
