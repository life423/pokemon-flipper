import assert from "node:assert/strict";
import { test } from "node:test";
import { relistEstimate } from "../../shared/money/relist-estimate.ts";
import type { DealHuntAction } from "../../shared/deal-hunt.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { acquisitionCost, underwrite } from "../../shared/money/underwriting.ts";
import { applyVerifiedPurchase } from "../../shared/money/verified-purchase.ts";
import { cents, meetsMoneyTargets } from "../../shared/money/cents.ts";
import { PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import { dealHuntCandidate, flipResaleEvidence } from "../../server/analysis/deal-hunt-evidence.ts";
import { FlipEvaluations } from "../../server/analysis/flip-evaluations.ts";
import { listingMarketPrices } from "../../shared/listing-market-prices.ts";
import { rankHuntMarkets } from "../../server/analysis/same-set-markets.ts";
import { cardEvaluation, matchedRawPrice, salesSummary } from "../fixtures/card-evaluation.ts";
import { tcgplayerRawEstimate } from "../fixtures/tcgplayer-raw-estimate.ts";

const now = Date.now();
const stamp = new Date(now).toISOString();
const checked = new Set<DealHuntAction>(["check_listing", "inspect_photos", "check_sales", "calculate_grading"]);

function rawCard(lowerPrice = 250) {
    const e = cardEvaluation({ minProfit: 0, minRoi: 0 });
    Object.assign(e, { pricesCheckedAt: stamp, pricingVersion: PRICING_VERSION, assessmentVersion: "offline/bounded-prompts-4", conditionVersion: "offline/bounded-condition-1/prompts-1" });
    Object.assign(e.listing, { availability: "ACTIVE", buyingOption: "FIXED_PRICE", price: 60, shipping: 0, termsCheckedAt: stamp });
    e.photoCheck!.cardCount = "ONE";
    e.rawPricing = null;
    const byGrade = [lowerPrice, 425, 450].map((p, i) => {
        const s = salesSummary("PSA", 6 + i, [p, p, p]);
        s.sales.forEach(sale => { sale.saleType = "fixed_price"; });
        return s;
    });
    e.gradedPricing = { PSA: { status: "PRICED", source: "pkmnprices", printing: "UNLIMITED", variant: "holo", byGrade } };
    e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets: { minProfit: 0, minRoi: 0 } });
    return e;
}

test("an asking quote alone cannot authorize buying or establish a liquid market", () => {
    const e = rawCard();
    e.gradedPricing = null;
    e.rawPricing = { status: "PRICED", source: "pkmnprices", printing: "UNLIMITED", variant: "Unlimited Holofoil", finish: "HOLO",
        conditionEvidence: "TCGPLAYER", prices: [tcgplayerRawEstimate(175, stamp)] };
    e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets: { minProfit: 0, minRoi: 0 } });
    assert.equal(e.underwriting.verdict, "CANT_PRICE");
    assert.equal(dealHuntCandidate(e, "resell", now)!.outcome(checked)?.verifiedPurchase, undefined);
    assert.deepEqual(rankHuntMarkets([e], null, "resell", "any_card", now), []);
    const comparison = flipResaleEvidence(e, "resell", { minProfit: 0, minRoi: 0 });
    assert.equal(listingMarketPrices(comparison, { ...e.listing, images: e.listing.photos ?? [] }, now)?.tcg?.market, 175);
});

