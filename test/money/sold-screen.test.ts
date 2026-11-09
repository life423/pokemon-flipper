import { test } from "node:test";
import assert from "node:assert/strict";
import { applySoldPriceScreen } from "../../shared/money/sold-screen.ts";
import { MONEY_CONFIG, type MoneyConfig } from "../../shared/money/config.ts";
import { analysisPriority } from "../../shared/analysis-priority.ts";
import { canAutoAnalyze, resultGroup } from "../../shared/analysis.ts";
import { retargetScreen } from "../../shared/money/targets.ts";
import type { ListingSummary, ScreeningSoldEvidence, ScreeningSoldReference } from "../../shared/types.ts";

// Deliberately simple transaction costs make these worked comparisons
// independent of current account fee defaults: 10% + $0.40 on sale, delivery
// $8 slab/$6 raw, no purchase or buyer tax, and a $50 profit target.
const config: MoneyConfig = {
    ...MONEY_CONFIG,
    targets: { minProfit: 50, minRoi: 0 },
    buying: { salesTaxRate: 0, assumedShippingWhenUnknown: 7 },
    selling: { ...MONEY_CONFIG.selling, finalValueRate: 0.1, finalValueRateAboveLimit: 0.1,
        perOrderFee: 0.4, perOrderFeeSmall: 0.4, typicalBuyerTaxRate: 0, promotedRate: 0,
        shipping: { raw: 6, graded: 8 } },
};

function reference(patch: Partial<ScreeningSoldReference> = {}): ScreeningSoldReference {
    return {
        recordId: 1, name: "Blastoise", set: "Base Set", cardNumber: "2/102", printing: "UNLIMITED", finish: "HOLO",
        grader: "PSA", grade: "8", condition: null,
        summary: { grader: "PSA", grade: "8", windowDays: 90, count: 3, median: 300, low: 250, high: 350,
            newestSale: "2026-11-02T00:00:00Z", confidence: "LOW", dropped: {}, sales: [
                { price: 250, soldAt: "2026-11-01T00:00:00Z", title: "Blastoise PSA 8", url: null },
                { price: 300, soldAt: "2026-11-01T00:00:00Z", title: "Blastoise PSA 8", url: null },
                { price: 350, soldAt: "2026-11-02T00:00:00Z", title: "Blastoise PSA 8", url: null },
            ] },
        ...patch,
    };
}
function evidence(references = [reference()], patch: Partial<ScreeningSoldEvidence> = {}): ScreeningSoldEvidence {
    return { status: "AVAILABLE", exactScope: true, references, note: "Matched recent USD sold records.", ...patch };
}
function listing(patch: Partial<ListingSummary> = {}): ListingSummary {
    return { id: "listing", title: "Blastoise Base Set PSA 8", currentPrice: 250, shipping: 5, bids: 0,
        isGraded: true, buyingOption: "FIXED_PRICE", endTime: null, images: [], url: "https://www.ebay.com/itm/listing", seller: null, ...patch };
}

test("a slab's upper sold value permits assessment even when its median fails the target", () => {
    const source = evidence();
    const result = applySoldPriceScreen(listing(), source, { config }).screen;
    // Median $300 - $30.40 fee - $8 delivery = $261.60. Upper $350
    // yields $306.60. A $250 + $5 purchase leaves $51.60 at that upper.
    assert.equal(result.status, "CANDIDATE");
    assert.equal(result.needsAnalysis, "SLAB_LABEL");
    assert.equal(result.money?.paths[0].expectedNet, 261.6);
    assert.equal(result.money?.paths[0].fixedCosts, 0);
    assert.equal(result.money?.paths[0].path, "GRADED_RESALE");
    assert.equal(result.bestCase?.profit, 51.6);
    assert.equal(result.bestCase?.maxBid, 251.6);
    assert.equal(result.soldEvidence, source);
    assert.match(result.reason!, /preliminary/i);
});

test("a clearly overpriced exact slab is excluded using fees, shipping and targets before AI", () => {
    const result = applySoldPriceScreen(listing({ currentPrice: 290 }), evidence(), { config }).screen;
    assert.equal(result.status, "DROPPED");
    assert.equal(result.needsAnalysis, undefined);
    assert.equal(result.bestCase?.profit, 11.6);
    assert.equal(result.requiresOffer, false);
    assert.match(result.reason!, /upper recent matched sold price/);
});

