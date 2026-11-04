import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSoldScreening } from "../../server/pricing/screening-sales.ts";
import { ScreeningPriceBudgetError } from "../../server/pricing/pkmnprices.ts";
import { PriceResearchBudgetError } from "../../server/pricing/research-budget.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import type { CardRecord, Comp, FetchSoldPage } from "../../server/pricing/types.ts";
import type { ListingSummary, SearchIntent } from "../../shared/types.ts";
import { applySoldPriceScreen } from "../../shared/money/sold-screen.ts";
import { readTitleByRules, readTitleWithoutAi } from "../../server/ai/title-reader.ts";
import { screenListingWithoutAi } from "../../server/deals/screen-listing.ts";
import { canAutoAnalyze, resultGroup } from "../../shared/analysis.ts";
import { readSearchLocally, readSearchWithoutAi } from "../../server/search/intent.ts";
import { findDeals } from "../../server/deals/find-deals.ts";
import { writeCache } from "../../server/lib/cache.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z"), DAY = 86_400_000;
const intent: SearchIntent = { cardName: "Charizard", sets: ["Base Set"], cardNumber: "4/102", printing: null, graded: null, titleWords: ["charizard"], source: "rules" };
const variant = (name = "Unlimited Holofoil", printing: "UNLIMITED" | "FIRST_EDITION" | "SHADOWLESS" | "UNKNOWN" = "UNLIMITED", finish = "HOLO") => ({ name, printing, finish, prices: [] });
const card = (extra: Partial<CardRecord> = {}): CardRecord => ({ source: "pkmnprices", id: 1, name: "Charizard", setName: "Base Set", cardNumber: "4/102", tcgPlayerId: null, variants: [variant()], ...extra });
const listing = (extra: Partial<ListingSummary> = {}): ListingSummary => ({ id: "v1|listing|0", title: "Charizard Base Set 4/102 Unlimited Holo", currentPrice: 40, shipping: 5, bids: 0, isGraded: false, buyingOption: "FIXED_PRICE", endTime: null, images: [], url: "https://www.ebay.com/itm/123", seller: null, ...extra });
let saleId = 0;
const sale = (extra: Partial<Comp> = {}): Comp => ({ id: ++saleId, title: "Charizard Base Set 4/102 Unlimited Holo NM", price: 100, sold_at: new Date(NOW - DAY).toISOString(), variant: "Unlimited Holofoil", grader: null, grade: null, currency: "USD", sale_type: "fixed_price", grade_qualifier: null, attribution: "exact", listing_url: `https://www.ebay.com/itm/${saleId}`, ...extra });
const three = (extra: Partial<Comp> = {}) => [90, 100, 110].map(price => sale({ price, ...extra }));
function harness(options: { cards?: CardRecord[]; raw?: (record: number | string, label: string) => Promise<Comp[]>; graded?: (...args: any[]) => Promise<Comp[]>; page?: FetchSoldPage; lookup?: (...args: any[]) => Promise<CardRecord[]>; signal?: AbortSignal } = {}) {
    const calls = { lookup: 0, raw: [] as unknown[][], graded: [] as unknown[][], pages: [] as Parameters<FetchSoldPage>[] };
    const run = createSoldScreening({ now: () => NOW, signal: options.signal, source: {
        lookupCards: async query => { calls.lookup++; return options.lookup ? options.lookup(query) : options.cards ?? [card()]; },
        fetchRawComps: async (...args) => { calls.raw.push(args); return options.raw ? options.raw(...args) : three(); },
        fetchComps: async (...args) => { calls.graded.push(args); return options.graded ? options.graded(...args) : []; },
        ...(options.page ? { fetchSoldPage: async (...args: Parameters<FetchSoldPage>) => { calls.pages.push(args); return options.page!(...args); } } : {}),
    } });
    return { run, calls };
}

test("explicit Jungle No Symbol claims retain unpriced visibility without borrowing ordinary raw or slab references", async () => {
    const { run, calls } = harness({ lookup: async () => assert.fail("unsupported No Symbol markets must not buy ordinary price research") });
    for (const [name, number, spelling] of [["Jolteon", "4/64", "No Symbol"], ["Vaporeon", "12/64", "NO-SYMBOL"], ["Snorlax", "11/64", "NoSymbol"]]) {
        const wanted: SearchIntent = { ...intent, cardName: name, sets: ["Jungle"], cardNumber: number };
        for (const isGraded of [false, true]) {
            const subject = listing({ title: `${name} Jungle ${number} Unlimited Holo ${spelling} ${isGraded ? "PSA 8" : ""}`, isGraded, currentPrice: 5000,
                screen: { status: "UNSCREENED", card: { name, set: "Jungle", cardNumber: number, printing: "UNLIMITED" } } });
            const evidence = await run(subject, wanted);
            assert.equal(evidence.status, "UNAVAILABLE");
            assert.equal(evidence.exactScope, false);
            assert.deepEqual(evidence.references, []);
            const retained = applySoldPriceScreen(subject, evidence);
            assert.equal(retained.screen.status, "UNSCREENED");
            assert.equal(resultGroup(retained, null), "candidates");
            assert.equal(canAutoAnalyze(retained), false);
        }
    }
    assert.equal(calls.lookup, 0); assert.equal(calls.raw.length, 0); assert.equal(calls.graded.length, 0);
});

test("ordinary Jungle still uses exact sold references and missing edition wording is not treated as No Symbol", async () => {
    const wanted: SearchIntent = { ...intent, cardName: "Jolteon", sets: ["Jungle"], cardNumber: "4/64" };
    const { run } = harness({ cards: [card({ name: "Jolteon", setName: "Jungle", cardNumber: "4/64" })],
        graded: async () => three({ title: "Jolteon Jungle 4/64 Unlimited Holo PSA 8", grader: "PSA", grade: "8" }) });
    for (const suffix of ["", "No First Edition symbol", "without a 1st Edition stamp"]) {
        const subject = listing({ title: `Jolteon Jungle 4/64 Unlimited Holo PSA 8 ${suffix}`, isGraded: true, currentPrice: 5000,
            screen: { status: "UNSCREENED", card: { name: "Jolteon", set: "Jungle", cardNumber: "4/64", printing: "UNLIMITED" } } });
        const evidence = await run(subject, wanted);
        if (!suffix) {
            assert.equal(evidence.exactScope, true);
            assert.equal(evidence.references[0].summary.count, 3);
            assert.equal(applySoldPriceScreen(subject, evidence).screen.status, "DROPPED");
        } else {
            assert.doesNotMatch(evidence.note, /No Symbol/i, suffix);
            assert.equal(applySoldPriceScreen(subject, evidence).screen.status, "UNSCREENED", "existing unresolved edition wording remains visible");
        }
    }
});

