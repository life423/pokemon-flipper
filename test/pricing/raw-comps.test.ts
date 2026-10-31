import { test } from "node:test";
import assert from "node:assert/strict";
import { compCondition, rawPricesWithSales } from "../../server/pricing/raw-comps.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import type { Comp, PricedCard } from "../../server/pricing/types.ts";

const now = Date.parse("2026-10-30T18:00:00Z");
const identity = cardEvaluation().identity!;
const card: PricedCard = { source: "pkmnprices", name: "Venusaur", cardNumber: "15/102", records: [], variants: [
    { name: "Unlimited Holofoil", printing: "UNLIMITED", finish: "HOLO", recordId: 1, setName: "Base Set", prices: [{ condition: "LIGHTLY_PLAYED", price: 30, updatedAt: null }] },
] };
const sale = (id: number, price = 100, extra: Partial<Comp> = {}): Comp => ({ id, price, sold_at: "2026-10-29", title: "Venusaur Base Set 15/102 Unlimited Holo LP", grader: null, grade: null, grade_qualifier: null, currency: "USD", variant: "Unlimited Holofoil", attribution: "exact", listing_url: `https://www.ebay.com/itm/${id}`, sale_type: "fixed_price", ...extra });

test("raw condition is explicit; absent, ambiguous, and hit-point labels are not mint or played", () => {
    for (const title of ["Venusaur holo", "Venusaur NM/LP", "Venusaur 100 HP", "Venusaur mint?", "Venusaur LP-NM"]) assert.equal(compCondition(title), null, title);
    assert.equal(compCondition("Venusaur Lightly Played"), "LIGHTLY_PLAYED");
    assert.equal(compCondition("Venusaur NM"), "NEAR_MINT");
    assert.equal(compCondition("Venusaur HP"), "HEAVILY_PLAYED");
    assert.equal(compCondition("Venusaur 100 HP LP"), "LIGHTLY_PLAYED");
    assert.equal(compCondition("Venusaur Heavily Played 100 HP"), "HEAVILY_PLAYED");
});

test("recent condition-matched eBay sold median replaces market price and changes real underwriting", async () => {
    const raw = await rawPricesWithSales(card, identity, { now, fetchRawComps: async () => [sale(1, 90), sale(2, 100), sale(3, 110), sale(3, 110)] });
    assert.equal(raw.prices![0].price, 100);
    assert.equal(raw.prices![0].basis, "EBAY_SOLD");
    assert.equal(raw.prices![0].comps?.count, 3, "duplicate sale is counted once");
    const evaluation = cardEvaluation({ minProfit: 0, minRoi: 0 });
    evaluation.listing.buyingOption = "FIXED_PRICE";
    evaluation.listing.shipping = 0;
    evaluation.gradedPricing = null;
    const config = { ...MONEY_CONFIG, targets: { minProfit: 0, minRoi: 0 } };
    assert.equal(underwrite({ ...evaluation, rawPricing: { status: "PRICED", prices: card.variants[0].prices } }, config).verdict, "PASS");
    assert.equal(underwrite({ ...evaluation, rawPricing: raw }, config).verdict, "BUY_RAW");
});

test("foreign currency, another printing, slabs, lots, unknown condition/amount and old sales cannot inflate raw value", async () => {
    const invalid = [sale(3, 900, { currency: "EUR" }), sale(4, 900, { attribution: "shared" }), sale(5, 900, { grader: "PSA", grade: "9" }), sale(6, 900, { title: "Venusaur LP lot 3 cards" }), sale(7, 900, { title: "Venusaur Holo" }), sale(8, 900, { variant: "1st Edition Holofoil" }), sale(9, 900, { sold_at: "2026-01-01" }), sale(10, 900, { sale_type: null }), sale(11, 900, { sold_at: "2027-01-01" })];
    const raw = await rawPricesWithSales(card, identity, { now, fetchRawComps: async () => [sale(1), sale(2), ...invalid, sale(12, 900, { variant: "Unlimited Reverse Holofoil" })] });
    assert.equal(raw.prices![0].price, 30, "two matches retain the marked market fallback");
    assert.equal(raw.prices![0].basis, "TCGPLAYER");
    assert.equal(raw.ebayComps?.find(s => s.grade === "LIGHTLY_PLAYED")?.count, 2);
});

test("missing AI verdicts and failed sold-data requests preserve working market pricing", async () => {
    const raw = await rawPricesWithSales(card, identity, { now, fetchRawComps: async () => [sale(1), sale(2), sale(3)], checkComps: async () => new Map() });
    assert.equal(raw.prices![0].price, 30);
    assert.equal(raw.ebayComps?.find(s => s.grade === "LIGHTLY_PLAYED")?.count, 0);
    const failed = await rawPricesWithSales(card, identity, { fetchRawComps: async () => { throw new Error("temporary"); } });
    assert.equal(failed.prices![0].price, 30);
    assert.match(failed.evidenceNote!, /temporarily unavailable/);
});

test("a falling resale market lowers the estimate too; values are never selected just to make a deal", async () => {
    const raw = await rawPricesWithSales(card, identity, { now, fetchRawComps: async () => [sale(1, 9), sale(2, 10), sale(3, 11)] });
    assert.equal(raw.prices![0].price, 10);
});

test("photo-assessed conditions override seller claims and missing photos cannot enter a sold-price average", async () => {
    let photoCalls = 0;
    const raw = await rawPricesWithSales(card, identity, { now,
        fetchRawComps: async () => [sale(1, 19, { title: "Venusaur Base Set 15/102 Unlimited Holo NM" }), sale(2, 20), sale(3, 21), sale(4, 999)],
        assessCondition: async sale => { photoCalls++; return sale.id === 4 ? null : { condition: "DAMAGED", evidence: ["Visible crease"], photoCount: 4 }; },
        checkComps: async (sales, target) => { assert.equal(target.conditionEvidence, "AI_PHOTOS"); return new Map(sales.map(sale => [sale, { keep: true, reason: null, note: "Photo condition supplied independently" }])); },
    });
    const damaged = raw.prices!.find(price => price.condition === "DAMAGED")!;
    assert.equal(damaged.price, 20); assert.equal(damaged.basis, "EBAY_SOLD"); assert.equal(damaged.comps!.mean, 20);
    assert.equal(damaged.comps!.sales[0].sellerCondition, "NEAR_MINT"); assert.equal(damaged.comps!.sales[0].photoCondition, "DAMAGED");
    assert.equal(raw.reviewedSoldCopies, 3); assert.equal(photoCalls, 4);
});

test("historical photo work is bounded and absent Mint evidence never invents a premium", async () => {
    let calls = 0;
    const raw = await rawPricesWithSales(card, identity, { now,
        fetchRawComps: async () => Array.from({ length: 17 }, (_, index) => sale(index + 1)),
        assessCondition: async () => { calls++; return null; },
    });
    assert.equal(calls, 12);
    assert.equal(raw.reviewedSoldCopies, 0);
    assert.equal(raw.prices?.find(price => price.condition === "MINT"), undefined);
    assert.equal(raw.prices?.find(price => price.condition === "LIGHTLY_PLAYED")?.price, 30);
});