test("resale review admits recent exact sales without a daily or monthly volume requirement", () => {
    const e = rawCard();
    e.gradedPricing = null;
    const prior = new Date(now - 62 * 86_400_000).toISOString();
    e.rawPricing = { status: "PRICED", source: "pkmnprices", printing: "UNLIMITED", variant: "Unlimited Holofoil", finish: "HOLO",
        conditionEvidence: "AI_PHOTOS", prices: [matchedRawPrice(175, prior)] };
    const targets = { minProfit: 0, minRoi: 0 };
    e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets });
    const liquidity = { preferRecentSales: true };
    const soldAt = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const [market] = rankHuntMarkets([e], null, "resell", "any_card", now);
    const unmatched = { ...market, printing: "FIRST_EDITION" as const, sales60: 10, activityDates: Array(10).fill(soldAt(5)) };
    const old = salesSummary("RAW", "LIGHTLY_PLAYED", [160]);
    Object.assign(old.sales[0], { saleType: "fixed_price", soldAt: soldAt(62), url: "https://www.ebay.com/itm/123111111111", sellerCondition: "LIGHTLY_PLAYED" });
    e.rawPricing.sellerConditionComps = old;
    const prevented = dealHuntCandidate(e, "resell", now, unmatched, targets, undefined, liquidity)!.outcome(checked)!;
    assert.equal(prevented.decision, "WAIT");
    assert.equal(prevented.recentSales, 0);
    assert.equal(prevented.verifiedPurchase, undefined);
    assert.match(prevented.reason, /liquidity is unverified/i);
    for (const [ages, decision] of [[[1], "BUY"], [[1, 2], "BUY"], [[1, 1, 1], "BUY"],
        [[2, 2, 31], "BUY"], [[2, 2, 30], "BUY"]] as const) {
        const row = matchedRawPrice(175, soldAt(ages[0]), ages.length);
        row.comps.sales.forEach((sale, i) => { sale.soldAt = soldAt(ages[i]); });
        e.rawPricing.prices = [row];
        e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets });
        const outcome = dealHuntCandidate(e, "resell", now, unmatched, targets, undefined, liquidity)!.outcome(checked)!;
        assert.equal(outcome.decision, decision, outcome.reason);
        assert.equal(outcome.recentSales, ages.length);
        assert.equal(outcome.verifiedPurchase?.path.path, decision === "BUY" ? "RAW" : undefined);
    }
    const steady = matchedRawPrice(80, stamp, 15);
    steady.comps.sales.forEach((sale, i) => { sale.soldAt = soldAt(i * 2 + 1); });
    const replay = structuredClone(e);
    replay.rawPricing!.prices = [steady];
    replay.listing.price = 25;
    replay.underwriting = underwrite(replay, { ...MONEY_CONFIG, targets });
    const decision = dealHuntCandidate(replay, "resell", now, unmatched, targets, undefined, liquidity)!.outcome(checked)!;
    assert.equal(decision.recentSales, 15);
    assert.equal(decision.decision, "BUY", decision.reason);
    assert.ok(decision.liquidityValidThrough);
    assert.doesNotMatch(decision.reason, /per day|daily demand/);
    const sales = e.rawPricing.prices![0].comps!.sales;
    e.listing.id = "123111111950";
    const withCompetition = (lowestOtherDelivered: number) => dealHuntCandidate(e, "resell", now, unmatched, targets, undefined,
        { ...liquidity, competingCopies: () => ({ count: 1, cheapest: { listingId: "123111111951", checkedAt: stamp, destination: null, validUntil: now + 1000, delivered: lowestOtherDelivered } }) })!.outcome(checked)!;
    const undercut = withCompetition(55);
    assert.equal(undercut.decision, "WAIT", undercut.reason);
    const competitive = withCompetition(135);
    assert.equal(competitive.decision, "BUY", competitive.reason);
    assert.equal(competitive.verifiedPurchase?.relist?.price, 175, "one ask cannot reprice three identical sales");
    sales[2].url = sales[0].url;
    // Conflicting dates for one receipt are quarantined. The remaining sale still counts.
    assert.equal(dealHuntCandidate(e, "resell", now, unmatched, targets, undefined, liquidity)!.outcome(checked)!.recentSales, 1);
    sales[2].url = "https://www.ebay.com/itm/123111111199";
    sales[2].conditionEvidence = [];
    const partiallyMatched = dealHuntCandidate(e, "resell", now, unmatched, targets, undefined, liquidity)!.outcome(checked)!;
    assert.equal(partiallyMatched.decision, "BUY");
    assert.equal(partiallyMatched.verifiedPurchase?.relist?.price, 175);
    sales.forEach(sale => { sale.conditionEvidence = []; });
    assert.equal(dealHuntCandidate(e, "resell", now, unmatched, targets, undefined, liquidity)!.outcome(checked)!.decision, "WAIT");
});

test("competitive resale keeps current value and buyer ceiling separate from one active ask", () => {
    const value = rawCard();
    const targets = { minProfit: 0, minRoi: 0 };
    Object.assign(value.listing, { id: "123111111950", price: 25, shipping: 0 });
    value.gradedPricing = null;
    const amounts = [76, 80, 85, 92, 999];
    const row = matchedRawPrice(85, stamp, amounts.length);
    row.comps.sales.forEach((sale, i) => Object.assign(sale, { price: amounts[i], soldAt: new Date(now - i * 86_400_000).toISOString() }));
    Object.assign(row.comps, { low: 76, high: 999 });
    value.rawPricing = { status: "PRICED", source: "pkmnprices", printing: "UNLIMITED", variant: "holo", finish: "HOLO",
        conditionEvidence: "AI_PHOTOS", prices: [row] };
    value.underwriting = underwrite(value, { ...MONEY_CONFIG, targets });
    const quote = { listingId: "123111111951", delivered: 120, checkedAt: stamp, validUntil: now + 100000, destination: null as string | null };
    const decision = (ask: typeof quote | null) => dealHuntCandidate(value, "resell", now, undefined, targets, 40, {
        preferRecentSales: true, competingCopies: () => ({ count: ask ? 1 : 0, cheapest: ask }) })!.outcome(checked)!;
    const first = decision(null);
    assert.equal(first.decision, "BUY", first.reason);
    const baseline = first.verifiedPurchase!;
    assert.equal(baseline.path.salePrice, 85);
    assert.equal(baseline.relist?.price, 82.5);
    assert.equal(relistEstimate(value, baseline.path, quote, now, "mean")?.price, 83.25);
    const legacy = relistEstimate(value, baseline.path, quote, now, "median", "matched-sales-v1")!;
    assert.equal(legacy.price, 88.5);
    assert.ok(applyVerifiedPurchase(value, { ...baseline, relist: legacy }, targets, now));
    for (const [delivered, expected] of [[120, 82.50], [60, 82.50], [84, 82.50]]) {
        const purchase = decision({ ...quote, delivered }).verifiedPurchase!;
        assert.equal(purchase.relist?.price, expected);
        assert.equal(purchase.path.salePrice, 85);
        assert.equal(purchase.maxItemPrice, baseline.maxItemPrice);
        assert.ok(acquisitionCost(purchase.maxItemPrice, 0, MONEY_CONFIG.buying) <= 40);
        assert.ok(applyVerifiedPurchase(value, purchase, targets, now));
        assert.equal(applyVerifiedPurchase(value, purchase, targets, quote.validUntil), null);
        assert.equal(applyVerifiedPurchase(value, { ...purchase, relist: { ...purchase.relist!, price: 999 } }, targets, now), null);
    }
    assert.equal(decision({ ...quote, delivered: 22 }).decision, "WAIT");
    assert.equal(decision({ ...quote, destination: "10001" }).verifiedPurchase?.relist, undefined);
});

