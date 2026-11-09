import { test } from "node:test";
import assert from "node:assert/strict";
import { variantFor } from "../../server/pricing/raw-prices.ts";
import { toCardRecord } from "../../server/pricing/pkmnprices.ts";

const providerEntry = (variant, currency = "USD") => ({
    currency,
    variant,
    condition: "Near Mint",
    market_price: 12.5,
});

const cardFrom = (setName, prices) => toCardRecord({
    id: 1,
    name: "Pikachu",
    number: "019",
    total_set_number: "159",
    set: { name: setName },
    tcg_player_id: 123,
    prices,
});

test("native card details retain USD variant labels without importing market quotes", () => {
    const card = cardFrom("Crown Zenith", [providerEntry("Holofoil"), providerEntry("Holofoil"), providerEntry("Normal", "EUR")]);

    assert.deepEqual(card, { source: "pkmnprices", id: 1, name: "Pikachu", cardNumber: "019/159", setName: "Crown Zenith",
        variants: [{ name: "Holofoil", printing: "UNLIMITED", finish: "HOLO" }] });
});

test("an unlabeled variant cannot select a printing for a card that has editions", () => {
    const card = cardFrom("Neo Genesis", [providerEntry("Holofoil")]);

    assert.equal(variantFor(card, { set: "Neo Genesis", printing: "UNLIMITED", finish: "HOLO" }).variant, undefined);
});

test("a stated finish selects its own catalog variant while an unresolved finish stays ambiguous", () => {
    const card = cardFrom("Crown Zenith", [providerEntry("Holofoil"), providerEntry("Reverse Holofoil")]);
    const identity = { set: "Crown Zenith", printing: "UNLIMITED" };

    assert.equal(variantFor(card, { ...identity, finish: "REVERSE_HOLO" }).variant?.name, "Reverse Holofoil");
    assert.equal(variantFor(card, { ...identity, finish: "NOT_STATED" }).variant, undefined);
});
