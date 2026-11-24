import assert from "node:assert/strict";
import { test } from "node:test";
import { rankHuntMarkets, restoreSavedHuntSales, type HuntMarket } from "../../server/analysis/same-set-markets.ts";
import { marketItemLimit, photoMatchesCollectorMarket } from "../../server/analysis/deal-hunt-market-checks.ts";
import { groupMarketSearches } from "../../server/analysis/deal-hunt-market-groups.ts";
import { confirmedHuntPage, savedHuntSaleRows } from "../../server/pricing/saved-hunt-sales.ts";
import type { Comp } from "../../server/pricing/types.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import type { CompSale } from "../../shared/types.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";

const now = Date.parse("2026-11-24T12:00:00Z");
const day = 86_400_000;
const origin = { name: "Mewtwo", cardNumber: "10/102", set: "Base Set" };

test("a number-discovered copy needs matching evidence from its own front for the exact market", () => {
    const market: HuntMarket = {
        name: "Leafeon V (Alternate Full Art)", set: "SWSH07: Evolving Skies", cardNumber: "167/203",
        printing: "UNLIMITED", finish: "HOLO", kind: "raw", grader: "PSA", grade: 9, condition: null,
        sales30: 3, sales90: 3, latestSaleAt: new Date(now).toISOString(), medianUsd: 150, listingIds: [], projectedProfit: null,
    };
    const e = cardEvaluation();
    Object.assign(e.identity!, { name: market.name, set: market.set, cardNumber: market.cardNumber, hasEditions: false });
    e.listing.title = "Old shiny Pokémon card 167/203";
    const check = e.photoCheck!;
    check.cardCount = "ONE";
    check.printedName = "Leafeon V";
    check.printedNumber = "167/203";
    check.cardIdentity = { name: "Leafeon V", set: "Evolving Skies", cardNumber: "167/203", language: "English",
        finish: "HOLO", confidence: "HIGH", evidence: ["The front shows Leafeon V and 167/203."] };
    assert.equal(photoMatchesCollectorMarket(e, market), true);
    check.cardIdentity.set = null;
    assert.equal(photoMatchesCollectorMarket(e, market), true, "exact fraction plus printed name");
    check.printedNumber = check.cardIdentity.cardNumber = "167";
    assert.equal(photoMatchesCollectorMarket(e, market), false, "a numerator alone cannot distinguish sets");
    check.cardIdentity.set = "Evolving Skies";
    assert.equal(photoMatchesCollectorMarket(e, market), true, "readable numerator and independently observed set");
    for (const mismatch of [{ name: "Leafeon VMAX" }, { cardNumber: "166/203" }, { cardNumber: "167/196" },
        { set: "Fusion Strike" }, { language: "Japanese" }, { language: null }, { finish: "REVERSE_HOLO" },
        { finish: "UNKNOWN" }, { confidence: "LOW" }, { evidence: [] }] as const) {
        const copy = structuredClone(e);
        Object.assign(copy.photoCheck!.cardIdentity!, mismatch);
        assert.equal(photoMatchesCollectorMarket(copy, market), false, JSON.stringify(mismatch));
    }
    const stock = structuredClone(e);
    stock.photoCheck!.images.forEach(image => { image.isStockImage = true; });
    assert.equal(photoMatchesCollectorMarket(stock, market), false, "stock image");
    check.printedNumber = "166/203";
    assert.equal(photoMatchesCollectorMarket(e, market), false, "conflicting front transcription");
    check.printedNumber = "167";
    e.identity!.hasEditions = true;
    assert.equal(photoMatchesCollectorMarket(e, market), false, "edition-sensitive market needs visual printing evidence");
    e.identity!.evidence = { title: "NOT_STATED", itemSpecifics: "NOT_STATED", photo: "FIRST_EDITION", photoNotes: [] };
    assert.equal(photoMatchesCollectorMarket(e, market), false, "conflicting observed stamp");
    e.identity!.evidence.photo = "UNLIMITED";
    assert.equal(photoMatchesCollectorMarket(e, market), true);
});

function rawCard(name: string, set: string, number: string, firstId: number, count: number, price = 50) {
    const value = cardEvaluation();
    Object.assign(value.listing, { id: `v1|${firstId + 10000}|0`, title: name, buyingOption: "FIXED_PRICE", availability: "ACTIVE", price, shipping: 0 });
    value.photoCheck!.cardCount = "ONE";
    Object.assign(value.identity!, { name, set, cardNumber: number });
    const summary = salesSummary("RAW", "LIGHTLY_PLAYED", Array(count).fill(300));
    summary.sales = summary.sales.map((s, i): CompSale => ({ ...s, soldAt: new Date(now - (i + 1) * day).toISOString(), title: name,
        url: `https://www.ebay.com/itm/${firstId + i}`, saleType: "auction", photoCondition: "LIGHTLY_PLAYED" }));
    value.gradedPricing = null;
    value.rawPricing = { status: "PRICED", source: "pkmnprices", printing: "UNLIMITED", variant: "Holofoil", conditionEvidence: "AI_PHOTOS",
        prices: [{ basis: "EBAY_SOLD", condition: "LIGHTLY_PLAYED", price: 300, updatedAt: null, comps: summary }] };
    value.underwriting = underwrite(value);
    return value;
}