test("competing supply counts other active copies of the exact exit and expires old observations", () => {
    const e = rawCard();
    e.identity!.hasEditions = false;
    e.identity!.recordId = "123";
    e.listing.id = "123111111950";
    Object.assign(e.photoCheck!, { cardIdentity: { name: e.identity!.name, set: e.identity!.set, cardNumber: e.identity!.cardNumber,
        language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Readable front."] } });
    e.rawPricing = { status: "PRICED", source: "pkmnprices", printing: "UNLIMITED", variant: "holo", finish: "HOLO",
        conditionEvidence: "AI_PHOTOS", prices: [matchedRawPrice(175, stamp)] };
    const path = underwrite(e, MONEY_CONFIG).paths.find(p => p.path === "RAW");
    assert.ok(path?.status === "PRICED");
    const copies = new FlipEvaluations();
    copies.set(e.listing.id, e);
    const rival = structuredClone(e);
    rival.listing.id = "123111111951";
    copies.set(rival.listing.id, rival);
    copies.set(rival.listing.id, rival);
    assert.equal(copies.competingCopies(e, path, now).count, 1);
    assert.equal(copies.competingCopies(e, path, now).cheapest?.listingId, rival.listing.id);
    const alias = structuredClone(e);
    alias.listing.id = "v1|123111111950|12345";
    copies.set(alias.listing.id, alias);
    assert.equal(copies.competingCopies(e, path, now).count, 1);
    rival.listing.shippingDestination = "10001";
    copies.set(rival.listing.id, rival);
    assert.equal(copies.competingCopies(e, path, now).cheapest, null);
    rival.listing.shippingDestination = e.listing.shippingDestination;
    copies.set(rival.listing.id, rival);
    assert.equal(copies.competingCopies(e, path, now + 120001).count, 0);
    rival.condition!.rawCondition = "DAMAGED";
    copies.set(rival.listing.id, rival);
    assert.equal(copies.competingCopies(e, path, now).count, 0);
    rival.condition!.rawCondition = e.condition!.rawCondition;
    rival.condition!.authenticity.concern = "LIKELY_FAKE";
    copies.set(rival.listing.id, rival);
    assert.equal(copies.competingCopies(e, path, now).count, 0);
    rival.condition!.authenticity.concern = "NONE_SEEN";
    rival.listing.availability = "UNAVAILABLE";
    copies.set(rival.listing.id, rival);
    assert.equal(copies.competingCopies(e, path, now).count, 0);
});

test("grade research uses photo and sales observations and distinguishes likely and lower grade after-cost returns", () => {
    const e = rawCard(), candidate = dealHuntCandidate(e, "grade_raw", now)!;
    assert.equal(dealHuntCandidate(e, "collect_slab", now), null);
    assert.ok(!candidate.available(new Set()).includes("calculate_grading"));
    assert.ok(candidate.available(new Set(["inspect_photos", "check_sales"])).includes("calculate_grading"));
    assert.equal(candidate.outcome(new Set(["check_sales", "inspect_photos", "check_listing"])), null);
    assert.match(String(candidate.read("calculate_grading")), /likely grade \(PSA 7\), the projected profit is \$[\d,.]+ after all costs. One grade lower \(PSA 6\), the projected profit/);
    assert.equal(candidate.outcome(checked)?.decision, "BUY");
    assert.equal(candidate.outcome(checked)?.section, "grading");
    assert.deepEqual(candidate.outcome(checked)?.alternateSections, ["sales"]);

    const downside = dealHuntCandidate(rawCard(15), "grade_raw", now)!;
    assert.match(String(downside.read("calculate_grading")), /PSA 6\), the projected loss is \$/);
    assert.equal(downside.outcome(checked)?.decision, "WAIT");
    let clock = now;
    const expired = dealHuntCandidate(e, "grade_raw", () => clock)!;
    assert.equal(expired.outcome(checked)?.decision, "BUY");
    clock += 120_001;
    assert.equal(expired.outcome(checked)?.decision, "WAIT");
    assert.match(expired.outcome(checked)!.reason, /fresh availability/);

    e.gradedPricing!.PSA!.byGrade![0].sales.forEach(sale => { delete sale.saleType; });
    assert.equal(dealHuntCandidate(e, "grade_raw", now)!.outcome(checked)?.decision, "WAIT");
});

test("grading purchases meet the buyer's targets at the likely grade, not just a higher weighted estimate", () => {
    function graded(prices: number[], targets: { minProfit: number; minRoi: number }) {
        const e = rawCard();
        e.gradedPricing = { CGC: { status: "PRICED", printing: "UNLIMITED", variant: "holo",
            byGrade: prices.map((price, i) => {
                const summary = salesSummary("CGC", 6 + i, [price, price, price]);
                summary.sales.forEach((sale, j) => Object.assign(sale, { saleType: "fixed_price",
                    url: `https://www.ebay.com/itm/${123000010000 + i * 10 + j}` }));
                return summary;
            }) } };
        e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets });
        return e;
    }
    for (const targets of [{ minProfit: 100, minRoi: 0 }, { minProfit: 0, minRoi: 1 }]) {
        const e = graded([160, 180, 1000], targets);
        assert.equal(e.underwriting!.verdict, "BUY_AND_GRADE", "the high outcome makes the weighted estimate attractive");
        const outcome = dealHuntCandidate(e, "resell", now, undefined, targets)!.outcome(checked)!;
        assert.equal(outcome.decision, "WAIT");
        assert.equal(outcome.verifiedPurchase, undefined);
        assert.match(outcome.reason, /likely-grade return falls short of your profit or ROI target/);

        e.rawPricing = { status: "PRICED", printing: "UNLIMITED", variant: "Unlimited Holofoil", finish: "HOLO",
            conditionEvidence: "AI_PHOTOS", prices: [matchedRawPrice(300, stamp)] };
        e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets });
        const raw = dealHuntCandidate(e, "resell", now, undefined, targets)!.outcome(checked)!;
        assert.equal(raw.decision, "BUY", "an independently profitable raw exit remains usable");
        assert.equal(raw.verifiedPurchase?.path.path, "RAW");
    }
    const targets = { minProfit: 100, minRoi: 0 };
    const e = graded([250, 275, 1000], targets);
    const result = dealHuntCandidate(e, "resell", now, undefined, targets)!.outcome(checked)!;
    assert.equal(result.decision, "BUY");
    const purchase = result.verifiedPurchase!, path = purchase.path;
    const likely = path.outlook!.find(row => row.grade === e.condition!.gradeRange!.likely)!;
    const costAt = (price: number) => cents(acquisitionCost(price, path.shipping, MONEY_CONFIG.buying)) + cents(path.fixedCosts);
    assert.ok(meetsMoneyTargets(cents(likely.net), costAt(purchase.maxItemPrice), targets.minProfit, targets.minRoi));
    assert.ok(!meetsMoneyTargets(cents(likely.net), costAt(purchase.maxItemPrice + .01), targets.minProfit, targets.minRoi),
        "the receipt's ceiling preserves the likely-grade target to the cent");
});

