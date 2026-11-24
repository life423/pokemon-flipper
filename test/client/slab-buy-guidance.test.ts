import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { resultGroup } from "../../shared/analysis.ts";
import { slabBuyGuidance } from "../../shared/money/slab-buy-guidance.ts";
import type { ListingSummary } from "../../shared/types.ts";

const now = Date.parse("2026-11-24T13:09:12Z");
function example() {
    const e = cardEvaluation();
    Object.assign(e.listing, { id: "slab", title: "Dark Gengar 6/105 CGC 8.5", availability: "ACTIVE", buyingOption: "FIXED_PRICE", price: 999, shipping: 0, termsCheckedAt: new Date(now).toISOString() });
    Object.assign(e.identity!, { name: "Dark Gengar", set: "Neo Destiny", cardNumber: "6/105", hasEditions: true });
    e.condition = null; e.gradedPricing = null; e.rawPricing = null;
    e.slab = { status: "OK", grader: "CGC", grade: "8.5", gradeQualifier: null, certNumber: null, certUrl: null,
        labelText: "Dark Gengar Neo Destiny Unlimited Holo CGC 8.5", caseCondition: "SCRATCHED", concerns: [], reasons: [] };
    Object.assign(e.photoCheck!, { holder: "GRADED_SLAB", cardCount: "ONE", slab: { ...e.slab, present: true, authenticity: "NONE_SEEN" } });
    e.underwriting = { verdict: "CANT_PRICE", best: null, reasons: ["No verified CGC 8.5 sales of the Unlimited printing."], paths: [], assumptions: [] };
    e.rating = null;
    e.trackerPriceReference = { source: "POKEMON_PRICE_TRACKER", tcgPlayerId: 1, printingLabel: "Unlimited Holofoil", caveat: "Individual sale titles unavailable.", gradedMarket: {
        grader: "CGC", grade: "8.5", statistic: "HISTORICAL_MEDIAN", priceUsd: 874.50, reportedSales: 8, lastSaleAt: "2026-10-26", marketplaces: ["eBay", "Fanatics Collect"],
        filteredEstimate: { days: 90, confidence: "MEDIUM", priceUsd: 927.93 } } };
    return e;
}
const listing: ListingSummary = { id: "slab", title: "Dark Gengar 6/105 CGC 8.5", currentPrice: 999, shipping: 0, bids: 0, isGraded: true, buyingOption: "FIXED_PRICE", endTime: null, images: [], url: "#", seller: null };

test("a verified CGC label with a scratched holder gets an estimated market value on the card and in analysis", async t => {
    const e = example();
    const server = await createServer({ configFile: "client/vite.config.js", envFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => server.close());
    const { DealCard } = await server.ssrLoadModule("/src/components/DealCard.tsx"), { DetailPanel } = await server.ssrLoadModule("/src/components/DetailPanel.tsx");
    const props = { now, years: {}, listing, analysis: { status: "done", evaluation: e }, onClose() {}, onOpen() {}, onAnalyze() {} };
    for (const Component of [DealCard, DetailPanel]) {
        const html = renderToStaticMarkup(createElement(Component, props));
        assert.match(html, /Wait at this price/);
        assert.match(html, /Estimated CGC 8\.5 market value/);
        assert.match(html, /\$927\.93/); assert.match(html, /90-day provider estimate · medium confidence/);
        assert.match(html, /8 reported sales across all dates · latest 2026-10-26/);
        assert.match(html, /holder has visible scratches/);
        if (Component === DetailPanel) assert.match(html, /\$874\.50 historical median/);
    }
    assert.notEqual(resultGroup(listing, e), "deals");
    e.listing.price = 200;
    assert.equal(slabBuyGuidance(e, now)?.headline, "Possible margin at the estimate");
    assert.notEqual(resultGroup(listing, e), "deals");
    e.listing.shipping = null;
    assert.equal(slabBuyGuidance(e, now)?.headline, "Estimated market value");
});

test("unsupported or expired provider statistics cannot price a slab and asking prices are never treated as sales", () => {
    const e = example(), tracker = e.trackerPriceReference!;
    tracker.gradedMarket.grade = "9"; assert.equal(slabBuyGuidance(e, now), null);
    tracker.gradedMarket.grade = "8.5";
    tracker.gradedMarket.statistic = "7_DAY_MEDIAN"; tracker.gradedMarket.lastSaleAt = "2026-11-23";
    assert.equal(slabBuyGuidance(e, now)?.price, 874.5);
    assert.match(slabBuyGuidance(e, now)!.evidence, /7-day median/);
    tracker.gradedMarket.lastSaleAt = "2026-10-26";
    assert.equal(slabBuyGuidance(e, Date.parse("2027-01-26")), null);
    delete tracker.printingLabel; assert.equal(slabBuyGuidance(e, now), null);
    const sale = { priceUsd: 900, title: listing.title, kind: "SOLD" as const, date: "2026-11-01", url: "https://www.ebay.com/itm/123456789012" };
    e.webPriceResearch = { checkedAt: new Date(now).toISOString(), observations: [{ ...sale, kind: "ASK" }] };
    assert.equal(slabBuyGuidance(e, now), null);
    e.webPriceResearch.observations.push(sale, sale, { ...sale, priceUsd: 100, date: "2025-11-01", url: "https://www.ebay.com/itm/123456789013" });
    assert.equal(slabBuyGuidance(e, now)?.price, 900); assert.equal(slabBuyGuidance(e, now)?.count, 1);
    e.identity!.printing = "UNKNOWN"; assert.equal(slabBuyGuidance(e, now), null);
    e.identity!.printing = "UNLIMITED"; e.slab!.caseCondition = "CRACKED"; assert.equal(slabBuyGuidance(e, now), null);
});