test("a 15% buffer above the preliminary ceiling admits slab verification only", () => {
    const source = evidence();
    const endTime = new Date(Date.now() + 60_000).toISOString();
    for (const buyingOption of ["FIXED_PRICE", "AUCTION"] as const) {
        const terms = listing({ currentPrice: 289.34, buyingOption, endTime: buyingOption === "AUCTION" ? endTime : null, images: ["photo"] });
        const within = applySoldPriceScreen(terms, source, { config });
        assert.equal(within.screen.status, "CANDIDATE");
        assert.equal(within.screen.bestCase?.maxBid, 251.6);
        assert.equal(within.screen.bestCase?.profit, 12.26);
        assert.equal(within.screen.requiresOffer, false);
        assert.match(within.screen.reason!, /within 15% above the preliminary limit/);
        assert.equal(canAutoAnalyze(within), true);
        assert.equal(resultGroup(within, null), "candidates");
        if (buyingOption === "AUCTION") assert.equal(canAutoAnalyze({ ...within, endTime: new Date(Date.now() + 13 * 3_600_000).toISOString() }), false);
        const outside = applySoldPriceScreen({ ...terms, currentPrice: 289.35 }, source, { config });
        assert.equal(outside.screen.status, "DROPPED");
        assert.equal(canAutoAnalyze(outside), false);
    }
    const noCeiling = applySoldPriceScreen(listing({ currentPrice: 0.01, shipping: 400 }), source, { config });
    assert.equal(noCeiling.screen.bestCase?.maxBid, 0);
    assert.equal(noCeiling.screen.status, "DROPPED");
});

test("unknown purchase shipping cannot cause a false exclusion", () => {
    // Upper proceeds $306.60 - price $256.60 = exactly $50; adding an
    // assumed $7 would wrongly exclude it. The estimate discloses its $0.
    const result = applySoldPriceScreen(listing({ currentPrice: 256.6, shipping: null }), evidence(), { config }).screen;
    assert.equal(result.status, "CANDIDATE");
    assert.equal(result.bestCase?.profit, 50);
    assert.equal(result.money?.shipping, 0);
    assert.match(result.assumed!, /shipping is unknown; \$0/);
});

test("conditional offers are opt-in, limited to ten percent, and never apply to auctions", () => {
    const noFees = { ...config, targets: { minProfit: 0, minRoi: 0 }, selling: { ...config.selling, finalValueRate: 0,
        finalValueRateAboveLimit: 0, perOrderFee: 0, perOrderFeeSmall: 0, shipping: { raw: 0, graded: 0 } } };
    const original = reference();
    const source = evidence([reference({ summary: { ...original.summary, median: 90, low: 80, high: 100 } })]);
    const terms = listing({ currentPrice: 110, shipping: 0, bestOffer: true });
    const optedOut = applySoldPriceScreen(terms, source, { config: noFees }).screen;
    assert.equal(optedOut.status, "CANDIDATE");
    assert.equal(optedOut.requiresOffer, false);
    const offered = applySoldPriceScreen(terms, source, { config: noFees, includeOffers: true }).screen;
    assert.equal(offered.status, "CANDIDATE");
    assert.equal(offered.requiresOffer, true);
    assert.match(offered.reason!, /only if the seller accepts/);
    for (const outsideOfferPolicy of [{ ...terms, currentPrice: 112 }, { ...terms, buyingOption: "AUCTION" as const }]) {
        const screened = applySoldPriceScreen(outsideOfferPolicy, source, { config: noFees, includeOffers: true }).screen;
        assert.equal(screened.status, "CANDIDATE");
        assert.equal(screened.requiresOffer, false);
    }
});