test("literal modern names reach exact sold-price exclusion before buying labels, while cheap matching copies still need photos", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("modern title regressions must remain offline"));
    for (const [name, set, number, title] of [
        ["Rayquaza V", "Evolving Skies", "194/203", "PSA 9 Pokemon 2021 Rayquaza V 194/203 Full Art Ultra Rare Evolving Skies"],
        ["Rayquaza V", "Evolving Skies", "194/203", "Pokemon 2021 SWSH Evolving Skies Rayquaza V #194/203 PSA 9 MINT"],
        ["Rayquaza V", "Evolving Skies", "194/203", "Pokemon Rayquaza V (Alternate Full Art) 194/203 SWSH07:Evolving Skies Holo PSA 9"],
        ["Giratina V", "Lost Origin", "186/196", "Pokemon Sword & Shield Giratina V Lost Origin 186/196 Alt/Full Art Holo PSA 9"],
    ]) {
        const wanted: SearchIntent = { ...intent, cardName: name, sets: [set], cardNumber: number, titleWords: [name.split(" ")[0].toLowerCase()] };
        const { run, calls } = harness({ cards: [card({ name: `${name} (Alternate Full Art)`, setName: set, cardNumber: number })],
            graded: async () => three({ title: `${name} ${set} ${number} Unlimited Holo PSA 9`, price: 400, grader: "PSA", grade: "9" }) });
        const subject = await screenListingWithoutAi(listing({ title, isGraded: true, currentPrice: 800, shipping: 0, images: ["front", "back"] }),
            wanted, undefined, async value => readTitleByRules(value));
        assert.equal(subject.screen!.card!.name, name.toLowerCase(), title);
        const evidence = await run(subject, wanted);
        assert.equal(evidence.exactScope, true, title);
        assert.equal(evidence.references[0].summary.count, 3);
        const overpriced = applySoldPriceScreen(subject, evidence);
        assert.equal(overpriced.screen.status, "DROPPED", title);
        assert.equal(canAutoAnalyze(overpriced), false, "existing sold evidence excludes the high price without a paid label check");
        const cheap = applySoldPriceScreen({ ...subject, currentPrice: 200 }, evidence);
        assert.equal(canAutoAnalyze(cheap), true);
        assert.equal(resultGroup(cheap, null), "candidates", "metadata never creates a verified Deal");
        assert.equal(calls.lookup, 1); assert.equal(calls.graded.length, 1);
    }
});

test("catalog-backed modern query and title identity reach sold research before photo admission", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("catalog identity and sold-screening fixture must remain offline"));
    const names = ["paldea evolved", "fusion strike"];
    const wanted = readSearchLocally("Magikarp Paldea Evolved 203/193 PSA 9", names);
    const { run, calls } = harness({ cards: [card({ name: "Magikarp", setName: "SV02: Paldea Evolved", cardNumber: "203/193" })],
        graded: async () => three({ title: "Magikarp Paldea Evolved 203/193 Holo PSA 9", price: 400, grader: "PSA", grade: "9" }) });
    const subject = await screenListingWithoutAi(listing({ title: "Pokemon Magikarp Paldea Evolved 203/193 Holo PSA 9", isGraded: true,
        currentPrice: 800, shipping: 0, images: ["front", "back"] }), wanted, undefined, async value => readTitleByRules(value, names));
    assert.equal(subject.screen!.card!.name, "magikarp"); assert.equal(subject.screen!.card!.set, "paldea evolved");
    const evidence = await run(subject, wanted);
    assert.equal(calls.lookup, 1); assert.equal(calls.graded.length, 1);
    assert.equal(evidence.status, "AVAILABLE"); assert.equal(evidence.exactScope, true);
    assert.equal(applySoldPriceScreen(subject, evidence).screen.status, "DROPPED", "an overpriced catalog-backed release needs no paid photo work");
    assert.equal(canAutoAnalyze(applySoldPriceScreen({ ...subject, currentPrice: 200 }, evidence)), true);
});

test("normal findDeals uses cached set names in query, listing and sold-title matching without provider or photo calls", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("all external transports are prohibited in this regression"));
    await writeCache("pokemonpricetracker:set-years", { "paldea evolved": 2023, "fusion strike": 2021 });
    const { run, calls } = harness({ lookup: async query => {
        assert.equal(query.set, "paldea evolved"); assert.equal(query.name, "magikarp");
        return [card({ name: "Magikarp", setName: "SV02: Paldea Evolved", cardNumber: "203/193" })];
    }, graded: async () => three({ title: "Magikarp Paldea Evolved 203/193 Holo PSA 9", price: 400, grader: "PSA", grade: "9" }) });
    const page = [
        listing({ id: "overpriced", title: "Magikarp Paldea Evolved 203/193 Holo PSA 9", isGraded: true, currentPrice: 800, shipping: 0, images: ["front", "back"] }),
        listing({ id: "candidate", title: "Magikarp Paldea Evolved 203/193 Holo PSA 9", isGraded: true, currentPrice: 200, shipping: 0, images: ["front", "back"] }),
        listing({ id: "wrong-set", title: "Magikarp Fusion Strike 203/193 Holo PSA 9", isGraded: true, images: ["front", "back"] }),
    ];
    let sourceCalls = 0;
    const rows = await findDeals("Magikarp Paldea Evolved 203/193 PSA 9", { filters: { typeFilter: "FIXED_PRICE" } }, {
        readIntent: readSearchWithoutAi, readTitle: readTitleWithoutAi, soldScreening: () => run,
        search: async () => { sourceCalls++; return { listings: page, total: page.length, skipped: 0 }; },
    });
    assert.equal(sourceCalls, 1); assert.equal(calls.lookup, 1); assert.equal(calls.graded.length, 1);
    assert.deepEqual(rows.map(row => row.id), ["candidate"]);
    assert.equal(rows[0].screen!.soldEvidence!.exactScope, true);
    assert.equal(canAutoAnalyze(rows[0]), true);
    assert.equal(resultGroup(rows[0], null), "candidates", "literal catalog metadata does not manufacture a Deal");
});

test("modern descriptor cleanup cannot manufacture missing identity fields, printing/finish scope or ordinary qualifiers", async () => {
    const wanted: SearchIntent = { ...intent, cardName: "Rayquaza V", sets: ["Evolving Skies"], cardNumber: "194/203" };
    const { run } = harness({ cards: [card({ name: "Rayquaza V (Alternate Full Art)", setName: "Evolving Skies", cardNumber: "194/203" })],
        graded: async () => three({ title: "Rayquaza V Evolving Skies 194/203 Unlimited Holo PSA 9", grader: "PSA", grade: "9" }) });
    for (const title of [
        "Pokemon Evolving Skies 194/203 Full Art Holo PSA 9",
        "Rayquaza V 194/203 Full Art Holo PSA 9",
        "Rayquaza V Evolving Skies Full Art Holo PSA 9",
        "Rayquaza V Evolving Skies 194/203 SWSH11 Full Art Holo PSA 9",
        "Rayquaza V Evolving Skies 194/203 Curious Art Holo PSA 9",
        "Rayquaza V Evolving Skies 194/203 First Edition Full Art Holo PSA 9",
        "Rayquaza V Evolving Skies 194/203 Full Art Holo PSA 9 (OC)",
        "Rayquaza V Evolving Skies 194/203 Full Art Holo PSA 9 Miscut",
        "Rayquaza V Evolving Skies 194/203 Full Art Holo CGC Pristine 10",
    ]) {
        const subject = listing({ title, isGraded: true, currentPrice: 5000 });
        const evidence = await run(subject, wanted);
        assert.equal(evidence.exactScope, false, title);
        if (/\(OC\)|Miscut|Pristine/i.test(title)) assert.deepEqual(evidence.references, [], "special labels do not borrow an ordinary slab sold scope");
        assert.equal(applySoldPriceScreen(subject, evidence).screen.status, "UNSCREENED", title);
    }
    const multiple = harness({ cards: [card({ name: "Rayquaza V", setName: "Evolving Skies", cardNumber: "194/203", variants: [
        variant(), variant("1st Edition Holofoil", "FIRST_EDITION"), variant("Unlimited Reverse Holofoil", "UNLIMITED", "REVERSE_HOLO"),
    ] })], graded: async (_id, target) => three({ title: `Rayquaza V Evolving Skies 194/203 ${target.variant.startsWith("1st") ? "1st Edition" : "Unlimited"} ${target.variant.includes("Reverse") ? "Reverse Holo" : "Holo"} PSA 9`,
        grader: "PSA", grade: "9", variant: target.variant }) });
    for (const title of [
        "Rayquaza V Evolving Skies 194/203 Full Art PSA 9",
        "Rayquaza V Evolving Skies 194/203 Full Art Holo PSA 9",
    ]) {
        const subject = listing({ title, isGraded: true, currentPrice: 5000 });
        const evidence = await multiple.run(subject, wanted);
        assert.equal(evidence.status, "AVAILABLE", title);
        assert.equal(evidence.exactScope, false, "remaining printing/finish alternatives are kept separate");
        assert.equal(applySoldPriceScreen(subject, evidence).screen.status, "UNSCREENED", title);
    }
});