test("same-set discovery keeps distinct recent completed sales separate by set, edition, finish and condition", () => {
    const gem = rawCard("Blastoise", "Pokémon Base Set", "2/102", 120000001100, 4);
    const duplicate = structuredClone(gem);
    duplicate.listing.id = "another-copy";
    duplicate.rawPricing!.prices![0].comps!.sales[0].url += "?tracking=1";
    const original = rawCard("Mewtwo Holofoil", "Base Set (Unlimited)", "010/102", 120000002100, 6);
    const thin = rawCard("Venusaur", "Base Set", "15/102", 120000003100, 2);
    const stamped = structuredClone(thin);
    stamped.identity!.printing = stamped.rawPricing!.printing = "FIRST_EDITION";
    const incorrect = rawCard("Gengar", "Fossil", "5/62", 120000004100, 8, 20);
    const bucket = rawCard("Zapdos", "Base Set", "16/102", 120000005100, 6);
    const sales = bucket.rawPricing!.prices![0].comps!.sales;
    sales[0].soldAt = new Date(now + day).toISOString();
    sales[1].soldAt = new Date(now - 34 * day).toISOString();
    sales[2].photoCondition = "MINT";
    sales[3].saleType = undefined;
    Object.assign(sales[4], { currency: "EUR" });
    const pool = [original, thin, stamped, gem, duplicate, incorrect, bucket];
    const exact = rankHuntMarkets(pool, origin, "resell", "same_set", now);
    assert.deepEqual(exact.map(m => [m.name, m.sales30, m.sales90, m.condition, m.medianUsd, m.listingIds.length]), [["Blastoise", 4, 4, "LIGHTLY_PLAYED", 300, 2]]);
    assert.equal(exact[0].liquidThrough, now + 27 * day);
    const any = rankHuntMarkets(pool, null, "resell", "any_card", now);
    assert.equal(any[0].name, "Gengar");
    assert.equal(rankHuntMarkets(pool, null, "collect_slab", "any_card", now).length, 0);
    assert.equal(rankHuntMarkets(pool, null, "resell", "same_set", now).length, 0);
});

test("ambiguous sale IDs, repeated URLs and expired markets never meet the activity threshold", () => {
    const gem = rawCard("Blastoise", "Base Set", "2/102", 120000001100, 3);
    const wrongGrade = structuredClone(gem);
    wrongGrade.identity!.printing = wrongGrade.rawPricing!.printing = "FIRST_EDITION";
    assert.deepEqual(rankHuntMarkets([gem, wrongGrade], origin, "resell", "same_set", now), []);
    const s = gem.rawPricing!.prices![0].comps!.sales;
    s[1].url = s[0].url + "?var=25";
    assert.deepEqual(rankHuntMarkets([gem], origin, "resell", "same_set", now), []);
    assert.deepEqual(rankHuntMarkets([gem], origin, "resell", "same_set", now + 90 * day), []);
});

test("only recent active fixed-price observations with known shipping can guide a live market search", () => {
    const gem = rawCard("Blastoise", "Base Set", "2/102", 120000001100, 3);
    Object.assign(gem.listing, { termsCheckedAt: new Date(now - day).toISOString(), endTime: null });
    const market = () => rankHuntMarkets([gem], null, "resell", "any_card", now)[0];
    assert.deepEqual(market().observedAsks, [{ listingId: gem.listing.id, price: 50, shipping: 0, potentialGrade: 8 }]);
    const original = { ...gem.listing };
    for (const terms of [{ termsCheckedAt: new Date(now - day - 1).toISOString() }, { termsCheckedAt: new Date(now + 1).toISOString() },
        { termsCheckedAt: undefined }, { endTime: new Date(now).toISOString() }, { availability: "UNKNOWN" },
        { buyingOption: "AUCTION" }, { shipping: null }, { shipping: -1 }]) {
        Object.assign(gem.listing, original, terms);
        assert.equal(market().observedAsks, undefined);
        assert.equal(market().sales30, 3);
    }
});