test("a supported purchase ceiling fits the buyer's delivered budget to the last cent", () => {
    const targets = { minProfit: 0, minRoi: 0 };
    const copy = rawCard();
    Object.assign(copy.listing, { price: 5, shipping: 0 });
    copy.underwriting = underwrite(copy, { ...MONEY_CONFIG, targets });
    const result = dealHuntCandidate(copy, "grade_raw", now, undefined, targets, 6)!.outcome(checked)!;
    assert.equal(result.decision, "BUY");
    assert.equal(result.verifiedPurchase?.maxItemPrice, 5.54);
    assert.equal(result.verifiedPurchase.maxDelivered, 6);
    assert.ok(result.verifiedPurchase.marketMaxItemPrice! > 6);
});

test("an otherwise supported fixed-price purchase can request fresh terms without approving stale terms", () => {
    const targets = { minProfit: 0, minRoi: 0 };
    const create = () => {
        const e = rawCard();
        e.gradedPricing = null;
        e.rawPricing = { status: "PRICED", printing: "UNLIMITED", variant: "Unlimited Holofoil", finish: "HOLO",
            conditionEvidence: "AI_PHOTOS", prices: [matchedRawPrice(175, stamp)] };
        e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets });
        return e;
    };
    const completed = new Set<DealHuntAction>([...checked, "check_raw_resale", "resolve_printing"]);
    let clock = now;
    const e = create(), photos = e.photoCheck;
    const candidate = dealHuntCandidate(e, "resell", () => clock, undefined, targets)!;
    assert.equal(candidate.outcome(completed)?.decision, "BUY");
    assert.equal(candidate.canRepeat?.("check_listing", completed), false);
    clock += 120_000;
    const stale = candidate.outcome(completed)!;
    assert.equal(stale.decision, "WAIT");
    assert.equal(stale.verifiedPurchase, undefined);
    assert.equal(candidate.canRepeat?.("check_listing", completed), true);
    assert.deepEqual(candidate.available(completed), ["check_listing"]);
    assert.equal(candidate.canRepeat?.("inspect_photos", completed), false);

    e.listing.termsCheckedAt = new Date(clock).toISOString();
    assert.equal(candidate.outcome(completed)?.decision, "BUY");
    assert.equal(candidate.canRepeat?.("check_listing", completed), false);
    assert.equal(e.photoCheck, photos, "refreshing terms does not replace physical findings");

    e.listing.price = 170;
    e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets });
    assert.equal(candidate.outcome(completed)?.decision, "WAIT", "a price increase must remove the old approval");
    e.listing.termsCheckedAt = stamp;
    assert.equal(candidate.canRepeat?.("check_listing", completed), false, "a current financial loss does not buy another terms check");

    for (const stop of ["authenticity", "liquidity", "prices", "ended"] as const) {
        const blocked = create();
        if (stop === "authenticity") {
            blocked.condition!.authenticity.concern = "POSSIBLE";
            blocked.underwriting = underwrite(blocked, { ...MONEY_CONFIG, targets });
        }
        if (stop === "liquidity") blocked.rawPricing!.prices = [matchedRawPrice(175, new Date(clock - 65 * 86_400_000).toISOString())];
        if (stop === "prices") blocked.pricesCheckedAt = new Date(clock - 7 * 3_600_000).toISOString();
        if (stop === "ended") blocked.listing.availability = "UNAVAILABLE";
        const hold = dealHuntCandidate(blocked, "resell", () => clock, undefined, targets, undefined,
            { preferRecentSales: stop === "liquidity" })!;
        assert.equal(hold.outcome(completed)?.decision, "WAIT", stop);
        assert.equal(hold.canRepeat?.("check_listing", completed), false, stop);
        assert.ok(!hold.available(completed).includes("check_listing"), stop);
    }
});

