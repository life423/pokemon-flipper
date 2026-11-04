import { test } from "node:test";
import assert from "node:assert/strict";
import { compCondition, rawPricesWithSales } from "../../server/pricing/raw-comps.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import type { Comp, PricedCard } from "../../server/pricing/types.ts";
import type { Identity } from "../../shared/types.ts";
import { rawPricesFor } from "../../server/pricing/raw-prices.ts";
import { acceptedSoldCondition, type SoldConditionReading } from "../../server/ai/sold-condition.ts";

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
    assert.equal(raw.prices![0].price, 30, "two seller-title-only matches retain the marked market fallback");
    assert.equal(raw.prices![0].basis, "TCGPLAYER");
    assert.equal(raw.ebayComps?.find(s => s.grade === "LIGHTLY_PLAYED")?.count, 2);
});

test("a lone seller-title condition cannot acquire the photo-evidenced one-sale pricing policy", async () => {
    const raw = await rawPricesWithSales(card, identity, { now, fetchRawComps: async () => [sale(1, 100)] });
    assert.equal(raw.conditionEvidence, "SELLER_TEXT");
    assert.equal(raw.ebayComps?.find(summary => summary.grade === "LIGHTLY_PLAYED")?.count, 1);
    assert.equal(raw.prices![0].price, 30); assert.equal(raw.prices![0].basis, "TCGPLAYER");
});