test("an explicit miscut or qualified slab stays visible and unpriced even if its saved name is clean or literal name is unresolved", async () => {
    const { run, calls } = harness({ lookup: async () => assert.fail("a special live slab cannot borrow ordinary sold research") });
    for (const [name, set, number, qualifier] of [
        ["Rayquaza V", "Evolving Skies", "194/203", "Miscut"],
        ["Giratina V", "Lost Origin", "186/196", "Miscut Error Special Alignment"],
        ["Rayquaza V", "Evolving Skies", "194/203", "(OC)"],
        ["Giratina V", "Lost Origin", "186/196", "Qualified"],
    ]) {
        const wanted: SearchIntent = { ...intent, cardName: name, sets: [set], cardNumber: number };
        const subject = listing({ title: `${name} ${set} ${number} Full Art Holo PSA 9 ${qualifier}`, isGraded: true,
            currentPrice: 800, images: ["front", "back"], listedAttributes: { grader: "PSA", grade: 9, finish: "HOLO" },
            screen: { status: "UNSCREENED", needsAnalysis: "SLAB_LABEL", reason: "Saved title context", bestCase: null, assumed: null,
                card: { name, set, cardNumber: number, printing: "UNKNOWN", printingLabel: null } } });
        const evidence = await run(subject, wanted), result = applySoldPriceScreen(subject, evidence);
        assert.equal(evidence.status, "UNAVAILABLE"); assert.equal(evidence.exactScope, false);
        assert.deepEqual(evidence.references, []);
        assert.equal(result.screen.status, "UNSCREENED", "special inventory is not discarded as an ordinary price exclusion");
        assert.equal(resultGroup(result, null), "candidates");
        assert.equal(canAutoAnalyze(result), false, "ordinary sold references cannot buy a special-label assessment");
    }
    assert.equal(calls.lookup, 0); assert.equal(calls.graded.length, 0);
});

test("raw sold references keep independent condition buckets and confirmed transaction amounts", async () => {
    const { run, calls } = harness({ raw: async () => [
        ...three(), ...[50, 55, 60].map(price => sale({ title: "Charizard Base Set 4/102 Unlimited Holo LP", price })),
        ...[10, 12].map(price => sale({ title: "Charizard Base Set 4/102 Unlimited Holo Damaged", price })),
        sale({ title: "Charizard Base Set 4/102 Unlimited Holo" }), sale({ sale_type: null }), sale({ attribution: "shared" }),
        sale({ currency: "EUR" }), sale({ price: Infinity }), sale({ sold_at: new Date(NOW + DAY).toISOString() }),
        sale({ sold_at: new Date(NOW - 91 * DAY).toISOString() }), sale({ variant: "Unlimited Reverse Holofoil" }),
        sale({ title: "Charmander Base Set 46/102 Unlimited Holo NM" }), sale({ title: "Charizard Base Set 4/102 Unlimited Holo NM lot of 2 cards" }),
    ] });
    const result = await run(listing(), intent);
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, true);
    assert.deepEqual(result.references.map(reference => [reference.condition, reference.summary.count, reference.summary.median]), [["NEAR_MINT", 3, 100], ["LIGHTLY_PLAYED", 3, 55], ["DAMAGED", 2, 11], [null, 1, 100]]);
    assert.ok(result.references.every(reference => reference.grader === null && reference.grade === null && reference.summary.windowDays === 90));
    assert.equal(calls.raw.length, 1); assert.equal(calls.graded.length, 0);
});

test("slabs research one exact grader and half grade without raw or speculative grading work", async () => {
    const { run, calls } = harness({ graded: async () => [
        ...three({ title: "Charizard Base Set 4/102 Unlimited Holo CGC 8.5", grader: "CGC", grade: "8.5" }),
        sale({ title: "Charizard Base Set 4/102 Unlimited Holo CGC 8", grader: "CGC", grade: "8", price: 5 }),
        sale({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8.5", grader: "PSA", grade: "8.5", price: 5 }),
        sale({ title: "Charizard Base Set 4/102 Unlimited Holo CGC 8.5", grader: "CGC", grade: "8.5", grade_qualifier: "Pristine", price: 5000 }),
        sale({ title: "Charizard Base Set 4/102 Unlimited Holo CGC Pristine 8.5", grader: "CGC", grade: "8.5", grade_qualifier: null, price: 5000 }),
    ] });
    const result = await run(listing({ title: "Charizard Base Set 4/102 Unlimited Holo CGC 8.5", isGraded: true }), intent);
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.references.length, 1);
    assert.deepEqual([result.references[0].grader, result.references[0].grade, result.references[0].condition, result.references[0].summary.count], ["CGC", "8.5", null, 3]);
    assert.deepEqual(calls.graded, [[1, { grader: "CGC", grade: "8.5", variant: "Unlimited Holofoil" }]]);
    assert.equal(calls.raw.length, 0);
});

test("hyphen-delimited slab grades reach exact sold screening without admitting potential or qualified labels", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("title screening uses only the supplied offline source"));
    const wanted: SearchIntent = { ...intent, cardName: "Jolteon", sets: ["Jungle"], cardNumber: "4/64" };
    const { run, calls } = harness({ cards: [card({ name: "Jolteon", setName: "Jungle", cardNumber: "4/64" })],
        graded: async () => three({ title: "Jolteon Jungle 4/64 Unlimited Holo PSA 8", grader: "PSA", grade: "8" }) });
    for (const delimiter of ["- ", " - "]) {
        const subject = await screenListingWithoutAi(listing({ title: `Jolteon Jungle 4/64 Unlimited Holo PSA${delimiter}8 with a protective case`, isGraded: true }),
            wanted, undefined, async title => readTitleByRules(title));
        assert.deepEqual(subject.listedAttributes, { grader: "PSA", grade: 8, finish: "HOLO" });
        const evidence = await run(subject, wanted);
        assert.equal(evidence.status, "AVAILABLE"); assert.equal(evidence.exactScope, true);
        assert.deepEqual([evidence.references[0].grader, evidence.references[0].grade], ["PSA", "8"]);
    }
    assert.deepEqual(calls.graded, [[1, { grader: "PSA", grade: "8", variant: "Unlimited Holofoil" }]]);
    assert.equal(calls.raw.length, 0);
    for (const suffix of ["raw potential PSA- 10", "PSA-ready 10", "BGS 8 cross to PSA- 10", "PSA- 8 (OC)", "CGC- Pristine 10"]) {
        const excluded = harness({ cards: [card({ name: "Jolteon", setName: "Jungle", cardNumber: "4/64" })],
            graded: async () => assert.fail("a speculative or special label cannot authorize an ordinary slab sold scope") });
        const evidence = await excluded.run(listing({ title: `Jolteon Jungle 4/64 Unlimited Holo ${suffix}`, isGraded: true }), wanted);
        assert.equal(evidence.status, "UNAVAILABLE", suffix);
        assert.equal(evidence.exactScope, false, suffix);
        assert.equal(excluded.calls.graded.length + excluded.calls.raw.length, 0, suffix);
    }
    assert.equal(fetch.mock.callCount(), 0);
});