test("the resale hunt reads seller-described sales when the sold photos have yet to establish a raw price", () => {
    const e = rawCard();
    e.photoCheck!.cardMatch = { verdict: "MATCH", problems: [] };
    e.gradedPricing = null;
    e.listing.price = 95;
    const sales = salesSummary("RAW", "LIGHTLY_PLAYED", [48, 59, 69]);
    sales.sales.forEach((sale, i) => Object.assign(sale, { saleType: "fixed_price", sellerCondition: "LIGHTLY_PLAYED",
        url: `https://www.ebay.com/itm/${125000000000 + i}` }));
    e.rawPricing = { status: "PRICE_UNAVAILABLE", source: "pkmnprices", variant: "Holofoil", printing: "UNLIMITED",
        finish: "HOLO", conditionEvidence: "AI_PHOTOS", sellerConditionComps: sales };
    e.underwriting = underwrite(e);
    const hunt = dealHuntCandidate(e, "resell", now)!;
    assert.match(String(hunt.read("check_sales")), /\$48\.00.*\$69\.00/);
    assert.match(hunt.outcome(checked)!.reason, /\$48\.00.*\$69\.00/);
    assert.equal(hunt.outcome(checked)!.decision, "WAIT");
});

function slabCard() {
    const e = rawCard();
    e.condition = null; e.rawPricing = null; e.gradedPricing = null;
    e.listing.price = 999;
    Object.assign(e.identity!, { name: "Dark Gengar", set: "Neo Destiny", cardNumber: "6/105", hasEditions: true });
    e.listing.title = "Dark Gengar 6/105 CGC 8.5";
    e.slab = { status: "OK", grader: "CGC", grade: "8.5", gradeQualifier: null, certNumber: null, certUrl: null,
        labelText: e.listing.title, caseCondition: "INTACT", concerns: [], reasons: [] };
    Object.assign(e.photoCheck!, { holder: "GRADED_SLAB", slab: { ...e.slab, present: true, authenticity: "NONE_SEEN" } });
    e.underwriting = { verdict: "CANT_PRICE", best: null, paths: [], reasons: [], assumptions: [] };
    e.trackerPriceReference = { source: "POKEMON_PRICE_TRACKER", tcgPlayerId: 1, printingLabel: "Unlimited Holofoil", caveat: "",
        gradedMarket: { grader: "CGC", grade: "8.5", priceUsd: 925, statistic: "7_DAY_MEDIAN", reportedSales: 8, lastSaleAt: stamp, marketplaces: ["eBay"] } };
    return e;
}

