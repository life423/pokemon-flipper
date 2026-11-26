import { test } from "node:test";
import assert from "node:assert/strict";
import { compProblem, summarizeComps, uniqueSoldComps, type CompCriteria } from "../../server/pricing/sold-comps.ts";
import { compsForGrade } from "../../server/pricing/graded-comps.ts";
import type { Comp, PricedCard } from "../../server/pricing/types.ts";
import type { Identity } from "../../shared/types.ts";
import { soldMarketPrice } from "../../shared/sold-evidence.ts";
import { gradedResalePath } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { usualPrice } from "../../shared/money/auction.ts";
import { observedSalesActivity } from "../../shared/sales-activity.ts";

const now = Date.parse("2026-11-03T12:00:00Z");
const criteria: CompCriteria = { printing: "UNLIMITED", setName: "Base Set", finish: "HOLO", grader: "PSA", grade: "7", now };
const sale = (price: number, overrides: Partial<Comp> = {}): Comp => ({
    price, sold_at: "2026-11-02T12:00:00Z", title: "Venusaur Base Set 15/102 Unlimited Holo PSA 7",
    variant: "Unlimited Holofoil", grader: "PSA", grade: "7", grade_qualifier: null,
    attribution: "exact", currency: "USD", sale_type: "fixed_price", listing_url: null,
    ...overrides,
});

test("one high transaction cannot inflate the ordinary sold price", () => {
    for (const prices of [[20, 21, 22, 1000], [20, 1000]]) {
        const summary = summarizeComps(prices.map((price, index) => sale(price, { id: index + 1,
            listing_url: `https://www.ebay.com/itm/${123456000000 + index}` })), criteria);
        assert.equal(summary.high, prices.length === 2 ? 20 : 22);
        assert.equal(soldMarketPrice(summary), prices.length === 2 ? 20 : 21);
        assert.equal(summary.dropped["price far from the other sales"], 1);
        assert.equal(observedSalesActivity(summary.activitySales ?? summary.sales, now).sales60, prices.length,
            "an eligible unusual transaction stays in activity while its amount cannot inflate value");
    }
    const recent = summarizeComps([20, 21, 22, 50].map((price, index) => sale(price, { id: index + 1, sale_type: "auction" })), criteria);
    assert.equal(soldMarketPrice(recent), 21, "the ordinary-sale average excludes the isolated high price");
    const one = summarizeComps([sale(21)], criteria);
    assert.equal(soldMarketPrice(one), 21, "a sparse exact quote remains available with its actual low confidence");
    assert.equal(one.confidence, "LOW");
});

test("recent distinct transactions set the average when there are only auctions", () => {
    const at = (price: number, hours: number) => sale(price, { id: `sale-${hours}`, sale_type: "auction",
        sold_at: new Date(now - hours * 3_600_000).toISOString() });
    const latest = at(120, 1);
    const sales = [at(50, 50), at(90, 48), at(100, 24), latest, at(80, 20 * 24), at(110, 4),
        at(80, 2 * 24 + 1), { ...latest }, at(1500, 3)];
    const summary = summarizeComps(sales, criteria);
    assert.deepEqual(summary.marketEstimate, { price: 90, method: "SOLD_AVERAGE", sampleSize: 7, windowDays: 30 });
    assert.equal(summary.low, 50);
    assert.equal(summary.high, 120);
    assert.equal(summary.dropped["price far from the other sales"], 1);
    const path = gradedResalePath({ price: 60, shipping: 0 }, summary, 0, MONEY_CONFIG);
    assert.equal(path.status, "PRICED");
    if (path.status === "PRICED") assert.equal(path.salePrice, 90);
    const tooOld = summarizeComps(sales.filter(comp => comp.sold_at !== at(90, 48).sold_at), criteria);
    assert.equal(tooOld.marketEstimate?.method, "SOLD_AVERAGE");
});

