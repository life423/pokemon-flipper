import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeComps, gradedPricesFor, compsForGrade } from "../../server/pricing/graded-comps.ts";
import { identifyCard } from "../../server/identity/card-identity.ts";
import { toCardRecord } from "../../server/pricing/pkmnprices.ts";
import { matchesSoldTarget, readSoldTitleClaims } from "../../server/pricing/sold-comps.ts";

const NOW = Date.parse("2026-09-30T00:00:00Z");

const comp = (price, soldAt, variant, title, overrides = {}) => ({
    price,
    sold_at: soldAt,
    variant,
    title,
    grader: "PSA",
    grade: "9",
    grade_qualifier: null,
    attribution: "exact",
    // These matching-rule fixtures explicitly model confirmed transactions.
    // Legacy records without a known sale type are covered by the evidence audit.
    sale_type: "fixed_price",
    listing_url: null,
    ...overrides,
});

// Real PSA 9 sales of Neo Genesis Lugia from pkmnprices, both printings.
const LUGIA_PSA9 = [
    comp(16000, "2026-09-09", "1st Edition Holofoil", "2000 POKEMON NEO GENESIS 1ST EDITION 9/111 LUGIA HOLO PSA 9 #9 [eBay]"),
    comp(12700, "2026-08-12", "1st Edition Holofoil", "2000 Pokemon Neo Genesis 1st Edition #9 Lugia Holo PSA 9 MINT [eBay]"),
    comp(2325, "2026-07-26", "Unlimited Holofoil", "2000 POKEMON NEO GENESIS #9 LUGIA-HOLO PSA 9 #9 [eBay]"),
    comp(2600, "2026-07-17", "Unlimited Holofoil", "Pokemon 2000 Lugia 9/111 Holo Neo Genesis PSA 9 9/111 [eBay]"),
    comp(3350, "2026-07-12", "Unlimited Holofoil", "2000 Pokemon LUGIA #9/111 Neo Genesis Unlimited Cosmos Holo Rare English PSA 9 9/111 [eBay]"),
    comp(14636.67, "2026-07-04", "1st Edition Holofoil", "2000 POKEMON NEO GENESIS 1ST EDITION #9 LUGIA-HOLO PSA 9 #9 [eBay]"),
    comp(3200, "2026-06-21", "Unlimited Holofoil", "2000 POKEMON NEO GENESIS #9 LUGIA-HOLO PSA 9 #9 [eBay]"),
    comp(13100, "2026-06-08", "1st Edition Holofoil", "2000 Pokemon Neo Genesis 1st Edition #9 Lugia Holo PSA 9 MINT [eBay]"),
    comp(2499.99, "2026-06-03", "Unlimited Holofoil", "Pokémon TCG Lugia Neo Genesis Holo Rare Card 9/111 PSA 9 Mint 9/111 [eBay]"),
    comp(8744.25, "2026-05-31", "1st Edition Holofoil", "LUGIA POKEMON #9 2000 NEO GENESIS 1ST EDITION HOLO ENGLISH PSA 9 [eBay]"),
];

// Real PSA 8 sales of Shadowless Charizard. The first two are labeled
// 1st Edition, but their titles say Shadowless and they sold at
// Shadowless prices: the label is wrong, and the title decides.
const SHADOWLESS_PSA8 = [
    comp(5750, "2026-09-01", "1st Edition Holofoil", "Shadowless Base Set Charizard PSA 8 [eBay]", { grade: "8" }),
    comp(7200, "2026-08-20", "1st Edition Holofoil", "1999 POKEMON BASE SET SHADOWLESS #4 CHARIZARD HOLO PSA 8 (LIMITED EDITION GUARD) #4 [eBay]", { grade: "8" }),
    comp(5500, "2026-08-10", "Unlimited Holofoil", "1999 Charizard 4/102 Base (Shadowless) Holo PSA 8 NM MT #596 4/102 [eBay]", { grade: "8" }),
    comp(6000, "2026-08-02", "Unlimited Holofoil", "1999 Pokemon Charizard Holo Shadowless PSA 8 [eBay]", { grade: "8" }),
];