test("fixed-price raw market groups keep distinct collector totals and acquisition limits", () => {
    const lead: HuntMarket = { name: "Leafeon V", set: "Evolving Skies", cardNumber: "167/203", printing: "UNLIMITED",
        finish: "HOLO", kind: "raw", grader: null, grade: null, condition: "LIGHTLY_PLAYED",
        sales30: 3, sales90: 3, latestSaleAt: new Date(now).toISOString(), medianUsd: 50, listingIds: [], projectedProfit: null };
    const other = { ...lead, cardNumber: "167/204", medianUsd: 100 };
    const partial = { ...lead, cardNumber: "167", medianUsd: 75 };
    const padded = { ...lead, cardNumber: "0167/0203" };
    const targets = { minProfit: 10, minRoi: 0 };
    const groups = groupMarketSearches([lead, other, partial, padded], "resell", targets, { typeFilter: "FIXED_PRICE" }, 0);
    assert.deepEqual(groups.map(g => g.leads), [[lead, padded], [other], [partial]]);
    assert.deepEqual(groups.map(g => g.ceiling), [lead, other, partial].map(m => marketItemLimit(m, "resell", targets, 0)));
});

test("cross-card grading can scout a new raw market from exact slab sales without treating the slab as an acquisition", () => {
    const makeSlab = (grader: string, grade: number) => {
        const e = rawCard("Venusaur", "Base Set", "15/102", 120000030000, 3);
        const title = `Venusaur Base Set 15/102 Unlimited Holo ${grader} ${grade}`;
        const slab = { status: "OK" as const, grader, grade: String(grade), caseCondition: "INTACT", gradeQualifier: null,
            certNumber: null, certUrl: null, labelText: title, reasons: [], concerns: [] };
        const summary = salesSummary(grader, grade, [195, 200, 205]);
        summary.sales.forEach((sale, i) => Object.assign(sale, { soldAt: new Date(now - (i + 1) * day).toISOString(),
            title, saleType: "fixed_price", url: `https://www.ebay.com/itm/${120000040000 + i}` }));
        Object.assign(e.listing, { title, termsCheckedAt: new Date(now).toISOString() });
        Object.assign(e.photoCheck!, { holder: "GRADED_SLAB", slab: { ...slab, present: true, authenticity: "NONE_SEEN" } });
        Object.assign(e, { condition: null, rawPricing: null, slab,
            slabPricing: { status: "PRICED", printing: "UNLIMITED", variant: "Unlimited Holofoil", grader, grade, summary } });
        e.underwriting = underwrite(e);
        return e;
    };
    const psa = makeSlab("PSA", 7);
    const gradeMarkets = (e = psa) => rankHuntMarkets([e], null, "grade_raw", "any_card", now);
    const [lead] = gradeMarkets();
    assert.ok(lead);
    assert.deepEqual([lead.kind, lead.grader, lead.grade, lead.condition, lead.sales30, lead.medianUsd], ["raw", "PSA", 7, null, 3, 200]);
    assert.deepEqual([lead.listingIds, lead.observedAsks, lead.projectedProfit], [[], undefined, null]);
    const [slab] = rankHuntMarkets([psa], null, "resell", "any_card", now);
    const targets = { minProfit: 25, minRoi: 0 };
    const [group] = groupMarketSearches([lead], "grade_raw", targets, { typeFilter: "FIXED_PRICE", kindFilter: "raw" }, 0);
    assert.equal(group.intents[0].graded, false);
    assert.equal(group.ceiling, marketItemLimit(lead, "grade_raw", targets, 0));
    assert.ok(group.ceiling > 0 && group.ceiling < marketItemLimit(slab, "resell", targets, 0), "raw acquisition ceiling includes submission costs");
    const raw = rawCard("Venusaur", "Base Set", "15/102", 120000050000, 3);
    raw.gradedPricing = { PSA: { status: "PRICED", printing: "UNLIMITED", variant: "Unlimited Holofoil",
        byGrade: [structuredClone(psa.slabPricing!.summary!)] } };
    const combined = rankHuntMarkets([raw, psa], null, "grade_raw", "any_card", now);
    assert.deepEqual(combined.map(m => [m.kind, m.sales30, m.listingIds]), [["raw", 3, [raw.listing.id]]]);
    assert.equal(gradeMarkets(makeSlab("CGC", 7)).length, 1);
    assert.equal(gradeMarkets(makeSlab("BGS", 7)).length, 0);
    assert.equal(gradeMarkets(makeSlab("CGC", 8.5)).length, 0);
    assert.equal(rankHuntMarkets([psa], origin, "grade_raw", "same_set", now).length, 0);
    assert.equal(rankHuntMarkets([psa], null, "collect_slab", "any_card", now)[0].kind, "slab");
    psa.photoCheck!.slab!.grade = "8";
    assert.deepEqual(gradeMarkets(), []);
    psa.photoCheck!.slab!.grade = "7";
    const sale = psa.slabPricing!.summary!.sales[2];
    for (const title of ["Venusaur Base Set 15/102 Unlimited Holo CGC 7", "Venusaur Base Set 15/102 First Edition Holo PSA 7",
        "Venusaur Base Set 15/102 Unlimited Reverse Holo PSA 7", "Blastoise Base Set 2/102 Unlimited Holo PSA 7"]) {
        sale.title = title;
        assert.deepEqual(gradeMarkets(), [], title);
    }
});