test("recent Buy It Now comps anchor resale while auctions remain a separate bid reference", () => {
    const at = (price: number, days: number, saleType: Comp["sale_type"] = "fixed_price") =>
        sale(price, { id: `sale-${days}`, sale_type: saleType, sold_at: new Date(now - days * 86_400_000).toISOString() });
    const latest = [at(300, 1), at(500, 3), at(500, 4), at(500, 5), at(500, 6)];
    const summary = summarizeComps([
        at(370, 30), ...latest, { ...latest[0] }, at(300, 0, "auction"), at(330, 2, "auction"),
        at(340, 0.5, "best_offer_accepted"), at(950, 0.25, null),
    ], criteria);
    assert.deepEqual(summary.marketEstimate, { price: 430, method: "FIXED_PRICE_AVERAGE", sampleSize: 7, windowDays: 30 });
    assert.equal(summary.low, 300);
    assert.equal(summary.sales.filter((comp) => comp.saleType === "auction").length, 2);
    assert.equal(summary.sales.filter((comp) => comp.saleType === "best_offer_accepted").length, 1);
    assert.equal(summary.dropped["sale amount not confirmed"], 1);
    assert.deepEqual(usualPrice([], summary), { price: 315, sales: [300, 330] });
    const path = gradedResalePath({ price: 300, shipping: 0 }, summary, 0, MONEY_CONFIG);
    assert.equal(path.status, "PRICED");
    if (path.status === "PRICED") assert.equal(path.salePrice, 430);

    const sparse = summarizeComps([at(500, 3), at(500, 4), at(500, 31), at(300, 0, "auction")], criteria);
    assert.equal(sparse.marketEstimate?.method, "FIXED_PRICE_AVERAGE");
});

test("sparse exact markets weight newer sales in either direction and preserve legacy medians", () => {
    const age = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const older = [sale(100, { sold_at: age(40) }), sale(110, { sold_at: age(60) })];
    for (const price of [70, 150]) {
        const summary = summarizeComps([...older, sale(price, { sold_at: age(3) })], criteria);
        assert.equal(soldMarketPrice(summary), price);
        assert.notEqual(summary.median, price);
        assert.equal(summary.marketEstimate?.method, "FIXED_PRICE_AVERAGE");
        const { marketEstimate: _estimate, ...legacy } = summary;
        assert.equal(soldMarketPrice(legacy), summary.median);
    }
    assert.equal(soldMarketPrice(summarizeComps([sale(100), sale(110)], criteria)), 105);
});

test("sold corrections follow provider revision and confirmation evidence rather than the highest amount", () => {
    const known = sale(400, { id: "same-sale", updated_at: "2026-11-01T12:00:00Z" });
    const corrected = sale(175, { id: "same-sale", updated_at: "2026-11-02T12:00:00Z", sale_type: "best_offer_accepted" });
    const retracted = sale(9999, { id: "same-sale", updated_at: "2026-11-03T12:00:00Z", sale_type: null });
    const undated = { ...corrected, updated_at: undefined };
    const unknown = { ...retracted, updated_at: undefined };
    for (const [first, second, expected] of [
        [known, corrected, corrected], [corrected, retracted, retracted], [undated, unknown, undated],
        [undated, { ...unknown, updated_at: "invalid-date" }, undated],
    ] as const) {
        assert.deepEqual(uniqueSoldComps([first, second]), [expected]);
        assert.deepEqual(uniqueSoldComps([second, first]), [expected], "a dated correction or confirmed amount survives reversed source order");
    }
    assert.deepEqual(uniqueSoldComps([sale(400, { id: "tie" }), sale(175, { id: "tie" })]).map(row => row.price), [175]);
    assert.deepEqual(uniqueSoldComps([sale(175, { id: "tie" }), sale(400, { id: "tie" })]).map(row => row.price), [400], "equally evidenced observations follow arrival order, not price");
    const url = "https://www.ebay.com/itm/123456789012";
    assert.equal(uniqueSoldComps([sale(400, { listing_url: url }), sale(175, { listing_url: url })])[0].price, 175);
    const anonymous = sale(100);
    assert.equal(uniqueSoldComps([anonymous, { ...anonymous }]).length, 1);
    assert.equal(uniqueSoldComps([anonymous, { ...anonymous, variant: "1st Edition Holofoil" }]).length, 1, "a provider alias cannot count the same anonymous observation twice");
    assert.equal(uniqueSoldComps([sale(100, { id: "one" }), sale(100, { id: "two" })]).length, 2);
});