const criteria = (printing, setName, grade) => ({ printing, setName, grader: "PSA", grade, now: NOW });

test("only valid past sales within the inclusive 180-day window enter pricing", () => {
    const title = "2000 Lugia Neo Genesis Unlimited Holo PSA 9 9/111";
    const dates = [NOW, NOW - 180 * 86400000, NOW - 180 * 86400000 - 1, NOW + 1].map((time) => new Date(time).toISOString());
    const summary = summarizeComps([...dates, "invalid"].map((date) => comp(2500, date, "Unlimited Holofoil", title)), criteria("UNLIMITED", "Neo Genesis", 9));
    assert.equal(summary.count, 2);
    assert.deepEqual(summary.dropped, { "older than 180 days": 1, "future sale date": 1, "invalid sale date": 1 });
});

test("failed or partial comp checks never claim every retained sale was AI-checked", () => {
    const passing = LUGIA_PSA9.filter((sale) => sale.variant === "Unlimited Holofoil");
    const target = criteria("UNLIMITED", "Neo Genesis", 9);
    const rules = summarizeComps(passing, target);
    const failed = summarizeComps(passing, target, new Map());
    const partial = summarizeComps(passing, target, new Map([[passing[0], { keep: true, reason: null, note: "fits" }]]));
    assert.equal(failed.checkedByAI, undefined); assert.equal(partial.checkedByAI, undefined);
    assert.equal(failed.median, rules.median); assert.equal(partial.count, rules.count);
    const complete = summarizeComps(passing, target, new Map(passing.map((sale) => [sale, { keep: true, reason: null, note: "fits" }])));
    assert.equal(complete.checkedByAI, true);
});

test("Lugia PSA 9: Unlimited and 1st Edition sales are priced apart", () => {
    const unlimited = summarizeComps(LUGIA_PSA9, criteria("UNLIMITED", "Neo Genesis", 9));
    const firstEdition = summarizeComps(LUGIA_PSA9, criteria("FIRST_EDITION", "Neo Genesis", 9));

    assert.equal(unlimited.count, 5);
    assert.equal(unlimited.median, 2600);
    assert.equal(unlimited.confidence, "HIGH");
    assert.deepEqual(unlimited.dropped, { "labeled as another printing": 5 });

    assert.equal(firstEdition.count, 5);
    assert.equal(firstEdition.median, 13100);
});

test("Shadowless without 1st Edition: sales titled Shadowless count, whatever their label", () => {
    const shadowless = summarizeComps(
        SHADOWLESS_PSA8,
        criteria("SHADOWLESS", "Base Set (Shadowless)", 8)
    );

    assert.equal(shadowless.count, 4);
    assert.equal(shadowless.median, 5875);
    assert.equal(shadowless.confidence, "MEDIUM");
});

test("1st Edition Shadowless: Shadowless-titled sales never price it, even labeled 1st Edition", () => {
    const firstEdition = summarizeComps(
        SHADOWLESS_PSA8,
        criteria("FIRST_EDITION", "Base Set (Shadowless)", 8)
    );

    assert.equal(firstEdition.count, 0);
    assert.equal(firstEdition.dropped["title names another printing"], 4);
});

test("1st Edition Shadowless: sales titled 1st Edition count, and titles naming neither are dropped", () => {
    const comps = [
        comp(38000, "2026-09-01", "Unlimited Holofoil", "1999 Base Set 1st Edition Shadowless Charizard PSA 8", { grade: "8" }),
        comp(41480, "2026-09-09", "1st Edition Holofoil", "1999 POKEMON GAME 1ST EDITION #4 CHARIZARD-HOLO PSA 8", { grade: "8" }),
        comp(6000, "2026-09-05", "1st Edition Holofoil", "1999 Base Set Charizard Holo PSA 8", { grade: "8" }),
    ];

    const firstEdition = summarizeComps(comps, criteria("FIRST_EDITION", "Base Set (Shadowless)", 8));

    assert.equal(firstEdition.count, 2);
    assert.equal(firstEdition.median, 39740);
    assert.equal(firstEdition.dropped["title doesn't say which Shadowless printing"], 1);
});