test("a collector can buy within the exact slab market even when resale loses; estimates alone never return a buy", () => {
    const e = slabCard();
    const checked = new Set<DealHuntAction>(["check_listing", "inspect_photos", "check_sales"]);
    const reference = dealHuntCandidate(e, "collect_slab", now)!;
    assert.equal(dealHuntCandidate(e, "grade_raw", now), null);
    assert.ok(!reference.available(checked).includes("calculate_grading"));
    assert.match(String(reference.read("check_sales")), /\$925\.00/);
    assert.equal(reference.outcome(checked)?.decision, "WAIT");
    e.listing.price = 800;
    assert.equal(dealHuntCandidate(e, "collect_slab", now)!.outcome(checked)?.decision, "WAIT");

    const comp = salesSummary("CGC", 8.5, [890, 900, 910]);
    comp.sales.forEach(sale => { sale.saleType = "fixed_price"; });
    e.slabPricing = { status: "PRICED", printing: "UNLIMITED", grader: "CGC", grade: 8.5, summary: comp };
    e.underwriting = underwrite(e);
    const exact = dealHuntCandidate(e, "collect_slab", now)!;
    assert.match(String(exact.read("check_sales")), /3 matched CGC 8.5 sales/);
    assert.equal(exact.outcome(checked)?.decision, "BUY");
    assert.equal(exact.outcome(checked)?.section, "sales");
    assert.equal(dealHuntCandidate(e, "resell", now)!.outcome(checked)?.decision, "WAIT");

    e.slabPricing.printing = "FIRST_EDITION";
    assert.equal(dealHuntCandidate(e, "collect_slab", now)!.outcome(checked)?.decision, "WAIT");
});

test("a loss one grade lower can still leave an independently supported raw resale for the resale goal", () => {
    const e = rawCard(15);
    const sales = salesSummary("RAW", "LIGHTLY_PLAYED", [170, 175, 180]);
    for (const [i, sale] of sales.sales.entries()) {
        sale.saleType = "fixed_price"; sale.photoCondition = "LIGHTLY_PLAYED"; sale.conditionEvidence = ["Wear visible on the edges."];
        sale.url = `https://www.ebay.com/itm/${123000000000 + i}`;
    }
    e.rawPricing = { status: "PRICED", printing: "UNLIMITED", source: "pkmnprices", variant: "holo", conditionEvidence: "AI_PHOTOS",
        prices: [{ basis: "EBAY_SOLD", condition: "LIGHTLY_PLAYED", price: 175, updatedAt: stamp, comps: sales }] };
    e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets: { minProfit: 0, minRoi: 0 } });
    assert.equal(e.underwriting.best?.path, "GRADE");
    assert.equal(dealHuntCandidate(e, "grade_raw", now)!.outcome(checked)?.decision, "WAIT");
    const decision = dealHuntCandidate(e, "resell", now)!.outcome(checked);
    assert.equal(decision?.decision, "BUY");
    assert.equal(decision?.section, "sales");
    assert.equal(decision?.alternateSections, undefined);
    assert.equal(decision?.recentSales, 3);
    const [lead] = rankHuntMarkets([e], null, "resell", "any_card", now);
    // The matching sale histories overlap. A thin copy can reuse the exact
    // market's three distinct sales, but cannot borrow another printing's count.
    sales.sales.splice(1);
    const thin = dealHuntCandidate(e, "resell", now)!.outcome(checked);
    assert.equal(thin?.decision, "BUY");
    assert.equal(thin?.recentSales, 1);
    assert.equal(dealHuntCandidate(e, "resell", now, lead)!.outcome(checked)?.decision, "BUY");
    const wrongPrinting = dealHuntCandidate(e, "resell", now, { ...lead, printing: "FIRST_EDITION" })!.outcome(checked)!;
    assert.equal(wrongPrinting.decision, "BUY");
    assert.equal(wrongPrinting.recentSales, 1, "activity from another printing is never borrowed");
    assert.equal(dealHuntCandidate(e, "resell", now, { ...lead, liquidThrough: now - 1 })!.outcome(checked)?.decision, "BUY", "a legacy volume deadline is not a purchase veto");
});

test("slab resale reports activity at that holder grade without a sales quota", () => {
    const e = slabCard();
    e.listing.price = 100;
    const summary = salesSummary("CGC", 8.5, [890, 900, 910]);
    summary.sales.forEach((sale, i) => Object.assign(sale, { saleType: "auction", url: `https://www.ebay.com/itm/${123450000000 + i}` }));
    e.slabPricing = { status: "PRICED", source: "pkmnprices", variant: "Holofoil", printing: "UNLIMITED", grader: "CGC", grade: 8.5, summary };
    e.underwriting = underwrite(e);
    const [liquid] = rankHuntMarkets([e], null, "resell", "any_card", now);
    assert.equal(dealHuntCandidate(e, "resell", now)!.outcome(checked)?.decision, "BUY");
    summary.sales.splice(1);
    assert.equal(dealHuntCandidate(e, "collect_slab", now)!.outcome(checked)?.decision, "BUY");
    assert.equal(dealHuntCandidate(e, "resell", now, { ...liquid, grade: 9 })!.outcome(checked)?.decision, "BUY");
    assert.equal(dealHuntCandidate(e, "resell", now, { ...liquid, grader: "PSA" })!.outcome(checked)!.recentSales, 1);
    e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets: { minProfit: 3000, minRoi: 0 } });
    assert.match(dealHuntCandidate(e, "resell", now, liquid)!.outcome(checked)!.reason, /falls short of your profit or ROI target/);
});

