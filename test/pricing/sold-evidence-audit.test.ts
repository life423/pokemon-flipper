import { test } from "node:test";
import assert from "node:assert/strict";
import { compProblem, summarizeComps, uniqueSoldComps, type CompCriteria } from "../../server/pricing/sold-comps.ts";
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