test("a sale far from the others is dropped as an outlier", () => {
    const title = "2000 POKEMON NEO GENESIS #9 LUGIA-HOLO PSA 8 #9";
    const comps = [1000, 1100, 1200, 1300, 5422].map((price) =>
        comp(price, "2026-09-01", "Unlimited Holofoil", title, { grade: "8" })
    );

    const summary = summarizeComps(comps, criteria("UNLIMITED", "Neo Genesis", 8));

    assert.equal(summary.count, 4);
    assert.equal(summary.high, 1300);
    assert.deepEqual(summary.dropped, { "price far from the other sales": 1 });
});

test("shared, unrecorded, qualified, special-tier, and old sales are all dropped", () => {
    const title = "2000 POKEMON NEO GENESIS #9 LUGIA-HOLO PSA 9 #9";
    const comps = [
        comp(2500, "2026-09-01", "Unlimited Holofoil", title, { attribution: "shared" }),
        comp(2500, "2026-09-01", null, title, { attribution: "unknown" }),
        comp(1500, "2026-09-01", "Unlimited Holofoil", `${title} (OC)`),
        comp(9000, "2026-09-01", "Unlimited Holofoil", title, { grade_qualifier: "Pristine" }),
        comp(2500, "2025-01-01", "Unlimited Holofoil", title),
        comp(2500, "2026-09-01", "Unlimited Holofoil", title, { grade: "8" }),
    ];

    const summary = summarizeComps(comps, criteria("UNLIMITED", "Neo Genesis", 9));

    assert.equal(summary.count, 0);
    assert.deepEqual(summary.dropped, {
        "shared with another card": 2,
        "qualified or special grade": 2,
        "older than 180 days": 1,
        "different grade": 1,
    });
});

// Fetching comps for a whole grade range

const usd = (variant, condition, price) => ({ currency: "USD", variant, condition, market_price: price });

const LUGIA = toCardRecord({
    id: 28158,
    name: "Lugia",
    number: "009",
    total_set_number: "111",
    set: { id: 607, name: "Neo Genesis" },
    prices: [
        usd("1st Edition Holofoil", "Moderately Played", 1134.84),
        usd("Unlimited Holofoil", "Near Mint", 531.39),
    ],
});

const SHADOWLESS_CHARIZARD = toCardRecord({
    id: 19092,
    name: "Charizard",
    number: "004",
    total_set_number: "102",
    set: { id: 525, name: "Base Set (Shadowless)" },
    prices: [
        usd("1st Edition Holofoil", "Moderately Played", 10000),
        usd("Unlimited Holofoil", "Lightly Played", 2257.87),
    ],
});

const photos = (name, number, marks) => ({
    printingMarks: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT", evidence: [], ...marks },
    printedName: name,
    printedNumber: number,
});

test("graded prices: one lookup per grade, for this card's own printing label", async () => {
    const { identity, card } = await identifyCard(
        {
            title: "2000 Pokemon Neo Genesis Lugia 9/111 Holo Rare Unlimited",
            aspects: { Set: "Neo Genesis", "Card Number": "9/111", "Card Name": "Lugia", Language: "English" },
        },
        photos("Lugia", "9/111"),
        { lookupCards: async () => [LUGIA] }
    );

    const calls = [];

    const pricing = await gradedPricesFor(card, identity, { low: 8, likely: 9, high: 9 }, {
        now: NOW,
        fetchComps: async (recordId, options) => {
            const { stopWhen, ...market } = options;
            assert.equal(typeof stopWhen, "function", "exact eligibility controls sparse-market pagination");
            calls.push({ recordId, ...market });
            return options.grade === 9 ? LUGIA_PSA9 : [];
        },
    });

    assert.deepEqual(calls, [
        { recordId: 28158, grader: "PSA", grade: 8, variant: "Unlimited Holofoil" },
        { recordId: 28158, grader: "PSA", grade: 9, variant: "Unlimited Holofoil" },
    ]);
    assert.equal(pricing.status, "PRICED");
    assert.equal(pricing.byGrade[0].count, 0);
    assert.equal(pricing.byGrade[1].median, 2600);
});