test("explicit slab titles with publisher or holder metadata reach existing overpricing exclusion", async () => {
    const { run, calls } = harness({ graded: async () => three({
        title: "Charizard Base Set 4/102 Unlimited Holo CGC 9 Mint", grader: "CGC", grade: "9", price: 1950,
    }) });
    const subjects = [
        listing({ title: "1999 Pokemon Base Set Unlimited Charizard Holo Card 4/102 CGC 9 Mint w/ Guard", isGraded: true, currentPrice: 2499, shipping: 0 }),
        listing({ title: "Wizards of the Coast Pokemon Base Set Unlimited Charizard 4/102 Holo CGC 9 1999", isGraded: true, currentPrice: 5000, shipping: 10 }),
    ].map(subject => ({ ...subject, listedAttributes: { grader: "CGC", grade: 9, finish: "HOLO" as const },
        screen: { status: "UNSCREENED" as const, reason: "Saved title lacked a name", bestCase: null, assumed: null,
            card: { name: null, set: "Base Set", cardNumber: "4/102", printing: "UNLIMITED" as const, printingLabel: null } } }));
    for (const subject of subjects) {
        const evidence = await run(subject, intent);
        assert.equal(evidence.exactScope, true, subject.title);
        assert.equal(evidence.references[0].summary.count, 3);
        const screened = applySoldPriceScreen(subject, evidence);
        assert.equal(screened.screen.status, "DROPPED"); assert.equal(screened.screen.needsAnalysis, undefined);
        assert.ok(screened.screen.bestCase!.profit < 0);
    }
    assert.equal(calls.lookup, 1); assert.equal(calls.graded.length, 1); assert.equal(calls.raw.length, 0);
});

test("publisher and holder cleanup supports another exact species and grade without borrowing a missing set", async () => {
    const wanted = { ...intent, cardName: "Vaporeon", sets: ["Jungle"], cardNumber: "12/64" };
    const { run, calls } = harness({ cards: [card({ name: "Vaporeon", setName: "Jungle", cardNumber: "12/64" })],
        graded: async () => three({ title: "Vaporeon Jungle 12/64 Unlimited Holo PSA 8", grader: "PSA", grade: "8" }) });
    const subject = listing({ title: "Wizards of the Coast Vaporeon Jungle 12/64 Unlimited Holo PSA 8 with a protective case", isGraded: true, currentPrice: 1000 });
    const exact = await run(subject, wanted);
    assert.equal(exact.exactScope, true); assert.equal(applySoldPriceScreen(subject, exact).screen.status, "DROPPED");
    const noSet = { ...subject, title: "Vaporeon 12/64 Unlimited Holo PSA 8 with a protective case" };
    const preliminary = await run(noSet, wanted);
    assert.equal(preliminary.status, "AVAILABLE"); assert.equal(preliminary.exactScope, false);
    assert.equal(applySoldPriceScreen(noSet, preliminary).screen.status, "UNSCREENED");
    assert.equal(calls.lookup, 1); assert.equal(calls.graded.length, 1);
});

test("Dragonite's publisher and artist sales count on their existing first page without following a cursor", async () => {
    const wanted: SearchIntent = { ...intent, cardName: "Dragonite", sets: ["Fossil"], cardNumber: "4/62" };
    const record = card({ id: 10726, name: "Dragonite", setName: "Fossil", cardNumber: "04/62" });
    const sales = [
        sale({ title: "Pokemon Dragonite Holo Fossil Unlimited 4/62 PSA 8", price: 355, sold_at: "2026-11-01", grader: "PSA", grade: "8" }),
        sale({ title: "The Pokémon Company Fossil Dragonite Holo 4/62 Unlimited 1999 English PSA 8", price: 319, sold_at: "2026-10-29", grader: "PSA", grade: "8" }),
        sale({ title: "Dragonite 4/62 Holo Rare Unlimited Fossil 1999 PSA 8 NM-MT Himeno", price: 402.02, sold_at: "2026-10-22", grader: "PSA", grade: "8" }),
        sale({ title: "Pokemon Fossil Dragonite Holo Rare 4/62 Unlimited PSA 8 English 1999 W/ GUARD", price: 320, sold_at: "2026-10-20", grader: "PSA", grade: "8" }),
        ...["The Pokémon Company Fossil Dark Dragonite 4/62 Unlimited Holo PSA 8", "Dragonite Fossil 5/62 Unlimited Holo PSA 8 Himeno",
            "Dragonite Fossil 4/62 Unlimited Holo PSA 9 Himeno", "Dragonite Fossil 4/62 1st Edition Holo PSA 8 Himeno"].map(title => sale({ title, grader: "PSA", grade: "8" })),
    ];
    const { run, calls } = harness({ cards: [record], page: async (_id, target) => {
        assert.equal(target.cursor, undefined, "four applicable first-page sales already satisfy this exact market");
        return { sales, nextCursor: "unnecessary-page" };
    } });
    const result = await run(listing({ title: "Dragonite Fossil 4/62 Unlimited Holo PSA 8", isGraded: true }), wanted);
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, true);
    assert.equal(result.references[0].summary.count, 4);
    assert.equal(result.references[0].summary.median, 337.5);
    assert.equal(calls.pages.length, 1);
});

test("holder cleanup never upgrades missing-set, special-label or mixed-printing claims to an exclusion scope", async () => {
    const graded = async (_id: number | string, target: { grader: string; grade: string; variant: string }) => three({
        title: `Charizard Base Set 4/102 ${target.variant.startsWith("1st") ? "1st Edition" : "Unlimited"} Holo ${target.grader} ${target.grade}`,
        grader: target.grader, grade: target.grade, variant: target.variant,
    });
    const { run } = harness({ graded });
    const noSet = listing({ title: "1999 Pokemon Unlimited Charizard Rare Holo #4/102 CGC 9", isGraded: true, currentPrice: 3200 });
    const evidence = await run(noSet, intent);
    assert.equal(evidence.status, "AVAILABLE"); assert.equal(evidence.exactScope, false);
    assert.equal(applySoldPriceScreen(noSet, evidence).screen.status, "UNSCREENED");
    for (const title of [
        "Wizards of the Coast Charizard Base Set 4/102 Unlimited Holo PSA 8 (OC) with Guard",
        "Wizards of the Coast Charizard Base Set 4/102 Unlimited Holo CGC Pristine 10 with Guard",
    ]) {
        const special = harness({ graded });
        assert.equal((await special.run(listing({ title, isGraded: true }), intent)).status, "UNAVAILABLE");
        assert.equal(special.calls.lookup + special.calls.graded.length, 0);
    }
    const mixed = harness({ cards: [card({ variants: [variant(), variant("1st Edition Holofoil", "FIRST_EDITION")] })], graded });
    const ambiguous = listing({ title: "Wizards of the Coast Charizard Base Set 4/102 Holo CGC 9 with Guard", isGraded: true, currentPrice: 5000 });
    const separate = await mixed.run(ambiguous, intent);
    assert.equal(separate.exactScope, false); assert.equal(separate.references.length, 2);
    assert.equal(applySoldPriceScreen(ambiguous, separate).screen.status, "UNSCREENED");
});

