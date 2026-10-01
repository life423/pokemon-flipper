import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeComps, gradedPricesFor, compsForGrade } from "../graded-comps.js";
import { identifyCard } from "../card-identity.js";
import { toCardRecord } from "../pkmnprices.js";

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
            calls.push({ recordId, ...options });
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