test("graded prices for Shadowless read sales under both labels, and the titles decide", async () => {
    const { identity, card } = await identifyCard(
        {
            title: "1999 Pokemon Base Set Shadowless Charizard 4/102 Holo",
            aspects: { Set: "Base Set", "Card Number": "4/102", "Card Name": "Charizard", Language: "English" },
        },
        photos("Charizard", "4/102", { artBoxShadow: "ABSENT" }),
        { lookupCards: async () => [SHADOWLESS_CHARIZARD] }
    );

    const calls = [];

    const pricing = await gradedPricesFor(card, identity, { low: 8, likely: 8, high: 8 }, {
        now: NOW,
        fetchComps: async (recordId, options) => {
            calls.push(options.variant);
            return SHADOWLESS_PSA8.filter((sale) => sale.variant === options.variant);
        },
    });

    assert.deepEqual(calls, ["1st Edition Holofoil", "Unlimited Holofoil"]);
    assert.equal(pricing.printingLabel, "Shadowless (no 1st Edition)");
    assert.equal(pricing.byGrade[0].count, 4);
    assert.equal(pricing.byGrade[0].median, 5875);
});

test("graded prices never start for a card that isn't identified", async () => {
    let called = false;

    const pricing = await gradedPricesFor(
        { source: "pkmnprices", variants: [] },
        { status: "NEEDS_REVIEW", printing: "UNKNOWN" },
        { low: 7, likely: 8, high: 9 },
        {
            fetchComps: async () => {
                called = true;
                return [];
            },
        }
    );

    assert.equal(pricing.status, "PRICE_UNAVAILABLE");
    assert.equal(called, false);
});

test("a slab's exact grade is priced alone: 8.5 sales never mix with 8s", async () => {
    const { identity, card } = await identifyCard(
        {
            title: "2000 Pokemon Neo Genesis Lugia 9/111 Holo Rare Unlimited",
            aspects: { Set: "Neo Genesis", "Card Number": "9/111", "Card Name": "Lugia", Language: "English" },
        },
        photos("Lugia", "9/111"),
        { lookupCards: async () => [LUGIA] }
    );

    const title = "2000 POKEMON NEO GENESIS #9 LUGIA-HOLO";
    const sales = [
        comp(1900, "2026-09-01", "Unlimited Holofoil", `${title} PSA 8.5`, { grade: "8.5" }),
        comp(2000, "2026-09-02", "Unlimited Holofoil", `${title} PSA 8.5`, { grade: "8.5" }),
        comp(1250, "2026-09-03", "Unlimited Holofoil", `${title} PSA 8`, { grade: "8" }),
    ];

    const pricing = await compsForGrade(card, identity, {
        grader: "PSA",
        grade: "8.5",
        now: NOW,
        fetchComps: async () => sales,
    });

    assert.equal(pricing.status, "PRICED");
    assert.equal(pricing.summary.count, 2);
    assert.equal(pricing.summary.median, 1950);
    assert.equal(pricing.summary.dropped["different grade"], 1);
});

// Real PSA 6 sales filed under the 2021 Celebrations Classic Collection
// Charizard: a 1999 original, the Ultra Premium Collection metal card,
// a 2026 30th Celebration copy, and one real Classic Collection sale.
const CLASSIC_PSA6 = [
    comp(504, "2026-09-24", "Holofoil", "1999 Pokemon Game #4 Charizard - Holo PSA 6 EX-MT", { grade: "6" }),
    comp(149.99, "2026-09-02", "Holofoil", "2021 POKEMON CELEBRATIONS ULTRA-PREM COLL #4 CHARIZARD PSA 6 #4 [eBay]", { grade: "6" }),
    comp(60, "2026-08-16", "Holofoil", "CHARIZARD Gold Metal Pokemon Card Celebrations Promo UPC 4/102 PSA 6 4", { grade: "6" }),
    comp(80, "2026-08-10", "Holofoil", "Charizard 4/102 30th Anniversary Classic Collection PSA 6", { grade: "6" }),
    comp(91.51, "2026-09-04", "Holofoil", "2021 POKEMON CELEBRATIONS CLASSIC COLL #4 CHARIZARD-HOLO PSA 6 #4 [eBay]", { grade: "6" }),
];