test("sold-title grade and grader contradictions cannot override the exact target through provider fields", async () => {
    const { run } = harness({ graded: async () => [
        ...three({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", grader: "PSA", grade: "8" }),
        ...three({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 5", grader: "PSA", grade: "8", price: 5 }),
        ...three({ title: "Charizard Base Set 4/102 Unlimited Holo CGC 8", grader: "PSA", grade: "8", price: 5 }),
    ] });
    const result = await run(listing({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", isGraded: true }), intent);
    assert.equal(result.status, "AVAILABLE");
    assert.equal(result.references[0].summary.count, 3); assert.equal(result.references[0].summary.median, 100);
});

test("known foreign sold titles never price an English target even when other provider fields claim an exact match", async () => {
    for (const graded of [false, true]) {
        const rows = three({ title: `リザードン Charizard Base Set 4/102 Japanese Unlimited Holo${graded ? " PSA 8" : ""}`,
            grader: graded ? "PSA" : null, grade: graded ? "8" : null });
        const { run } = harness({ raw: async () => rows, graded: async () => rows });
        const result = await run(listing({ title: `Charizard Base Set 4/102 Unlimited Holo${graded ? " PSA 8" : ""}`, isGraded: graded }), intent);
        assert.equal(result.status, "UNAVAILABLE"); assert.equal(result.references.length, 0);
    }
});

test("missing or conflicting certified grades and special labels do not borrow requested grades", async () => {
    for (const subject of [
        listing({ isGraded: true }),
        listing({ isGraded: true, title: "Charizard Base Set 4/102 Unlimited Holo CGC Pristine 10" }),
        listing({ isGraded: true, title: "Charizard Base Set 4/102 Unlimited Holo PSA 8 (OC)" }),
        listing({ isGraded: true, title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", listedAttributes: { grader: "PSA", grade: 9, finish: "HOLO" } }),
    ]) {
        const { run, calls } = harness();
        assert.equal((await run(subject, { ...intent, grader: "PSA", minGrade: 10, maxGrade: 10 })).status, "UNAVAILABLE");
        assert.equal(calls.lookup + calls.raw.length + calls.graded.length, 0);
    }
});

test("unstated editions retain all plausible catalog printings rather than defaulting to Unlimited", async () => {
    const { run, calls } = harness({ cards: [card({ variants: [variant(), variant("1st Edition Holofoil", "FIRST_EDITION")] })],
        raw: async (_id, label) => three({ title: `Charizard Base Set 4/102 ${label.startsWith("1st") ? "1st Edition" : "Unlimited"} Holo NM`, variant: label, price: label.startsWith("1st") ? 1000 : 100 }) });
    const result = await run(listing({ title: "Charizard Base Set 4/102 Holo" }), { ...intent, printing: "FIRST_EDITION" });
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, false);
    assert.deepEqual(result.references.map(reference => [reference.printing, reference.summary.median]), [["UNLIMITED", 100], ["FIRST_EDITION", 1000]]);
    assert.equal(calls.raw.length, 2);
});

test("holo and reverse holo stay separate and an unstated finish cannot silently select either", async () => {
    const options = { cards: [card({ variants: [variant(), variant("Unlimited Reverse Holofoil", "UNLIMITED", "REVERSE_HOLO")] })],
        raw: async (_id: number | string, label: string) => three({ title: `Charizard Base Set 4/102 Unlimited ${label.includes("Reverse") ? "Reverse Holo" : "Holo"} NM`, variant: label }) };
    const unknown = harness(options);
    const result = await unknown.run(listing({ title: "Charizard Base Set 4/102 Unlimited" }), { ...intent, finish: "HOLO" });
    assert.equal(result.exactScope, false); assert.deepEqual(result.references.map(reference => reference.finish), ["HOLO", "REVERSE_HOLO"]);
    const holo = harness(options);
    const exact = await holo.run(listing(), intent);
    assert.equal(exact.exactScope, true); assert.equal(exact.references.length, 1); assert.equal(holo.calls.raw.length, 1);
});

test("split Shadowless catalog labels share source pages while sale titles settle separate printing summaries", async () => {
    const { run, calls } = harness({ cards: [card({ setName: "Base Set Shadowless", variants: [variant("1st Edition Holofoil", "FIRST_EDITION"), variant("Unlimited Holofoil", "SHADOWLESS")] })],
        raw: async (_id, label) => label.startsWith("1st") ? [
            ...three({ title: "Charizard Base Set 4/102 1st Edition Shadowless Holo NM", variant: label, price: 1000 }),
            ...three({ title: "Charizard Base Set 4/102 Shadowless no 1st Edition Holo NM", variant: label, price: 200 }),
        ] : [] });
    const result = await run(listing({ title: "Charizard Base Set 4/102 Holo" }), intent);
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, false);
    assert.deepEqual(result.references.map(reference => [reference.printing, reference.summary.count, reference.summary.median]), [["FIRST_EDITION", 3, 1000], ["SHADOWLESS", 3, 200]]);
    assert.equal(calls.raw.length, 2, "the two source labels must not be fetched again for the second printing");
});

test("a completed Shadowless source page survives another label's deferral as incomplete market context", async () => {
    for (const graded of [false, true]) {
        const firstPage = three({ title: `Charizard Base Set 4/102 1st Edition Shadowless Holo${graded ? " PSA 8" : " NM"}`,
            variant: "1st Edition Holofoil", grader: graded ? "PSA" : null, grade: graded ? "8" : null });
        const fetched = async (_id: number | string, label: string) => {
            if (label === "Unlimited Holofoil") throw new ScreeningPriceBudgetError();
            return firstPage;
        };
        const { run, calls } = harness({ cards: [card({ setName: "Base Set Shadowless", variants: [variant("1st Edition Holofoil", "FIRST_EDITION"), variant("Unlimited Holofoil", "SHADOWLESS")] })],
            raw: fetched, graded: async (id, target) => fetched(id, target.variant) });
        const subject = listing({ title: `Charizard Base Set 4/102 1st Edition Shadowless Holo${graded ? " PSA 8" : ""}`, isGraded: graded });
        const result = await run(subject, intent);
        assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, false);
        assert.equal(result.references.length, 1); assert.equal(result.references[0].summary.count, 3);
        assert.match(result.note, /partial market context/); assert.match(result.note, /Remaining source pages/);
        await run(subject, intent);
        assert.equal(calls.raw.length + calls.graded.length, 2, "a memoized partial market must not request either source page again");
    }
});

test("a sole known catalog choice can establish research scope while intent-only identities remain preliminary", async () => {
    const { run } = harness();
    assert.equal((await run(listing({ title: "Charizard Base Set 4/102" }), intent)).exactScope, true);
    const fallback = await run(listing({ title: "Pokemon card" }), intent);
    assert.equal(fallback.status, "AVAILABLE"); assert.equal(fallback.exactScope, false);
    assert.ok(!("currentPrice" in fallback.references[0]));
});

test("raw sales without condition wording provide separate market context without inventing a condition or grade", async () => {
    const { run, calls } = harness({ raw: async () => [
        ...three({ title: "Charizard Base Set 4/102 Unlimited Holo" }),
        ...three({ title: "Charizard Base Set 4/102 Unlimited Holo LP", price: 50 }),
    ] });
    const result = await run(listing(), intent);
    assert.equal(result.status, "AVAILABLE");
    assert.deepEqual(result.references.map(reference => [reference.condition, reference.summary.grade, reference.summary.median]), [["LIGHTLY_PLAYED", "LIGHTLY_PLAYED", 50], [null, "UNSPECIFIED", 100]]);
    const context = result.references[1];
    assert.equal(context.grader, null); assert.equal(context.grade, null); assert.equal(context.summary.grader, "RAW");
    assert.match(result.note, /market context only/); assert.equal(calls.graded.length, 0);
});

test("name-and-set searches without numbers preserve one or several canonical cards without guessing a number", async () => {
    const noNumber = { ...intent, cardNumber: null };
    const subject = listing({ title: "Charizard Base Set Unlimited Holo" });
    const one = harness({ lookup: async query => { assert.equal(query.cardNumber, ""); return [card()]; } });
    const first = await one.run(subject, noNumber);
    assert.equal(first.status, "AVAILABLE"); assert.equal(first.exactScope, false); assert.equal(first.references[0].cardNumber, "4/102");
    const several = harness({ cards: [card(), card({ id: 2, cardNumber: "5/102" })], raw: async id => three({ title: `Charizard Base Set ${id === 1 ? "4/102" : "5/102"} Unlimited Holo NM`, price: Number(id) * 100 }) });
    const multiple = await several.run(subject, noNumber);
    assert.equal(multiple.status, "AVAILABLE"); assert.equal(multiple.exactScope, false);
    assert.deepEqual(multiple.references.map(reference => [reference.cardNumber, reference.summary.median]), [["4/102", 100], ["5/102", 200]]);
    assert.equal(several.calls.lookup, 1); assert.equal(several.calls.raw.length, 2);
});

test("wrong and ambiguous catalog identities do not trigger sold-price research", async () => {
    for (const cards of [[card({ name: "Charmander" })], [card({ setName: "Base Set 2" })], [card({ cardNumber: "4/130" })], [card(), card({ id: 2 })]]) {
        const { run, calls } = harness({ cards });
        assert.equal((await run(listing(), intent)).status, "UNAVAILABLE");
        assert.equal(calls.raw.length + calls.graded.length, 0);
    }
});

test("fifty listings share canonical catalog and market work without sharing mutable answers or asking prices", async () => {
    const { run, calls } = harness();
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => run(listing({ id: String(index), currentPrice: index * 100, shipping: index }), intent)));
    assert.equal(calls.lookup, 1); assert.equal(calls.raw.length, 1);
    assert.ok(results.every(result => result.status === "AVAILABLE"));
    results[0].references[0].summary.median = 99_999;
    assert.equal(results[1].references[0].summary.median, 100);
    assert.equal((await run(listing(), intent)).references[0].summary.median, 100);
});

test("saved and literal Venusaur name boilerplate shares one catalog research target", async () => {
    const wanted: SearchIntent = { ...intent, cardName: "Venusaur", cardNumber: "15/102", titleWords: ["venusaur"] };
    const forms = [
        ["Venusaur 15/102 Holo Base Set Unlimited Pokemon Light Play", "venusaur light play", false],
        ["Venusaur 15/102 Holo Rare Base Set Unlimited Pokemon 1999 Wizards LP", "venusaur wizards", false],
        ["1999 Pokemon Base Set Venusaur Holo #15/102 PSA 8 NM-MT Unlimited WOTC", "venusaur -mt", true],
        ["Pokemon 1999 Venusaur 15/102 Holo Rare Base Set Unlimited BGS 9 Centering 10", "venusaur centering", true],
        ["Pokemon TCG Venusaur 15/102 Base Set Holo Unlimited English 1999 WOTC SWIRL", "venusaur swirl", false],
        ["Venusaur 15/102 Base Set Holo Rare Unlimited WOTC Pokemon Card MP 1999 Arita", "venusaur arita", false],
        ["1999 Pokémon Base Set Unlimited Venusaur Holo 15/102 PSA 6 EX-MT", "venusaur ex-mt", true],
        ["1999 Pokémon Base Set Unlimited Venusaur Holo 15/102 PSA 5 EX", "venusaur ex", true],
        ["Pokémon TCG Venusaur Base Set Holo Rare 15/102 1999 Pokemon Game PSA 6 English", "venusaur game", true],
        ["1999 Wizards Pokémon TCG Venusaur Holo Rare Card 15/102 Unlimited Base Set", "wizards venusaur", false],
    ] as const;
    const queries: unknown[] = [];
    const { run, calls } = harness({ lookup: async query => { queries.push(query); return [card({ name: "Venusaur", cardNumber: "015/102" })]; },
        raw: async () => three({ title: "Venusaur 15/102 Base Set Unlimited Holo NM Wizards" }),
        graded: async (_id, target) => three({ title: `Venusaur 15/102 Base Set Unlimited Holo ${target.grader} ${target.grade} NM-MT`, grader: target.grader, grade: target.grade }),
    });
    const results = await Promise.all(forms.map(([title, name, isGraded], index) => run(listing({ id: String(index), title, isGraded,
        screen: { status: "UNSCREENED", reason: "Saved literal claim", card: { name, set: "Base Set", cardNumber: "15/102", printing: "UNLIMITED", printingLabel: null }, bestCase: null, assumed: null } }), wanted)));
    assert.ok(results.every(result => result.status === "AVAILABLE" && result.exactScope));
    assert.equal(calls.lookup, 1);
    assert.deepEqual(queries, [{ name: "Venusaur", set: "Base Set", cardNumber: "15/102" }]);
    assert.equal(calls.raw.length, 1);
    assert.equal(calls.graded.length, 4, "each real exact grade remains a separate market; duplicate PSA 6 rows reuse it");
});

test("canonical names do not bypass set, number or conflicting saved-card claims", async () => {
    const subjects = [
        listing({ title: "Charizard Base Set 2 4/130 Unlimited Holo Wizards", screen: { status: "UNSCREENED", reason: null, card: { name: "Charizard", set: "Base Set", cardNumber: "4/102", printing: "UNLIMITED", printingLabel: null }, bestCase: null, assumed: null } }),
        listing({ title: "Charizard Base Set 5/102 Unlimited Holo Wizards", screen: { status: "UNSCREENED", reason: null, card: { name: "Charizard", set: "Base Set", cardNumber: "4/102", printing: "UNLIMITED", printingLabel: null }, bestCase: null, assumed: null } }),
        listing({ title: "Dark Charizard Team Rocket 4/82 Unlimited Holo", screen: { status: "UNSCREENED", reason: null, card: { name: "Charizard", set: "Team Rocket", cardNumber: "4/82", printing: "UNLIMITED", printingLabel: null }, bestCase: null, assumed: null } }),
    ];
    for (const subject of subjects) {
        const { run, calls } = harness();
        const result = await run(subject, intent);
        assert.equal(result.status, "UNAVAILABLE"); assert.equal(result.exactScope, false);
        assert.equal(calls.lookup + calls.raw.length + calls.graded.length, 0);
    }
});

test("scoped catalog matching preserves modern printed forms and a post-grade EX descriptor", async () => {
    const name = "Charizard ex", set = "Scarlet & Violet 151", number = "199/165";
    const wanted: SearchIntent = { ...intent, cardName: name, sets: [set], cardNumber: number };
    const queries: unknown[] = [];
    const { run, calls } = harness({ lookup: async query => { queries.push(query); return [card({ name, setName: set, cardNumber: number }), card({ id: 2, name: "Charizard", setName: set, cardNumber: number })]; },
        graded: async () => three({ title: `${name} ${set} ${number} Unlimited Holo PSA 5 EX`, grader: "PSA", grade: "5" }),
    });
    const subject = listing({ title: `${name} ${set} ${number} Unlimited Holo PSA 5 EX`, isGraded: true,
        screen: { status: "UNSCREENED", reason: null, card: { name, set, cardNumber: number, printing: "UNLIMITED", printingLabel: null }, bestCase: null, assumed: null } });
    const result = await run(subject, wanted);
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, true);
    assert.equal(result.references[0].name, name); assert.equal(result.references[0].summary.count, 3);
    assert.deepEqual(queries, [{ name, set, cardNumber: number }]); assert.equal(calls.graded.length, 1);
});

test("canonical catalog descriptors survive final sold-screen matching without dropping owners or printed forms", async () => {
    for (const target of [
        { name: "Snorlax", catalogName: "Snorlax Holofoil", set: "Jungle", number: "11/64", wrongName: "Dark Snorlax" },
        { name: "Leafeon V", catalogName: "Leafeon V (Alternate Full Art)", set: "Evolving Skies", number: "167/203", wrongName: "Leafeon VMAX" },
        { name: "Blaine's Arcanine", catalogName: "Blaine’s Arcanine", set: "Gym Challenge", number: "1/132", wrongName: "Arcanine" },
    ]) {
        const wanted = { ...intent, cardName: target.name, sets: [target.set], cardNumber: target.number };
        const subject = listing({ title: `${target.name} ${target.set} ${target.number} Unlimited Holo PSA 8`, isGraded: true });
        const { run, calls } = harness({ cards: [card({ name: target.catalogName, setName: target.set, cardNumber: target.number })],
            graded: async () => [
                ...three({ title: `${target.name} ${target.set} ${target.number} Unlimited Holo PSA 8`, grader: "PSA", grade: "8" }),
                ...three({ title: `${target.wrongName} ${target.set} ${target.number} Unlimited Holo PSA 8`, grader: "PSA", grade: "8", price: 1000 }),
            ] });
        const result = await run(subject, wanted);
        assert.equal(result.status, "AVAILABLE", target.name); assert.equal(result.exactScope, true, target.name);
        assert.equal(result.references[0].summary.count, 3, target.name); assert.equal(result.references[0].summary.median, 100, target.name);
        assert.equal(calls.graded.length, 1, target.name);
        const wrongCatalog = harness({ cards: [card({ name: target.wrongName, setName: target.set, cardNumber: target.number })] });
        assert.equal((await wrongCatalog.run(subject, wanted)).status, "UNAVAILABLE", target.name);
        assert.equal(wrongCatalog.calls.graded.length, 0, target.name);
    }
});

test("unknown residual words and lookalike name forms never trigger fallback catalog loops", async () => {
    for (const name of ["Dark Charizard", "Charizard ex", "Charizard VMAX", "Charizard curious variant"]) {
        const { run, calls } = harness();
        const result = await run(listing({ title: `${name} Base Set 4/102 Unlimited Holo` }), intent);
        assert.equal(result.status, "UNAVAILABLE", name);
        assert.equal(calls.lookup, 1); assert.equal(calls.raw.length + calls.graded.length, 0);
    }
    const { run, calls } = harness({ cards: [card({ name: "Nidoran♂", setName: "Jungle", cardNumber: "57/64" })] });
    const subject = listing({ title: "Nidoran Female Jungle 57/64 Unlimited Holo",
        screen: { status: "UNSCREENED", reason: null, card: { name: "Nidoran♀", set: "Jungle", cardNumber: "57/64", printing: "UNLIMITED", printingLabel: null }, bestCase: null, assumed: null } });
    const result = await run(subject, { ...intent, cardName: "Nidoran♀", sets: ["Jungle"], cardNumber: "57/64" });
    assert.equal(result.status, "UNAVAILABLE"); assert.equal(calls.raw.length, 0);
});

test("bounded price exhaustion defers missing markets while retaining accepted sparse or complete facts", async () => {
    const { run, calls } = harness({ cards: [card({ variants: [variant(), variant("1st Edition Holofoil", "FIRST_EDITION")] })], raw: async (_id, label) => {
        if (label.startsWith("1st")) throw new ScreeningPriceBudgetError();
        return three();
    } });
    const subject = listing({ title: "Charizard Base Set 4/102 Holo" });
    const result = await run(subject, intent);
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, false); assert.equal(result.references.length, 1);
    assert.equal(result.references[0].summary.count, 3);
    assert.match(result.note, /partial market context/);
    await run(subject, intent);
    assert.equal(calls.lookup, 1); assert.equal(calls.raw.length, 2, "a later row cannot repurchase a failed market within this search");
});

test("partial slab references survive budget or provider deferral without becoming an exact exclusion scope", async () => {
    for (const failure of [new ScreeningPriceBudgetError(), new Error("Price service unavailable")]) {
        const { run, calls } = harness({ cards: [card({ variants: [variant(), variant("1st Edition Holofoil", "FIRST_EDITION")] })], graded: async (_id, target) => {
            if (target.variant.startsWith("1st")) throw failure;
            return three({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", grader: "PSA", grade: "8" });
        } });
        const subject = listing({ title: "Charizard Base Set 4/102 Holo PSA 8", isGraded: true });
        const result = await run(subject, intent);
        assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, false);
        assert.equal(result.references.length, 1); assert.equal(result.references[0].summary.count, 3);
        await run(subject, intent); assert.equal(calls.graded.length, 2);
    }
});

test("missing markets stay deferred while a partial matched sale remains usable context", async () => {
    const absent = harness({ lookup: async () => { throw new ScreeningPriceBudgetError(); } });
    assert.equal((await absent.run(listing(), intent)).status, "DEFERRED");
    const failed = harness({ raw: async () => { throw new Error("Provider unavailable"); } });
    assert.equal((await failed.run(listing(), intent)).status, "UNAVAILABLE");
    const sparse = harness({ cards: [card({ variants: [variant(), variant("1st Edition Holofoil", "FIRST_EDITION")] })], raw: async (_id, label) => {
        if (label.startsWith("1st")) throw new ScreeningPriceBudgetError();
        return [sale()];
    } });
    const result = await sparse.run(listing({ title: "Charizard Base Set 4/102 Holo" }), intent);
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, false); assert.equal(result.references[0].summary.count, 1);
});

test("sparse sales remain observations and graded evidence uses an explicit older fallback window", async () => {
    const sparse = harness({ raw: async () => [sale({ price: 80 }), sale({ price: 100 })] });
    const raw = await sparse.run(listing(), intent);
    assert.equal(raw.status, "AVAILABLE"); assert.equal(raw.references[0].summary.count, 2); assert.equal(raw.references[0].summary.median, 90);
    const slab = harness({ graded: async () => three({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", grader: "PSA", grade: "8", sold_at: new Date(NOW - 100 * DAY).toISOString() }) });
    const old = await slab.run(listing({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", isGraded: true }), intent);
    assert.equal(old.status, "AVAILABLE"); assert.equal(old.references[0].summary.windowDays, 180);
});

test("sparse slab pages recover applicable sales without mixing grade, finish, printing or unconfirmed amounts", async () => {
    const slab = (extra: Partial<Comp> = {}) => sale({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", grader: "PSA", grade: "8", ...extra });
    const first = [slab({ price: 90 }), slab({ price: 100 })];
    const { run, calls } = harness({ page: async (_id, target) => {
        assert.equal(target.grader, "PSA"); assert.equal(target.grade, "8"); assert.equal(target.variant, "Unlimited Holofoil");
        if (!target.cursor) return { sales: [
            slab({ title: "Charizard Base Set 4/102 1st Edition Holo PSA 8", variant: "1st Edition Holofoil" }),
            slab({ title: "Charizard Base Set 4/102 Unlimited Reverse Holo PSA 8", variant: "Unlimited Reverse Holofoil" }),
            slab({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 9", grade: "9" }),
            slab({ currency: "EUR" }), slab({ sale_type: null }), slab({ attribution: "shared" }),
        ], nextCursor: "second" };
        assert.equal(target.cursor, "second");
        return { sales: [...first, { ...first[0], id: String(first[0].id) }, slab({ price: 110 }), slab({ price: 120 })], nextCursor: "third" };
    } });
    const subject = listing({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", isGraded: true });
    const result = await run(subject, intent);
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, true);
    assert.equal(result.references.length, 1); assert.equal(result.references[0].summary.count, 4);
    assert.equal(result.references[0].summary.median, 105);
    assert.deepEqual(calls.pages.map(([, target]) => target.cursor), [undefined, "second"]);
    await run({ ...subject, id: "another-row" }, intent);
    assert.equal(calls.pages.length, 2, "another listing reuses the recovered exact market");
    assert.equal(calls.raw.length + calls.graded.length, 0);
});

test("one exact recent slab sale stops pagination and admits photo verification without creating a Deal", async () => {
    const { run, calls } = harness({ page: async (_id, target) => {
        assert.equal(target.cursor, undefined, "enough matched sales must not request the next cursor");
        return { sales: [sale({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", grader: "PSA", grade: "8" })], nextCursor: "unused" };
    } });
    const subject = listing({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", isGraded: true, currentPrice: 10, images: ["front", "back"] });
    const evidence = await run(subject, intent);
    assert.equal(evidence.status, "AVAILABLE"); assert.equal(evidence.references[0].summary.count, 1);
    assert.equal(evidence.references[0].summary.confidence, "LOW");
    const screened = applySoldPriceScreen(subject, evidence, { targets: { minProfit: 0, minRoi: 0 } });
    assert.equal(canAutoAnalyze(screened), true);
    assert.equal(resultGroup(screened, null), "candidates");
    assert.equal(calls.pages.length, 1);
});

test("one raw sale per condition stays in separate buckets without buying another page", async () => {
    const nearMint = sale(), lightlyPlayed = sale({ title: "Charizard Base Set 4/102 Unlimited Holo LP" });
    const { run, calls } = harness({ page: async (_id, target) => {
        assert.equal(target.cursor, undefined);
        return { sales: [nearMint, lightlyPlayed, sale({ title: "Charizard Base Set 4/102 Unlimited Holo" })], nextCursor: "next" };
    } });
    const result = await run(listing(), intent);
    assert.equal(result.status, "AVAILABLE");
    assert.deepEqual(result.references.map(reference => [reference.condition, reference.summary.count]), [["NEAR_MINT", 1], ["LIGHTLY_PLAYED", 1], [null, 1]]);
    assert.equal(calls.pages.length, 1);
});

test("outlier rejection still protects sparse-page prices", async () => {
    const { run, calls } = harness({ page: async (_id, target) => {
        assert.equal(target.cursor, undefined);
        return { sales: [sale({ price: 90 }), sale({ price: 100 }), sale({ price: 10000 })], nextCursor: "next" };
    } });
    const result = await run(listing(), intent);
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.references[0].summary.count, 2);
    assert.equal(result.references[0].summary.high, 100); assert.equal(calls.pages.length, 1);
});

test("an exhausted four-page market stays deferred and never repurchases its sparse evidence", async () => {
    let cursor = 0;
    const observation = sale({ sale_type: null });
    const { run, calls } = harness({ page: async () => ({ sales: [observation, sale({ sale_type: null })], nextCursor: String(++cursor) }) });
    const result = await run(listing(), intent);
    assert.equal(result.status, "DEFERRED"); assert.equal(result.exactScope, false);
    assert.equal(result.references.length, 0); assert.equal(calls.pages.length, 4);
    await run(listing(), intent); assert.equal(calls.pages.length, 4);
});

test("a repeating provider cursor cannot buy the same page again", async () => {
    const observation = sale({ sale_type: null });
    const { run, calls } = harness({ page: async () => ({ sales: [observation], nextCursor: "repeated" }) });
    const result = await run(listing(), intent);
    assert.equal(result.status, "UNAVAILABLE"); assert.equal(result.exactScope, false);
    assert.equal(result.references.length, 0); assert.equal(calls.pages.length, 2);
});

test("a request cap between pages retains sparse observations and prevents another row from retrying", async () => {
    const { run, calls } = harness({ page: async (_id, target) => {
        if (target.cursor) throw new ScreeningPriceBudgetError();
        return { sales: [sale({ sale_type: null })], nextCursor: "deferred" };
    } });
    const result = await run(listing(), intent);
    assert.equal(result.status, "DEFERRED"); assert.equal(result.references.length, 0);
    await run(listing(), intent); assert.equal(calls.pages.length, 2);
});

test("cancellation after a recovered page prevents dispatch of another cursor", async () => {
    const controller = new AbortController();
    const { run, calls } = harness({ signal: controller.signal, page: async (_id, target) => {
        if (target.cursor) controller.abort(new Error("stop recovered page"));
        return { sales: [sale({ sale_type: null })], nextCursor: target.cursor ? "never" : "second" };
    } });
    await assert.rejects(run(listing(), intent), /stop recovered page/);
    assert.equal(calls.pages.length, 2);
});

test("storage failures propagate rather than authorizing replacement research", async () => {
    for (const point of ["lookup", "raw"]) {
        const fail = async () => { throw new StorageUnavailableError("Saved evidence cannot be read"); };
        const { run, calls } = harness(point === "lookup" ? { lookup: fail } : { raw: fail });
        await assert.rejects(run(listing(), intent), StorageUnavailableError);
        assert.equal(calls.graded.length, 0);
    }
});

test("the total price allowance defers research while invalid accounting fails closed", async () => {
    const limited = harness({ raw: async () => { throw new PriceResearchBudgetError("Search request allowance reached", "LIMIT"); } });
    assert.equal((await limited.run(listing(), intent)).status, "DEFERRED");
    await limited.run(listing(), intent);
    assert.equal(limited.calls.raw.length, 1, "a deferred market is not repurchased in the same search");
    for (const reason of ["SCOPE", "ACCOUNT", "STORAGE", "STATE", "LOCK"] as const) {
        const failure = new PriceResearchBudgetError("Research accounting unavailable", reason);
        const subject = harness({ raw: async () => { throw failure; } });
        await assert.rejects(subject.run(listing(), intent), error => error === failure);
    }
});

test("cancellation propagates and prevents a later market from starting", async () => {
    const controller = new AbortController();
    let release!: (sales: Comp[]) => void, started!: () => void;
    const gate = new Promise<Comp[]>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const { run, calls } = harness({ signal: controller.signal, cards: [card({ variants: [variant(), variant("1st Edition Holofoil", "FIRST_EDITION")] })], raw: async () => { started(); return gate; } });
    const pending = run(listing({ title: "Charizard Base Set 4/102 Holo" }), intent);
    await entered; controller.abort(new Error("stop sold screening")); release(three());
    await assert.rejects(pending, /stop sold screening/); assert.equal(calls.raw.length, 1);
});

test("unknown catalog variants and conflicting listing metadata cannot establish exact scope", async () => {
    const unknown = harness({ cards: [card({ variants: [variant(), variant("Unspecified Holofoil", "UNKNOWN")] })] });
    assert.equal((await unknown.run(listing({ title: "Charizard Base Set 4/102 Holo" }), intent)).exactScope, false);
    const conflicting = harness();
    const subject = listing({ screen: { status: "UNSCREENED", reason: null, bestCase: null, assumed: null, card: { name: "Charmander", set: "Base Set", cardNumber: "46/102", printing: "UNLIMITED", printingLabel: null } } });
    assert.equal((await conflicting.run(subject, intent)).status, "UNAVAILABLE"); assert.equal(conflicting.calls.lookup, 0);
});