test("a profitable grading exit remains eligible with sparse activity", () => {
    const e = rawCard();
    const sales = salesSummary("RAW", "LIGHTLY_PLAYED", [170, 175, 180]);
    for (const [i, sale] of sales.sales.entries()) {
        Object.assign(sale, { saleType: "auction", photoCondition: "LIGHTLY_PLAYED", url: `https://www.ebay.com/itm/${321000000000 + i}` });
    }
    e.rawPricing = { status: "PRICED", printing: "UNLIMITED", source: "pkmnprices", variant: "holo",
        prices: [{ basis: "EBAY_SOLD", condition: "LIGHTLY_PLAYED", price: 175, updatedAt: stamp, comps: sales }] };
    e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets: { minProfit: 0, minRoi: 0 } });
    assert.equal(e.underwriting.best?.path, "GRADE");
    const candidate = dealHuntCandidate(e, "resell", now)!;
    assert.equal(candidate.outcome(checked)?.decision, "BUY");
    assert.equal(candidate.outcome(checked)?.section, "grading");
    const likely = e.gradedPricing!.PSA!.byGrade!.find(s => Number(s.grade) === 7)!;
    likely.sales.forEach((sale, i) => sale.url = `https://www.ebay.com/itm/${321111000000 + i}`);
    const graded = candidate.outcome(checked);
    assert.equal(graded?.decision, "BUY");
    assert.equal(graded?.recentSales, 3);
    assert.equal(graded?.section, "grading");
});

test("a raw auction with only graded sales cannot claim a discount against its raw market", () => {
    const e = rawCard();
    Object.assign(e.listing, { buyingOption: "AUCTION", bids: 1, price: 10, shipping: 2, endTime: new Date(now + 3_600_000).toISOString(),
        auctionQuote: {currentBid: 10, minimumBid: 11, checkedAt: stamp} });
    assert.equal(e.rawPricing, null);
    const outcome = dealHuntCandidate(e, "resell", now)!.outcome(checked);
    assert.equal(outcome?.decision, "WAIT");
    assert.match(outcome!.reason, /did not establish a current below-market auction/);
});

test("a sparse auction can use a condition-specific reference for Wait after the verified next bid fits the buyer's cap", () => {
    const e = rawCard();
    Object.assign(e.listing, { buyingOption: "AUCTION", price: 35, bids: 1, auctionQuote: { checkedAt: stamp, currentBid: 35, minimumBid: 36 },
        endTime: new Date(now + 3_600_000).toISOString() });
    e.gradedPricing = null;
    e.underwriting = { verdict: "CANT_PRICE", best: null, reasons: [], paths: [], assumptions: [] };
    const checked = new Set<DealHuntAction>(["check_listing", "check_sales", "inspect_photos"]);
    const hunt = (budget?: number) => dealHuntCandidate(e, "resell", now, undefined, MONEY_CONFIG.targets, budget)!;
    assert.ok(!hunt().available(new Set(["check_sales"])).includes("check_price_references"));
    assert.ok(!hunt(35).available(checked).includes("check_price_references"));
    assert.ok(hunt(50).available(checked).includes("check_price_references"));
    e.trackerRawReference = { source: "TCGPLAYER_MARKET", tcgPlayerId: 1, recordId: String(e.identity!.recordId), printing: "FIRST_EDITION",
        finish: "HOLO", condition: "LIGHTLY_PLAYED", priceUsd: 100, updatedAt: stamp };
    assert.ok(hunt().available(checked).includes("check_price_references"));
    e.trackerRawReference.printing = "UNLIMITED";
    assert.ok(!hunt().available(checked).includes("check_price_references"));
    checked.add("check_price_references");
    const result = hunt().outcome(checked);
    assert.equal(result?.decision, "WAIT");
    assert.match(result!.reason, /\$100\.00 TCGplayer market estimate for Lightly Played/);
    e.listing.endTime = new Date(now + 10 * 3_600_000).toISOString();
    delete e.trackerRawReference;
    assert.ok(!hunt().available(new Set(["check_listing", "check_sales", "inspect_photos"])).includes("check_price_references"));
});