test("Classic Collection comps drop the 1999 original, metal cards, and the other reprint", () => {
    const summary = summarizeComps(CLASSIC_PSA6, criteria("UNLIMITED", "Celebrations: Classic Collection", 6));

    assert.equal(summary.count, 1);
    assert.equal(summary.median, 91.51);
    assert.deepEqual(summary.dropped, { "title names another product": 2, "metal or novelty card": 2 });
});

test("the AI checks only sales that passed the rules, and its drops are counted", async () => {
    const { identity, card } = await identifyCard(
        {
            title: "2000 Pokemon Neo Genesis Lugia 9/111 Holo Rare Unlimited",
            aspects: { Set: "Neo Genesis", "Card Number": "9/111", "Card Name": "Lugia", Language: "English" },
        },
        photos("Lugia", "9/111"),
        { lookupCards: async () => [LUGIA] }
    );

    const title = "2000 POKEMON NEO GENESIS #9 LUGIA-HOLO";
    const sales = [
        comp(1900, "2026-09-01", "Unlimited Holofoil", `${title} PSA 8`, { grade: "8" }),
        comp(2000, "2026-09-02", "Unlimited Holofoil", `${title} PSA 8 SIGNED BY ARTIST`, { grade: "8" }),
        comp(1950, "2026-09-03", "Unlimited Holofoil", `${title} PSA 8`, { grade: "8" }),
        // Fails the rules (another grade), so the AI never sees it.
        comp(1250, "2026-09-04", "Unlimited Holofoil", `${title} PSA 7`, { grade: "7" }),
    ];
    let seen = [];

    const pricing = await compsForGrade(card, identity, {
        grader: "PSA",
        grade: "8",
        now: NOW,
        fetchComps: async () => sales,
        checkComps: async (comps, target) => {
            seen = comps.map((c) => c.title);
            assert.equal(target.printingLabel, "Unlimited");
            assert.equal(target.grade, "8");
            return new Map(comps.map((c) => [c, /SIGNED/.test(c.title) ? { keep: false, reason: "SIGNED_OR_ALTERED", note: "signed" } : { keep: true, reason: null, note: "fits" }]));
        },
    });

    assert.equal(seen.length, 3);
    assert.equal(pricing.summary.count, 2);
    assert.equal(pricing.summary.median, 1925);
    assert.equal(pricing.summary.dropped["AI: signed or altered"], 1);
    assert.equal(pricing.summary.checkedByAI, true);
});

test("ordinary CGC descriptions do not exclude otherwise matching exact-grade comps", () => {
    const target = { ...criteria("UNLIMITED", "Neo Genesis", "8.5"), grader: "CGC" };
    const ordinary = comp(200, "2026-09-01", "Unlimited Holofoil", "Lugia Neo Genesis CGC 8.5 NM/Mint+", {
        grader: "CGC", grade: "8.5", grade_qualifier: "NM/MINT+",
    });
    const summary = summarizeComps([ordinary], target);
    assert.equal(summary.count, 1);
    assert.equal(summary.median, 200);

    for (const grade_qualifier of ["OC", "Pristine", "NM/MINT+ OC", "Authentic Altered", "unknown"]) {
        const rejected = summarizeComps([{ ...ordinary, grade_qualifier }], target);
        assert.equal(rejected.count, 0, grade_qualifier);
        assert.equal(rejected.dropped["qualified or special grade"], 1);
    }
    assert.equal(summarizeComps([{ ...ordinary, grade: "8" }], target).count, 0);
    assert.equal(summarizeComps([{ ...ordinary, grader: "PSA" }], target).count, 0);
    assert.equal(summarizeComps([{ ...ordinary, title: `${ordinary.title} (OC)` }], target).count, 0);
});

