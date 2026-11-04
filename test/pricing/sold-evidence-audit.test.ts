import { test } from "node:test";
import assert from "node:assert/strict";
import { compProblem, summarizeComps, type CompCriteria } from "../../server/pricing/sold-comps.ts";
import { compsForGrade } from "../../server/pricing/graded-comps.ts";
import type { Comp, PricedCard } from "../../server/pricing/types.ts";
import type { Identity } from "../../shared/types.ts";

const now = Date.parse("2026-11-03T12:00:00Z");
const criteria: CompCriteria = { printing: "UNLIMITED", setName: "Base Set", finish: "HOLO", grader: "PSA", grade: "7", now };
const sale = (price: number, overrides: Partial<Comp> = {}): Comp => ({
    price, sold_at: "2026-11-02T12:00:00Z", title: "Venusaur Base Set 15/102 Unlimited Holo PSA 7",
    variant: "Unlimited Holofoil", grader: "PSA", grade: "7", grade_qualifier: null,
    attribution: "exact", currency: "USD", sale_type: "fixed_price", listing_url: null,
    ...overrides,
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
        variants: [{ name: "Unlimited Holofoil", printing: "UNLIMITED", finish: "HOLO", prices: [], recordId: 1, setName: "Base Set" }] };
    const pricing = await compsForGrade(card, identity, { grader: "PSA", grade: "7", now,
        fetchComps: async () => [sale(10000, { sale_type: null }), sale(20000, { sale_type: undefined })] });
    assert.equal(pricing.status, "PRICE_UNAVAILABLE");
    assert.equal(pricing.summary?.count, 0);
    assert.equal(pricing.summary?.median, null);
    assert.equal(pricing.summary?.dropped["sale amount not confirmed"], 2);
});