test("unsettled editions, finishes or slab grades retain research without assigning a profitable market", () => {
    const terms = listing({ currentPrice: 1, images: ["front", "back"] });
    const original = reference();
    const otherGrade = reference({ grade: "9", summary: { ...original.summary, grade: "9" } });
    for (const source of [evidence([original], { exactScope: false }), evidence([original, otherGrade]),
        evidence([original, { ...otherGrade, summary: { ...otherGrade.summary, count: 2 } }]),
        evidence([original, reference({ printing: "FIRST_EDITION" })]), evidence([original, reference({ finish: "REVERSE_HOLO" })])]) {
        const result = applySoldPriceScreen(terms, source, { config }).screen;
        assert.equal(result.status, "UNSCREENED");
        assert.equal(result.needsAnalysis, "SLAB_LABEL");
        assert.equal(result.bestCase, null);
        assert.equal(result.money, undefined);
        assert.equal(result.soldEvidence, source);
        assert.equal(canAutoAnalyze({ ...terms, screen: result }), true, "uncertain identity remains researchable, not rejected");
        const priority = analysisPriority({ ...terms, screen: result }, { minProfit: 0, minRoi: 0 });
        assert.equal(priority.band, 0);
        assert.equal(priority.expectedProfit, null);
        assert.equal(retargetScreen(result, 1, { minProfit: 0, minRoi: 0 }).money, undefined);
    }
});

test("First Edition prices cannot price or prioritize an Unlimited copy, including stale saved screening money", () => {
    const original = reference();
    const premium = evidence([reference({ printing: "FIRST_EDITION", summary: { ...original.summary, median: 1000, low: 900, high: 1100 } })]);
    const terms = listing({ currentPrice: 150, images: ["front", "back"], screen: { status: "UNSCREENED", reason: null, assumed: null, bestCase: null,
        card: { name: "Blastoise", set: "Base Set", cardNumber: "2/102", printing: "UNLIMITED", printingLabel: "Unlimited" } } });
    const oldMoney = applySoldPriceScreen(listing({ currentPrice: 150 }), premium, { config }).screen.money;
    assert.ok(oldMoney, "an explicitly First Edition market can support its own preliminary math");
    const stale = { ...terms, screen: { ...terms.screen!, soldEvidence: premium, money: oldMoney } };
    assert.equal(analysisPriority(stale, { minProfit: 0, minRoi: 0 }).expectedProfit, null);
    const corrected = applySoldPriceScreen(stale, premium, { config });
    assert.equal(corrected.screen.money, undefined);
    assert.equal(corrected.screen.bestCase, null);
    assert.equal(corrected.screen.status, "UNSCREENED");
    assert.equal(analysisPriority(corrected, { minProfit: 0, minRoi: 0 }).band, 0);
    assert.deepEqual(corrected.screen.soldEvidence, premium, "retain original market observations without relabeling them");
});

test("older matched sales can inform priority but cannot justify a hard rejection", () => {
    const original = reference();
    const result = applySoldPriceScreen(listing({ currentPrice: 10000 }), evidence([
        reference({ summary: { ...original.summary, windowDays: 180 } }),
    ]), { config }).screen;
    assert.equal(result.status, "UNSCREENED");
    assert.ok(result.money);
    assert.equal(result.bestCase, null);
});

test("raw sold-condition buckets remain separate comparisons without assigning a live-card condition or grade", () => {
    const original = reference();
    const raw = (condition: "NEAR_MINT" | "LIGHTLY_PLAYED", median: number) => reference({ grader: null, grade: null, condition,
        summary: { ...original.summary, grader: "RAW", grade: condition, median, low: median - 10, high: median + 10 } });
    const source = evidence([raw("NEAR_MINT", 200), raw("LIGHTLY_PLAYED", 100)]);
    const result = applySoldPriceScreen(listing({ isGraded: false, currentPrice: 10000 }), source, { config }).screen;
    assert.equal(result.status, "UNSCREENED");
    assert.equal(result.needsAnalysis, "IDENTITY");
    assert.equal(result.bestCase, null);
    assert.equal(result.requiresOffer, false);
    assert.deepEqual(result.money?.paths.map((path) => path.expectedNet), [173.6, 83.6]);
    assert.deepEqual(result.money?.paths.map((path) => path.path), ["RAW", "RAW"]);
    assert.equal(result.money?.usual, null);
    assert.equal(result.money?.rawFloorNet, undefined);
    assert.equal(result.soldEvidence, source);
    assert.match(result.reason!, /priority only/);
});