test("final slab and grading prices reject another card before median and outlier selection", async () => {
    const { identity, card } = await identifyCard({ title: "Lugia Neo Genesis 9/111 Holo Unlimited", aspects: { Set: "Neo Genesis", "Card Number": "9/111", "Card Name": "Lugia", Language: "English" } }, photos("Lugia", "9/111"), { lookupCards: async () => [LUGIA] });
    for (const [matchingPrice, wrongPrice] of [[200, 20], [100, 1000]]) {
        const exact = comp(matchingPrice, "2026-09-01", "Unlimited Holofoil", "Lugia Neo Genesis 9/111 Holo PSA 9 [eBay]");
        const wrong = ["2026-09-02", "2026-09-03"].map(date => comp(wrongPrice, date, "Unlimited Holofoil", "Typhlosion Neo Genesis 18/111 Holo PSA 9"));
        const qualified = comp(9999, "2026-09-04", "Unlimited Holofoil", "Lugia Neo Genesis 9/111 Cosmos Holo PSA 9 (OC) [eBay]");
        for (const route of ["slab", "grading"]) {
            let checks = 0;
            const options = { now: NOW, grader: "PSA", fetchComps: async (_id, { stopWhen }) => {
                assert.equal(stopWhen(wrong), false, "wrong attributed titles cannot end sparse research");
                assert.equal(stopWhen([...wrong, exact]), true, "one exact confirmed sale is enough");
                assert.equal(stopWhen([qualified]), false, "metadata normalization cannot hide a grade qualifier");
                return [...wrong, exact, qualified];
            }, checkComps: async passing => {
                checks++;
                assert.deepEqual(passing, [exact], "cached checks only see exact eligible sales");
                return new Map();
            } };
            const result = route === "slab" ? await compsForGrade(card, identity, { ...options, grade: 9 })
                : await gradedPricesFor(card, identity, { low: 9, likely: 9, high: 9 }, options);
            const summary = route === "slab" ? result.summary : result.byGrade[0];
            assert.equal(result.status, "PRICED");
            assert.equal(summary.count, 1); assert.equal(summary.median, matchingPrice);
            assert.equal(summary.confidence, "LOW"); assert.equal(summary.windowDays, 90);
            assert.equal(summary.dropped["title does not match target card or grade"], 2);
            assert.equal(summary.dropped["qualified or special grade"], 1);
            assert.equal(summary.dropped["price far from the other sales"], undefined);
            assert.equal(summary.sales[0].title, exact.title, "source provenance remains in the saved title");
            assert.equal(checks, 1, "pagination cannot purchase repeated comp checks");
        }
    }
});

test("known Team Rocket context retains all accepted Dark Machamp sales without borrowing Returns or unanchored Rocket", async () => {
    const record = toCardRecord({ id: 26332, name: "Dark Machamp", number: "010", total_set_number: "82", set: { id: 1, name: "Team Rocket" },
        prices: [usd("1st Edition Holofoil", "Near Mint", 100)] });
    const { identity, card } = await identifyCard({ title: "Dark Machamp Team Rocket 10/82 1st Edition Holo PSA 8", aspects: { Set: "Team Rocket", "Card Number": "10/82", "Card Name": "Dark Machamp", Language: "English" } },
        photos("Dark Machamp", "10/82", { firstEditionStamp: "VISIBLE" }), { lookupCards: async () => [record] });
    const sales = [
        comp(248, "2026-10-27", "1st Edition Holofoil", "2000 POKEMON ROCKET 1ST EDITION #10 DARK MACHAMP-HOLO PSA 8", { grade: "8", currency: "USD" }),
        comp(249.9, "2026-10-26", "1st Edition Holofoil", "Pokémon Team Rocket Dark Machamp 1st Edition Holo PSA 8 10/82 Holo Rare", { grade: "8", currency: "USD" }),
        comp(248.5, "2026-09-30", "1st Edition Holofoil", "DARK MACHAMP 2000 POKEMON TEAM ROCKET 1ST EDITION 10/82 HOLO RARE PSA 8 Q3963-5", { grade: "8", currency: "USD" }),
    ];
    const pricing = await compsForGrade(card, identity, { grader: "PSA", grade: 8, now: Date.parse("2026-11-04T18:00:00Z"), fetchComps: async () => sales });
    assert.equal(pricing.summary.count, 3); assert.equal(pricing.summary.median, 248.5);
    assert.equal(pricing.summary.windowDays, 90); assert.equal(pricing.summary.confidence, "MEDIUM");
    assert.deepEqual(pricing.summary.sales.map(sale => sale.title), sales.map(sale => sale.title));
    const target = { name: "Dark Machamp", setName: "Team Rocket", cardNumber: "10/82" };
    for (const title of ["Pokemon Rocket Returns Dark Machamp 10/82 PSA 8", "Pokemon EX Team Rocket Returns Dark Machamp 10/82 PSA 8", "Pokemon Rocket Dark Machamp 11/82 PSA 8", "Pokemon Rocket Machamp 10/82 PSA 8"]) {
        assert.equal(matchesSoldTarget({ ...sales[0], title }, target, "PSA", "8"), false, title);
    }
    assert.equal(readSoldTitleClaims(sales[0].title).set, null, "unknown context does not invent Team Rocket");
    assert.equal(readSoldTitleClaims(sales[0].title, ["Fossil"]).set, null, "another target release cannot authorize the alias");
    assert.equal(readSoldTitleClaims("Rocket Dark Machamp 10/82 PSA 8", ["Team Rocket"]).set, null, "Rocket alone stays unanchored");
});