test("Shadowless graded pricing retains confirmed cross-label corrections and honors newer retractions", async () => {
    const identity: Identity = { status: "IDENTIFIED", name: "Venusaur", set: "Base Set", cardNumber: "15/102", printing: "SHADOWLESS",
        printingLabel: "Shadowless (no 1st Edition)", finish: "HOLO", language: "English", evidence: null, reasons: [] };
    const card: PricedCard = { source: "pkmnprices", name: "Venusaur", cardNumber: "15/102", records: [], variants:
        ["1st Edition Holofoil", "Unlimited Holofoil"].map((name, index) => ({ name, printing: index ? "SHADOWLESS" : "FIRST_EDITION",
            finish: "HOLO", recordId: 1, setName: "Base Set (Shadowless)" })) };
    const uncertain = sale(9999, { id: "corrected-sale", title: "Venusaur Base Set Shadowless 15/102 Holo PSA 7", sale_type: null });
    const confirmed = { ...uncertain, price: 175, sale_type: "best_offer_accepted" as const };
    for (const rows of [[uncertain, confirmed], [confirmed, uncertain]]) {
        const result = await compsForGrade(card, identity, { grader: "PSA", grade: "7", now,
            fetchComps: async (_id, options) => [{ ...rows[options.variant === "1st Edition Holofoil" ? 0 : 1], variant: options.variant! }] });
        assert.equal(result.status, "PRICED"); assert.equal(result.summary?.count, 1); assert.equal(result.summary?.median, 175);
    }
    const result = await compsForGrade(card, identity, { grader: "PSA", grade: "7", now,
        fetchComps: async (_id, options) => [{ ...(options.variant === "1st Edition Holofoil"
            ? { ...confirmed, updated_at: "2026-11-01T12:00:00Z" }
            : { ...uncertain, updated_at: "2026-11-02T12:00:00Z" }), variant: options.variant! }] });
    assert.equal(result.status, "PRICE_UNAVAILABLE"); assert.equal(result.summary?.count, 0);
});

test("No Symbol Jungle sales cannot inflate an ordinary Jungle market, while ordinary and Base Set sales remain eligible", () => {
    const jungle = { ...criteria, setName: "Jungle" };
    for (const text of ["No Symbol", "NO-SYMBOL", "NoSymbol ERROR"]) {
        const premium = sale(1000, { title: `Jolteon Jungle 4/64 Unlimited Holo PSA 7 ${text}` });
        assert.equal(compProblem(premium, jungle), "unsupported Jungle No Symbol variant");
    }
    const ordinary = sale(100, { title: "Jolteon Jungle 4/64 Unlimited Holo PSA 7" });
    assert.equal(compProblem({ ...ordinary, variant: "Unlimited Holofoil No Symbol" }, jungle), "unsupported Jungle No Symbol variant", "a provider variant label cannot silently collapse into Unlimited");
    const missingEdition = sale(110, { title: "Jolteon Jungle 4/64 Unlimited Holo PSA 7 No First Edition symbol" });
    const premium = sale(1000, { title: "Jolteon Jungle 4/64 Unlimited Holo PSA 7 NO SYMBOL" });
    const summary = summarizeComps([ordinary, missingEdition, premium], jungle);
    assert.equal(summary.count, 2); assert.equal(summary.median, 105);
    assert.equal(summary.dropped["unsupported Jungle No Symbol variant"], 1);
    assert.equal(compProblem(sale(100, { title: "Venusaur Base Set 15/102 Unlimited Holo PSA 7 no symbol" }), criteria), null);
});

test("Base Set Fourth Print sales do not enter an ordinary Base Set price", () => {
    const cgc = { ...criteria, grader: "CGC", grade: "9" };
    const ordinary = sale(245, { grader: "CGC", grade: "9", title: "1999 Mewtwo 10/102 Base Set Unlimited Holo CGC 9" });
    const fourth = { ...ordinary, price: 499.99, title: "1999–2000 Pokemon Mewtwo Base Set 10/102 Holo CGC 9 4th Print" };
    const summary = summarizeComps([ordinary, fourth], cgc);
    assert.equal(summary.count, 1);
    assert.equal(soldMarketPrice(summary), 245);
    assert.equal(summary.dropped["Base Set Fourth Print"], 1);
    for (const title of ["Mewtwo 1999-00", "Mewtwo Fourth Printing", "Mewtwo U.K. Print"]) {
        assert.equal(compProblem({ ...ordinary, title }, cgc), "Base Set Fourth Print");
        assert.equal(compProblem({ ...ordinary, title }, { ...cgc, setName: "Base Set (Shadowless)", printing: "SHADOWLESS" }), "Base Set Fourth Print");
        assert.equal(compProblem({ ...ordinary, title }, { ...cgc, setName: "Team Rocket" }), null);
    }
    assert.equal(compProblem({ ...ordinary, variant: "Unlimited Holofoil Fourth Print" }, cgc), "Base Set Fourth Print");
    assert.equal(compProblem({ ...ordinary, title: `${ordinary.title}, not 4th print` }, cgc), null);
    assert.equal(compProblem({ ...ordinary, title: `${ordinary.title}, UK seller` }, cgc), null);
});