test("unspecified raw sold conditions are usable context without a raw quote or numerical ceiling", () => {
    const original = reference();
    const source = evidence([reference({ grader: null, grade: null, condition: null,
        summary: { ...original.summary, grader: "RAW", grade: "UNSPECIFIED" } })]);
    const result = applySoldPriceScreen(listing({ isGraded: false }), source, { config }).screen;
    assert.equal(result.soldEvidence?.status, "AVAILABLE");
    assert.equal(result.status, "UNSCREENED");
    assert.equal(result.needsAnalysis, "IDENTITY");
    assert.equal(result.money, undefined);
    assert.equal(result.bestCase, null);
    assert.match(result.reason!, /condition is unspecified/);
});

test("empty, invalid, stale or wrong-grade summaries never become zero-valued financial advice", () => {
    const original = reference();
    for (const patch of [{ count: 0 }, { median: 0 }, { median: Infinity }, { low: NaN }, { high: 200 },
        { windowDays: 181 }, { windowDays: undefined }, { grader: "CGC" }, { grade: "9" }]) {
        const source = evidence([reference({ summary: { ...original.summary, ...patch } })]);
        const result = applySoldPriceScreen(listing(), source, { config }).screen;
        assert.equal(result.status, "UNSCREENED", JSON.stringify(patch));
        assert.equal(result.money, undefined);
        assert.equal(result.bestCase, null);
        assert.equal(result.soldEvidence?.status, "UNAVAILABLE");
        assert.equal(result.soldEvidence?.references, source.references);
    }
});

test("missing or deferred sold evidence clears old ceilings but preserves photo metadata and cheap-edition exceptions", () => {
    const card = { name: "Blastoise", set: "Base Set", cardNumber: "2/102", printing: "FIRST_EDITION" as const, printingLabel: "1st Edition" };
    const photoEvidence = { photos: 2, mainPhoto: "UNKNOWN" as const };
    const terms = listing({ currentPrice: 5, isGraded: false, screen: { status: "DROPPED", card, evidence: photoEvidence,
        focusedReview: "CHEAP_FIRST_EDITION_BASE_SET", reason: "Old ceiling", bestCase: { label: "Old", maxBid: 1, profit: -4, roi: -0.8 }, assumed: "Old",
        money: { shipping: 0, paths: [{ label: "Old", expectedNet: 1, fixedCosts: 0 }], auction: false, usual: null } } });
    for (const status of ["UNAVAILABLE", "DEFERRED"] as const) {
        const source = evidence([], { status, note: "Research deferred." });
        const result = applySoldPriceScreen(terms, source, { config }).screen;
        assert.equal(result.status, "UNSCREENED");
        assert.equal(result.money, undefined);
        assert.equal(result.bestCase, null);
        assert.equal(result.focusedReview, "CHEAP_FIRST_EDITION_BASE_SET");
        assert.equal(result.card, card);
        assert.equal(result.evidence, photoEvidence);
        assert.equal(result.reason, "Research deferred.");
    }
    assert.equal(terms.screen?.money?.paths[0].expectedNet, 1);
    assert.equal(terms.screen?.status, "DROPPED");
});

test("sale evidence stays public and immutable while each owner's targets and costs change privately", () => {
    const source = evidence();
    const before = JSON.stringify(source);
    const easy = applySoldPriceScreen(listing(), source, { config, targets: { minProfit: 0, minRoi: 0 } });
    const strict = applySoldPriceScreen(listing(), source, { config, targets: { minProfit: 100, minRoi: 0 } });
    const taxed = applySoldPriceScreen(listing(), source, { config: { ...config, buying: { ...config.buying, salesTaxRate: 0.2 } } });
    assert.equal(easy.screen.status, "CANDIDATE");
    assert.equal(strict.screen.status, "DROPPED");
    assert.equal(taxed.screen.status, "DROPPED");
    assert.equal(JSON.stringify(source), before);
    assert.equal(easy.screen.soldEvidence, source);
    assert.equal(strict.screen.soldEvidence, source);
});