test("a known Galarian Gallery target accepts its Crown Zenith family without borrowing another numbered card or release", async () => {
    const record = toCardRecord({ id: 23767, name: "Mewtwo VSTAR", number: "GG44", total_set_number: "GG70", set: { id: 1, name: "SWSH: Crown Zenith: Galarian Gallery" },
        prices: [usd("Holofoil", "Near Mint", 100)] });
    const card = { source: record.source, name: record.name, cardNumber: record.cardNumber, records: [record],
        variants: record.variants.map(variant => ({ ...variant, recordId: record.id, setName: record.setName })) };
    const identity = { status: "IDENTIFIED", name: "Mewtwo VSTAR", set: record.setName, cardNumber: "GG44/GG70", printing: "UNLIMITED", finish: "HOLO", language: "English", reasons: [], evidence: null };
    const exact = comp(235, "2026-11-03", "Holofoil", "The Pokémon Company Mewtwo VSTAR GG44/GG70 Crown Zenith Full Art Holo PSA 9", { currency: "USD" });
    const wrong = ["Mewtwo VSTAR GG45/GG70 Crown Zenith Holo PSA 9", "Mewtwo VSTAR TG44/TG70 Crown Zenith Holo PSA 9", "Mewtwo VSTAR GG44/GG70 Lost Origin Holo PSA 9"]
        .map(title => ({ ...exact, title, price: 999 }));
    const pricing = await compsForGrade(card, identity, { grader: "PSA", grade: 9, now: Date.parse("2026-11-04T18:00:00Z"), fetchComps: async () => [exact, ...wrong] });
    assert.equal(pricing.status, "PRICED"); assert.equal(pricing.summary.count, 1);
    assert.equal(pricing.summary.median, 235); assert.equal(pricing.summary.confidence, "LOW");
    assert.equal(pricing.summary.dropped["title does not match target card or grade"], 3);
});

