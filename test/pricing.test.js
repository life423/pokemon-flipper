import { test } from "node:test";
import assert from "node:assert/strict";
import { canPrice, rawPricesFor } from "../pricing.js";
import { toCardRecord } from "../pkmnprices.js";
import { fromPokemonPriceTracker } from "../pokemon-price-tracker.js";

const usd = (variant, condition, price) => ({
    currency: "USD",
    variant,
    condition,
    market_price: price,
});

const identified = (overrides = {}) => ({
    status: "IDENTIFIED",
    set: "Neo Genesis",
    cardNumber: "009/111",
    printing: "UNLIMITED",
    finish: "HOLO",
    hasEditions: true,
    ...overrides,
});

const zenith = (prices) =>
    toCardRecord({
        id: 2,
        name: "Charizard VSTAR",
        number: "019",
        total_set_number: "159",
        set: { name: "Crown Zenith" },
        prices,
    });

test("each source is only asked what it can answer", () => {
    assert.equal(canPrice("pkmnpricesComps", ["printing", "grade"]), true);
    assert.equal(canPrice("pkmnpricesRaw", ["printing", "condition"]), true);
    assert.equal(canPrice("pokemonPriceTrackerGraded", ["printing", "grade"]), false);
    assert.equal(canPrice("someOtherSource", ["grade"]), false);
});

test("an unlabeled price is never used for a card that has editions", () => {
    const card = toCardRecord({
        id: 1,
        name: "Lugia",
        number: "9",
        total_set_number: "111",
        set: { name: "Neo Genesis" },
        prices: [usd("Holofoil", "Near Mint", 900)],
    });

    assert.equal(rawPricesFor(card, identified()).status, "PRICE_UNAVAILABLE");
});

test("a card printed once uses its unlabeled price", () => {
    const pricing = rawPricesFor(
        zenith([usd("Holofoil", "Near Mint", 12.5)]),
        identified({ set: "Crown Zenith", cardNumber: "019/159", hasEditions: false })
    );

    assert.equal(pricing.status, "PRICED");
    assert.deepEqual(pricing.prices, [{ condition: "NEAR_MINT", price: 12.5, updatedAt: null }]);
});

test("the stated finish picks between holo and reverse holo", () => {
    const card = zenith([
        usd("Holofoil", "Near Mint", 20),
        usd("Reverse Holofoil", "Near Mint", 8),
    ]);

    const reverse = rawPricesFor(card, identified({ finish: "REVERSE_HOLO", hasEditions: false }));
    const unknown = rawPricesFor(card, identified({ finish: "NOT_STATED", hasEditions: false }));

    assert.deepEqual(reverse.prices.map((p) => p.price), [8]);
    assert.equal(unknown.status, "PRICE_UNAVAILABLE");
});

test("nothing is priced before the card is identified", () => {
    const card = zenith([usd("Holofoil", "Near Mint", 1)]);

    assert.equal(rawPricesFor(card, identified({ status: "NEEDS_REVIEW" })).status, "PRICE_UNAVAILABLE");
    assert.equal(rawPricesFor(null, identified({ printing: "UNKNOWN" })).status, "PRICE_UNAVAILABLE");
});

test("PokemonPriceTracker records are read the same way", () => {
    const card = fromPokemonPriceTracker({
        tcgPlayerId: "86903",
        name: "Lugia",
        setName: "Neo Genesis",
        cardNumber: "009/111",
        prices: {
            variants: {
                "1st Edition Holofoil": { "Moderately Played 1st Edition Holofoil": { price: 1134.85 } },
                "Unlimited Holofoil": { "Near Mint Unlimited Holofoil": { price: 531.39 } },
            },
        },
    });

    assert.deepEqual(rawPricesFor(card, identified()).prices.map((p) => p.price), [531.39]);
});