test("one or two physically condition-matched sold copies support a LOW-confidence raw resale without promoting contradictory evidence", async () => {
    const reading: SoldConditionReading = {
        card: { name: identity.name, set: identity.set, cardNumber: identity.cardNumber, language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Visible name, collector number and artwork agree"] },
        printing: "UNLIMITED", condition: "LIGHTLY_PLAYED", confidence: "HIGH", oneRawCard: true, frontVisible: true, backVisible: true,
        closeUps: true, structuralDamage: false, evidence: ["Minor corner whitening visible on the back"], limitations: [],
    };
    for (const count of [1, 2]) {
        const inspected: number[] = [];
        const raw = await rawPricesWithSales(card, identity, { now,
            fetchRawComps: async () => [
                ...Array.from({ length: count }, (_, index) => sale(index + 1, 100, { title: "Venusaur Base Set 15/102 Unlimited Holo NM" })),
                sale(10, 999, { sale_type: null }), sale(11, 999, { variant: "1st Edition Holofoil" }),
                sale(12, 999, { variant: "Unlimited Reverse Holofoil" }), sale(13, 999), sale(14, 999),
            ],
            assessCondition: async (sale, target) => {
                inspected.push(sale.id as number);
                const observed = sale.id === 13 ? { ...reading, card: { ...reading.card, name: "Charizard" } }
                    : sale.id === 14 ? { ...reading, backVisible: false } : reading;
                return acceptedSoldCondition(observed, target, 2);
            },
            checkComps: async (sales, target) => {
                assert.equal(target.conditionEvidence, "AI_PHOTOS");
                return new Map(sales.map(sale => [sale, { keep: true, reason: null, note: "Exact identity and physical condition accepted" }]));
            },
        });
        const quote = raw.prices!.find(price => price.condition === "LIGHTLY_PLAYED")!;
        assert.equal(quote.price, 100); assert.equal(quote.basis, "EBAY_SOLD");
        assert.equal(quote.comps!.count, count); assert.equal(quote.comps!.confidence, "LOW");
        assert.equal(raw.conditionEvidence, "AI_PHOTOS"); assert.equal(raw.reviewedSoldCopies, count);
        assert.equal(raw.prices!.some(price => price.condition === "NEAR_MINT"), false, "seller wording cannot supply a better-condition price");
        assert.ok(quote.comps!.sales.every(sale => sale.sellerCondition === "NEAR_MINT" && sale.photoCondition === "LIGHTLY_PLAYED"));
        assert.deepEqual(inspected, [...Array.from({ length: count }, (_, index) => index + 1), 13, 14], "unconfirmed amounts and incompatible printing/finish never reach photo assessment");
        const evaluation = cardEvaluation({ minProfit: 0, minRoi: 0 });
        evaluation.listing.buyingOption = "FIXED_PRICE"; evaluation.listing.shipping = 0; evaluation.gradedPricing = null;
        assert.equal(underwrite({ ...evaluation, rawPricing: raw }, { ...MONEY_CONFIG, targets: { minProfit: 0, minRoi: 0 } }).verdict, "BUY_RAW");
    }
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

test("every eligible returned sold copy is inspected and absent Mint evidence never invents a premium", async () => {
    let calls = 0;
    const raw = await rawPricesWithSales(card, identity, { now,
        fetchRawComps: async () => Array.from({ length: 17 }, (_, index) => sale(index + 1)),
        assessCondition: async () => { calls++; return null; },
    });
    assert.equal(calls, 17);
    assert.equal(raw.reviewedSoldCopies, 0);
    assert.equal(raw.prices?.find(price => price.condition === "MINT"), undefined);
    assert.equal(raw.prices?.find(price => price.condition === "LIGHTLY_PLAYED")?.price, 30);
});

test("unresolved photo targets retain their market fallback without fetching or assessing historical copies", async () => {
    let fetches = 0, assessments = 0;
    const unresolved: Partial<Identity>[] = [{ finish: "NOT_STATED" }, { finish: "UNKNOWN" }, { finish: "CONFLICTING" },
        { status: "NEEDS_REVIEW" }, { printing: "UNKNOWN" }, { name: null }, { set: null }, { cardNumber: null }];
    for (const change of unresolved) {
        const target = { ...identity, ...change };
        const raw = await rawPricesWithSales(card, target, { now,
            fetchRawComps: async () => { fetches++; return [sale(1), sale(2), sale(3)]; },
            assessCondition: async () => { assessments++; return { condition: "LIGHTLY_PLAYED", evidence: ["Visible whitening"], photoCount: 2 }; },
        });
        assert.deepEqual(raw, rawPricesFor(card, target), "keep only the fallback the existing market rules can actually support");
    }
    assert.equal(fetches, 0); assert.equal(assessments, 0);
    const resolved = await rawPricesWithSales(card, identity, { now,
        fetchRawComps: async () => { fetches++; return [sale(1, 90), sale(2, 100), sale(3, 110)]; },
        assessCondition: async () => { assessments++; return { condition: "LIGHTLY_PLAYED", evidence: ["Visible whitening"], photoCount: 2 }; },
    });
    assert.equal(fetches, 1); assert.equal(assessments, 3);
    assert.equal(resolved.prices?.[0].price, 100); assert.equal(resolved.prices?.[0].basis, "EBAY_SOLD");
});

test("raw evidence acquisition receives eligible source copies once after cache reads and reuses their transaction fields", async () => {
    const cached: number[] = [];
    let acquisitions = 0;
    const candidates = [sale(1, 90), sale(2, 100), sale(3, 999, { currency: "EUR" }), sale(4, 999, { sale_type: null }),
        sale(5, 999, { variant: "1st Edition Holofoil" }), sale(6, 999, { variant: "Unlimited Reverse Holofoil" })];
    const raw = await rawPricesWithSales(card, identity, { now, requestedCondition: "LIGHTLY_PLAYED",
        fetchRawComps: async () => candidates,
        assessCondition: async source => { cached.push(source.id as number); return null; },
        acquireCondition: async (offered, target) => {
            acquisitions++;
            assert.deepEqual(cached, [1, 2], "cache reads finish before any new photo acquisition");
            assert.deepEqual(offered, candidates.slice(0, 2)); assert.equal(target, identity);
            return { sale: offered[0], evidence: { condition: "LIGHTLY_PLAYED", evidence: ["Back corner whitening"], photoCount: 2 } };
        },
    });
    assert.equal(acquisitions, 1); assert.equal(raw.reviewedSoldCopies, 1);
    const quote = raw.prices!.find(price => price.condition === "LIGHTLY_PLAYED")!;
    assert.equal(quote.basis, "EBAY_SOLD"); assert.equal(quote.price, 90);
    assert.equal(quote.comps!.count, 1); assert.equal(quote.comps!.confidence, "LOW");
});

test("cached matches, missing target conditions and cache failures prevent new raw evidence acquisition", async () => {
    let acquisitions = 0;
    for (const mode of ["cached", "no-condition", "no-cache-reader", "cache-failure"] as const) {
        const raw = await rawPricesWithSales(card, identity, { now,
            requestedCondition: mode === "no-condition" ? undefined : "LIGHTLY_PLAYED",
            fetchRawComps: async () => [sale(1, 100)],
            assessCondition: mode === "no-cache-reader" ? undefined : async () => {
                if (mode === "cache-failure") throw new Error("saved evidence unavailable");
                return mode === "cached" ? { condition: "LIGHTLY_PLAYED", evidence: ["Visible corner whitening"], photoCount: 2 } : null;
            },
            acquireCondition: async () => { acquisitions++; return null; },
        });
        assert.equal(raw.prices![0].basis, mode === "cached" ? "EBAY_SOLD" : "TCGPLAYER", mode);
    }
    assert.equal(acquisitions, 0);
});

test("null or foreign acquired copies cannot inject raw sales or trigger a second acquisition", async () => {
    for (const foreign of [false, true]) {
        let acquisitions = 0;
        const raw = await rawPricesWithSales(card, identity, { now, requestedCondition: "LIGHTLY_PLAYED",
            fetchRawComps: async () => [sale(1), sale(2, 999, { currency: "EUR" })],
            assessCondition: async () => null,
            acquireCondition: async offered => {
                acquisitions++; assert.equal(offered.length, 1);
                return foreign ? { sale: sale(2, 999, { currency: "EUR" }), evidence: { condition: "LIGHTLY_PLAYED", evidence: ["Claimed wear"], photoCount: 2 } } : null;
            },
        });
        assert.equal(acquisitions, 1); assert.equal(raw.reviewedSoldCopies, 0);
        assert.equal(raw.prices![0].basis, "TCGPLAYER");
    }
});