test("an affordable observed ask can put the ninth market on the menu without promoting other cards outside the buyer's limits", () => {
    const gem = rawCard("Blastoise", "Base Set", "2/102", 120000001100, 3);
    Object.assign(gem.listing, { termsCheckedAt: new Date(now).toISOString(), endTime: null, shipping: 5 });
    const lead = rankHuntMarkets([gem], null, "resell", "any_card", now)[0];
    const empty = Array.from({ length: 8 }, (_, index) => ({ ...lead, cardNumber: (index + 20) + "/102", observedAsks: undefined }));
    const menu = (maxPrice: number, minPrice = 0, minGrade = 0, ids: Set<string> = new Set(), profit = 0) =>
        groupMarketSearches([...empty, lead], "resell", { minProfit: profit, minRoi: 0 }, { maxPrice, minPrice }, minGrade, ids);
    const ranked = menu(60);
    assert.equal(ranked.length, 8);
    assert.equal(ranked[0].intents[0].cardNumber, "2/102");
    assert.equal(ranked[0].observedPurchaseTotal, 59.54);
    assert.equal(ranked[1].intents[0].cardNumber, "20/102");
    for (const groups of [menu(59.53), menu(60, 51), menu(60, 0, 9), menu(60, 0, 0, new Set([gem.listing.id])),
        menu(300, 0, 0, new Set(), 250)]) {
        assert.ok(groups.every(group => group.observedPurchaseTotal === undefined));
    }
});

test("legacy sale types require native confirmed USD evidence for the same transaction and market", async () => {
    const e = rawCard("Blastoise", "Base Set", "2/102", 123000001100, 6);
    e.identity!.recordId = 12933;
    const rows = e.rawPricing!.prices![0].comps!.sales;
    rows.forEach(row => { delete row.saleType; });
    const native = rows.map((row, i): Comp => ({
        title: "Blastoise Unlimited Base Set 2/102 Holo", id: i, listing_url: row.url, attribution: "exact", price: row.price,
        sold_at: row.soldAt, sale_type: "fixed_price", currency: "USD", variant: "Holofoil", grade: null, grader: null, grade_qualifier: null,
    }));
    native[2].price += 5;
    native[3].currency = "EUR";
    const key = confirmedHuntPage(12933, "Holofoil", null, null);
    const read = async (roots: Map<string, Set<string>>, now: number) => {
        assert.deepEqual([...roots.keys()], [key]);
        return savedHuntSaleRows(roots, now, undefined, async pages => new Map(pages.map(page => [page, page === key
            ? { data: native.slice(0, 5), pagination: { has_more: true, next_cursor: "second" } }
            : { data: [native[5], { ...native[4], currency: "EUR", updated_at: "2026-11-24" }] }])));
    };
    await restoreSavedHuntSales([e], "resell", now, undefined, read);
    assert.deepEqual(rows.map(row => row.saleType ?? null), ["fixed_price", "fixed_price", null, null, null, "fixed_price"]);
    assert.equal(rankHuntMarkets([e], origin, "resell", "same_set", now)[0].sales30, 3);
});

test("auction hunt menu reserves space for a liquid slab from auction-only history despite many expensive BIN opportunities", () => {
    const raw = rawCard("Blastoise", "Base Set", "2/102", 120000001100, 3);
    raw.listing.buyingOption = "AUCTION";
    const [lead] = rankHuntMarkets([raw], null, "resell", "any_card", now);
    assert.equal(lead.listingIds.length, 0);
    assert.equal(lead.sales30, 3);
    const highBinProfits = Array.from({ length: 8 }, (_, i) => ({ ...lead, name: "Other " + i, projectedProfit: 1000, sales30: 4 }));
    const slab = { ...lead, kind: "slab" as const, grader:"PSA", grade:8, condition:null };
    const menu = groupMarketSearches([...highBinProfits, lead, slab], "resell", { minProfit:0,minRoi:0 }, {typeFilter:"AUCTION"}, 0);
    assert.equal(menu.length, 8);
    assert.ok(menu.some(group => group.leads.includes(slab)), "both raw and slab exits appear in the bounded menu");
    assert.ok(menu.every(group => group.observedPurchaseTotal === undefined));
});
