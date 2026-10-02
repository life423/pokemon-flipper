import { test } from "node:test";
import assert from "node:assert/strict";
import { prescreen } from "../../server/deals/prescreen.ts";
import { sellerCondition } from "../../shared/conditions.ts";
import { toCardRecord } from "../../server/pricing/pkmnprices.ts";

const NOW = Date.parse("2026-09-30T00:00:00Z");

const usd = (variant, condition, price) => ({ currency: "USD", variant, condition, market_price: price });

const LUGIA = toCardRecord({
    id: 28158,
    tcg_player_id: 86903,
    name: "Lugia",
    number: "009",
    total_set_number: "111",
    set: { id: 607, name: "Neo Genesis" },
    prices: [
        usd("1st Edition Holofoil", "Moderately Played", 1134.84),
        usd("Unlimited Holofoil", "Near Mint", 531.39),
        usd("Unlimited Holofoil", "Lightly Played", 446.25),
        usd("Unlimited Holofoil", "Moderately Played", 315),
    ],
});

const sale = (price, soldAt, title) => ({
    price,
    sold_at: soldAt,
    variant: "Unlimited Holofoil",
    title,
    grader: "PSA",
    grade: "9",
    grade_qualifier: null,
    attribution: "exact",
    listing_url: null,
});

// Real Unlimited PSA 9 sales; median $2,600.
const PSA9 = [
    sale(2325, "2026-07-26", "2000 POKEMON NEO GENESIS #9 LUGIA-HOLO PSA 9 #9 [eBay]"),
    sale(2600, "2026-07-17", "Pokemon 2000 Lugia 9/111 Holo Neo Genesis PSA 9 9/111 [eBay]"),
    sale(3350, "2026-07-12", "2000 Pokemon LUGIA #9/111 Neo Genesis Unlimited Cosmos Holo Rare English PSA 9 9/111 [eBay]"),
    sale(3200, "2026-06-21", "2000 POKEMON NEO GENESIS #9 LUGIA-HOLO PSA 9 #9 [eBay]"),
    sale(2499.99, "2026-06-03", "Pokemon TCG Lugia Neo Genesis Holo Rare Card 9/111 PSA 9 Mint 9/111 [eBay]"),
];

const deps = {
    lookupCards: async () => [LUGIA],
    fetchComps: async (recordId, { grader, grade }) => (grader === "PSA" && String(grade) === "9" ? PSA9 : []),
    now: NOW,
};

const rawLugia = (overrides = {}) => ({
    title: "Lugia 9/111 Neo Genesis Holo Rare Unlimited WOTC",
    aspects: { Set: "Neo Genesis", "Card Number": "9/111", "Card Name": "Lugia", Language: "English" },
    price: 300,
    shipping: 5,
    isGraded: false,
    cardCondition: "Near mint or better",
    ...overrides,
});

test("eBay's card conditions map to price conditions, and none means assume the best", () => {
    assert.equal(sellerCondition("Near mint or better"), "NEAR_MINT");
    assert.equal(sellerCondition("Lightly played (Excellent)"), "LIGHTLY_PLAYED");
    assert.equal(sellerCondition("Moderately played (Very good)"), "MODERATELY_PLAYED");
    assert.equal(sellerCondition("Heavily played (Poor)"), "HEAVILY_PLAYED");
    assert.equal(sellerCondition(null), "NEAR_MINT");
});

test("a raw card priced well under its best case is a candidate", async () => {
    const result = await prescreen(rawLugia(), deps);

    assert.equal(result.status, "CANDIDATE");
    assert.equal(result.card.printingLabel, "Unlimited");
    assert.equal(result.assumed, "Near Mint, grading 9 at best");
    assert.ok(result.bestCase.maxBid > 300);
});

test("a raw card that can't clear the targets even at its best is dropped", async () => {
    const result = await prescreen(rawLugia({ price: 2000 }), deps);

    assert.equal(result.status, "DROPPED");
    assert.ok(result.bestCase.maxBid < 2000);
});