test("a price reference for a different slab printing or web grade cannot suppress a new lookup", () => {
    const e = slabCard();
    const checks = new Set<DealHuntAction>(["check_listing", "check_sales", "inspect_photos"]);
    e.trackerPriceReference!.printingLabel = "1st Edition Holofoil";
    e.webPriceResearch = { checkedAt: stamp, market: { cardName: "Dark Gengar", setName: "Neo Destiny", cardNumber: "6/105",
        printingLabel: e.identity!.printingLabel!, finish: "HOLO", language: e.identity!.language, grader: "PSA", grade: "9" },
        observations: [{ title: "Different slab", kind: "SOLD", priceUsd: 9999, date: stamp.slice(0, 10), url: "https://www.ebay.com/itm/123000000099" }] };
    const candidate = dealHuntCandidate(e, "collect_slab", now)!;
    assert.ok(candidate.available(checks).includes("check_price_references"));
    assert.doesNotMatch(String(candidate.read("check_sales")), /925|9,999/);
});

test("the planner can inspect a raw exit directly on both auctions and Buy It Now and still honor the grade-only goal", () => {
    const e = rawCard(15);
    const comps = salesSummary("RAW", "LIGHTLY_PLAYED", [170, 175, 180]);
    comps.sales.forEach((sale, i) => Object.assign(sale, { saleType: "auction", photoCondition: "LIGHTLY_PLAYED",
        conditionEvidence: ["Edge wear on front and back."], url: `https://www.ebay.com/itm/${321000001000 + i}` }));
    e.rawPricing = { status: "PRICED", printing: "UNLIMITED", finish: "HOLO", source: "pkmnprices", variant: "holo", conditionEvidence: "AI_PHOTOS",
        prices: [{ basis: "EBAY_SOLD", condition: "LIGHTLY_PLAYED", price: 175, updatedAt: stamp, comps }] };
    const targets = { minProfit: 0, minRoi: 0 };
    const choices = new Set<DealHuntAction>(["inspect_photos", "check_raw_resale", "check_listing"]);
    for (const format of ["FIXED_PRICE", "AUCTION"] as const) {
        Object.assign(e.listing, { buyingOption: format, bids: 1, price: 35, shipping: 2, endTime: new Date(now + 3_600_000).toISOString(),
            auctionQuote: { currentBid: 35, minimumBid: 36, checkedAt: stamp } });
        e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets });
        const hunt = dealHuntCandidate(e, "resell", now, undefined, targets)!;
        assert.ok(hunt.available(new Set()).includes("check_raw_resale"));
        assert.match(String(hunt.read("check_raw_resale")), /Lightly Played estimate of \$175.00.*profit.*3 observed matching sales/);
        const result = hunt.outcome(choices);
        assert.equal(result?.decision, format === "AUCTION" ? "BID" : "BUY");
        assert.equal(result?.section, "sales");
        assert.ok(!dealHuntCandidate(e, "grade_raw", now)!.available(new Set()).includes("check_raw_resale"));
    }
    comps.sales.splice(1);
    assert.equal(dealHuntCandidate(e, "resell", now)!.outcome(choices)?.decision, "BID", "one exact sale can support value without a three-sale veto");
});

test("an otherwise profitable bid with some exact resale activity can advance", () => {
    const e = rawCard(15);
    e.gradedPricing = null;
    Object.assign(e.listing, { buyingOption: "AUCTION", bids: 1, price: 35, shipping: 2, endTime: new Date(now + 3_600_000).toISOString(),
        auctionQuote: { currentBid: 35, minimumBid: 36, checkedAt: stamp } });
    const comps = salesSummary("RAW", "LIGHTLY_PLAYED", [170, 175, 180]);
    comps.sales.forEach((sale, i) => Object.assign(sale, { saleType: "auction", photoCondition: "LIGHTLY_PLAYED",
        soldAt: new Date(now - (65 + i) * 86_400_000).toISOString(),
        conditionEvidence: ["Edge wear on front and back."], url: `https://www.ebay.com/itm/${321000002000 + i}` }));
    e.rawPricing = { status: "PRICED", printing: "UNLIMITED", finish: "HOLO", variant: "holo", conditionEvidence: "AI_PHOTOS",
        prices: [{ basis: "EBAY_SOLD", condition: "LIGHTLY_PLAYED", price: 175, updatedAt: stamp, comps }] };
    const targets = { minProfit: 0, minRoi: 0 };
    e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets });
    assert.equal(dealHuntCandidate(e, "resell", now, undefined, targets)!.outcome(checked)?.decision, "BID");
    const liquidity = { preferRecentSales: true };
    const held = dealHuntCandidate(e, "resell", now, undefined, targets, undefined, liquidity)!.outcome(checked)!;
    assert.equal(held.decision, "WAIT");
    assert.equal(held.recentSales, 0);
    assert.match(held.reason, /liquidity is unverified/i);
    assert.doesNotMatch(held.reason, /bid up to/i);
    for (const count of [1, 2]) {
        comps.sales[count - 1].soldAt = new Date(now - (45 + count) * 86_400_000).toISOString();
        const outcome = dealHuntCandidate(e, "resell", now, undefined, targets, undefined, liquidity)!.outcome(checked)!;
        assert.equal(outcome.decision, "BID");
        assert.equal(outcome.recentSales, count);
    }
});