test("advertised print errors do not set ordinary raw or graded sold prices", () => {
    const raw = { ...criteria, grader: "RAW", grade: "MODERATELY_PLAYED" };
    const ordinary = sale(23, { title: "Mewtwo 10/102 Base Set Holo Unlimited MP", grader: raw.grader, grade: raw.grade });
    const premium = { ...ordinary, price: 85, title: "Mewtwo 10/102 Printer Hickey Ink Error Base Set Holo Misprint MP" };
    const summary = summarizeComps([ordinary, premium], raw);
    assert.equal(summary.count, 1);
    assert.equal(summary.median, 23);
    assert.equal(summary.dropped["advertised print error"], 1);

    const slab = sale(500);
    for (const suffix of ["MIS-PRINT", "Printer's Hickey", "Printing Error"]) {
        assert.equal(compProblem({ ...slab, title: `${slab.title} ${suffix}` }, criteria), "advertised print error");
    }
    assert.equal(compProblem({ ...slab, variant: "Unlimited Holofoil Misprint" }, criteria), "advertised print error");
    for (const suffix of ["No misprint", "Not a printer hickey", "Without any printing errors", "Non-misprint"]) {
        assert.equal(compProblem({ ...ordinary, title: `${ordinary.title} ${suffix}` }, raw), null);
    }
    assert.equal(compProblem({ ...ordinary, title: `${ordinary.title} No misprint, printer hickey` }, raw), "advertised print error");
});

test("unconfirmed historical amounts cannot set the sold median or displace actual transactions as outliers", () => {
    const confirmed = [sale(100, { sale_type: "auction" }), sale(110), sale(120, { sale_type: "best_offer_accepted" })];
    const unconfirmed = [sale(9000, { sale_type: null }), sale(10000, { sale_type: undefined }), sale(11000, { sale_type: "unknown" as Comp["sale_type"] })];
    const summary = summarizeComps([...confirmed, ...unconfirmed], criteria);
    assert.equal(summary.count, 3);
    assert.equal(summary.median, 110);
    assert.equal(summary.low, 100);
    assert.equal(summary.high, 120);
    assert.equal(summary.dropped["sale amount not confirmed"], 3);
    assert.equal(summary.dropped["price far from the other sales"], undefined);
    assert.deepEqual(summary.sales.map(row => row.price), [100, 110, 120]);
});

test("every supported confirmed transaction type remains priceable", () => {
    for (const sale_type of ["auction", "fixed_price", "best_offer_accepted"] as const) {
        assert.equal(compProblem(sale(110, { sale_type }), criteria), null);
        assert.equal(summarizeComps([sale(110, { sale_type })], criteria).median, 110);
    }
});

test("nonfinite and nonpositive transaction amounts cannot become sold-price evidence", () => {
    for (const price of [Infinity, -Infinity, NaN, 0, -1]) {
        assert.equal(compProblem(sale(price), criteria), "no sale price");
        const summary = summarizeComps([sale(price)], criteria);
        assert.equal(summary.count, 0);
        assert.equal(summary.median, null);
        assert.equal(summary.low, null);
        assert.equal(summary.high, null);
    }
});

test("an exact graded lookup stays unavailable when its only historical amounts are unconfirmed", async () => {
    const identity: Identity = { status: "IDENTIFIED", name: "Venusaur", set: "Base Set", cardNumber: "15/102", printing: "UNLIMITED",
        printingLabel: "Unlimited", finish: "HOLO", language: "English", evidence: null, reasons: [] };
    const card: PricedCard = { source: "pkmnprices", name: "Venusaur", cardNumber: "15/102", records: [],
        variants: [{ name: "Unlimited Holofoil", printing: "UNLIMITED", finish: "HOLO", recordId: 1, setName: "Base Set" }] };
    const pricing = await compsForGrade(card, identity, { grader: "PSA", grade: "7", now,
        fetchComps: async () => [sale(10000, { sale_type: null }), sale(20000, { sale_type: undefined })] });
    assert.equal(pricing.status, "PRICE_UNAVAILABLE");
    assert.equal(pricing.summary?.count, 0);
    assert.equal(pricing.summary?.median, null);
    assert.equal(pricing.summary?.dropped["sale amount not confirmed"], 2);
});