test("the seller's own condition call caps the best case", async () => {
    // Lightly played: best grade 6, which has no sales, so only the raw
    // Lightly Played price counts.
    const result = await prescreen(rawLugia({ cardCondition: "Lightly played (Excellent)" }), deps);

    assert.equal(result.status, "DROPPED");
    assert.equal(result.bestCase.label, "Resell raw");
    assert.equal(result.bestCase.maxBid, 271);
});

test("a card number in the title stands in when the item details skip it", async () => {
    const aspects = { Set: "Neo Genesis", "Card Name": "Lugia", Language: "English" };
    const result = await prescreen(rawLugia({ aspects }), deps);

    assert.equal(result.status, "CANDIDATE");
});

test("a listing with no card number anywhere can't be screened", async () => {
    const aspects = { Set: "Neo Genesis", "Card Name": "Lugia", Language: "English" };
    const result = await prescreen(rawLugia({ title: "Lugia Neo Genesis Holo WOTC", aspects }), deps);

    assert.equal(result.status, "UNSCREENED");
});

test("a slab is screened at its listed grader and grade", async () => {
    const slab = rawLugia({
        title: "Lugia Neo Genesis Unlimited Holo #9 PSA 9",
        isGraded: true,
        cardCondition: null,
        aspects: {
            Set: "Neo Genesis",
            "Card Number": "9/111",
            "Card Name": "Lugia",
            Language: "English",
            "Professional Grader": "Professional Sports Authenticator (PSA)",
            Grade: "9",
        },
    });

    const cheap = await prescreen({ ...slab, price: 1500 }, deps);
    const dear = await prescreen({ ...slab, price: 2000 }, deps);

    assert.equal(cheap.status, "CANDIDATE");
    assert.equal(cheap.assumed, "PSA 9, as listed");
    assert.equal(dear.status, "DROPPED");
});

test("a 1st Edition claim is screened at 1st Edition prices", async () => {
    // The only 1st Edition price is Moderately Played, so a Near Mint
    // claim has nothing at or below it until Moderately Played.
    const result = await prescreen(rawLugia({ title: "Lugia 9/111 Neo Genesis 1st Edition Holo", price: 500 }), deps);

    assert.equal(result.card.printingLabel, "1st Edition");
    assert.equal(result.status, "CANDIDATE");
});

test("a Buy It Now priced far below the card in any condition is junk; an auction isn't", async () => {
    // Lugia's cheapest raw price here is $315 (Moderately Played).
    const junk = await prescreen(rawLugia({ price: 5, buyingOption: "FIXED_PRICE" }), deps);
    const auction = await prescreen(rawLugia({ price: 5, buyingOption: "AUCTION" }), deps);
    const cheapButReal = await prescreen(rawLugia({ price: 100, buyingOption: "FIXED_PRICE" }), deps);

    assert.equal(junk.junk, true);
    assert.match(junk.reason, /far below the \$315\.00/);
    assert.equal(auction.junk, undefined);
    assert.equal(cheapButReal.junk, undefined);
});

test("a 1st Edition claim in the item details only is priced as what the main photo shows", async () => {
    // A real listing: "Features: 1st Edition" on an Unlimited Lugia.
    const aspects = { Set: "Neo Genesis", "Card Number": "9/111", "Card Name": "Lugia", Language: "English", Features: "1st Edition" };
    const claimed = await prescreen(rawLugia({ title: "Pokemon TCG Lugia 9/111 Neo Genesis Holo Rare English 2000 90HP", aspects, price: 250 }), deps);
    const seen = await prescreen(
        rawLugia({
            title: "Pokemon TCG Lugia 9/111 Neo Genesis Holo Rare English 2000 90HP",
            aspects,
            price: 250,
            photoMarks: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT" },
        }),
        deps
    );

    assert.equal(claimed.card.printingLabel, "1st Edition");
    assert.equal(seen.card.printingLabel, "Unlimited");
});