test("USD graded prices prefer even one current sale over older prices, including a falling market", async () => {
    const { identity, card } = await identifyCard({ title: "Lugia Neo Genesis 9/111 Holo Unlimited", aspects: { Set: "Neo Genesis", "Card Number": "9/111", "Card Name": "Lugia", Language: "English" } }, photos("Lugia", "9/111"), { lookupCards: async () => [LUGIA] });
    for (const [recent, count, oldPrice, oldCount] of [[100, 1, 1000, 2], [1000, 2, 2000, 4], [4000, 3, 2000, 4]]) {
        const older = Array.from({ length: oldCount }, (_, i) => comp(oldPrice, `2026-05-0${i + 1}`, "Unlimited Holofoil", "Lugia Neo Genesis PSA 9"));
        const current = Array.from({ length: count }, (_, i) => comp(recent, `2026-09-0${i + 1}`, "Unlimited Holofoil", "Lugia Neo Genesis PSA 9", { currency: "USD" }));
        const result = await compsForGrade(card, identity, { grader: "PSA", grade: 9, now: NOW, fetchComps: async () => [...older, ...current, comp(1, "2026-09-05", "Unlimited Holofoil", "Lugia Neo Genesis PSA 9", { currency: "EUR" }), comp(900, "2026-09-05", "Unlimited Reverse Holofoil", "Lugia Neo Genesis PSA 9")] });
        assert.equal(result.summary.windowDays, 90);
        assert.equal(result.summary.count, count);
        assert.equal(result.summary.median, recent);
        assert.equal(result.summary.confidence, count < 3 ? "LOW" : "MEDIUM");
        assert.equal(result.summary.dropped["older than 90 days"], oldCount);
        assert.equal(result.summary.dropped["price far from the other sales"], undefined, "older prices cannot discard the sole current sale as an outlier");
        assert.equal(result.summary.dropped["not a USD sale"], 1);
        assert.equal(result.summary.dropped["another finish"], 1);
    }
    const sparse = await compsForGrade(card, identity, { grader: "PSA", grade: 9, now: NOW, fetchComps: async () => [comp(2000, "2026-05-01", "Unlimited Holofoil", "Lugia Neo Genesis PSA 9")] });
    assert.equal(sparse.summary.windowDays, 180);
    assert.equal(sparse.summary.median, 2000);
});

test("wrong-grade, contradictory-title, unconfirmed and cached-rejected current sales cannot suppress the labeled older fallback", async () => {
    const { identity, card } = await identifyCard({ title: "Lugia Neo Genesis 9/111 Holo Unlimited", aspects: { Set: "Neo Genesis", "Card Number": "9/111", "Card Name": "Lugia", Language: "English" } }, photos("Lugia", "9/111"), { lookupCards: async () => [LUGIA] });
    const title = "Lugia Neo Genesis PSA 9", older = comp(1000, "2026-05-01", "Unlimited Holofoil", title);
    const contradictory = {
        "wrong card title": "Typhlosion Neo Genesis 18/111 PSA 9",
        "wrong number title": "Lugia Neo Genesis 8/111 PSA 9",
        "wrong set title": "Lugia Neo Revelation 9/111 PSA 9",
        "wrong grader title": "Lugia Neo Genesis 9/111 CGC 9",
        "wrong grade title": "Lugia Neo Genesis 9/111 PSA 8",
        "foreign title": "Japanese Lugia Neo Genesis 9/111 PSA 9",
        "lot title": "Lugia Neo Genesis 9/111 PSA 9 lot of 3 cards",
    };
    for (const kind of ["wrong grade", "unconfirmed", "cached rejection", ...Object.keys(contradictory)]) {
        const current = comp(100, "2026-09-01", "Unlimited Holofoil", title,
            kind === "wrong grade" ? { grade: "8" } : kind === "unconfirmed" ? { sale_type: null }
                : contradictory[kind] ? { title: contradictory[kind] } : {});
        const result = await compsForGrade(card, identity, { grader: "PSA", grade: 9, now: NOW,
            fetchComps: async () => [older, current],
            checkComps: async passing => new Map(passing.map(sale => [sale, kind === "cached rejection" && sale === current
                ? { keep: false, reason: "ANOTHER_CARD", note: "Saved comp verdict rejects this sale." }
                : { keep: true, reason: null, note: "Saved comp verdict accepts this sale." }])) });
        assert.equal(result.status, "PRICED", kind);
        assert.equal(result.summary.windowDays, 180, kind);
        assert.equal(result.summary.count, 1, kind);
        assert.equal(result.summary.median, 1000, kind);
        assert.equal(result.summary.confidence, "LOW", kind);
        if (contradictory[kind]) assert.equal(result.summary.dropped["title does not match target card or grade"], 1, kind);
    }
});
