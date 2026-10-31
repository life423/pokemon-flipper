import { test } from "node:test";
import assert from "node:assert/strict";
import { finishClaim } from "../../shared/finish.ts";
import { finishIn } from "../../shared/search-criteria.ts";
import { finishOfVariant, identifyCard, sameCardNumber } from "../../server/identity/card-identity.ts";
import { toCardRecord } from "../../server/pricing/pkmnprices.ts";

test("letter suffixes keep exact card selection and tolerate leading zeros", () => {
    assert.equal(sameCardNumber("095A/147", "95a/147"), true);
    assert.equal(sameCardNumber("95a/147", "95b/147"), false);
    assert.equal(sameCardNumber("95a/147", "A95/147"), false);
    assert.equal(sameCardNumber("H28/H32", "H28/147"), false);
});

test("seller, label, search and provider finish aliases agree without confusing reverse and holo", () => {
    for (const [text, expected] of [["Reverse Foil", "REVERSE_HOLO"], ["PRIMEAPE-REVERSE FOIL", "REVERSE_HOLO"], ["Reverse Holofoil", "REVERSE_HOLO"], ["Rev. Holo", "REVERSE_HOLO"], ["HOLOFOIL", "HOLO"], ["NON_HOLO", "NON_HOLO"], ["Nonfoil", "NON_HOLO"], ["normal", "NON_HOLO"]] as const) {
        assert.equal(finishClaim(text), expected, text);
        assert.equal(finishIn(text), expected, text);
        assert.equal(finishOfVariant(text), expected, text);
    }
    assert.equal(finishClaim("holo or reverse foil"), "CONFLICTING");
    assert.equal(finishIn("holo or reverse foil"), null);
    assert.equal(finishClaim("Aquapolis"), "NOT_STATED");
});

test("a readable slab label supplies missing finish while seller contradictions remain unresolved", async () => {
    const card = toCardRecord({ id: 1, name: "Primeape", number: "029", total_set_number: "147", set: { name: "Aquapolis" }, prices: [{ currency: "USD", variant: "Reverse Holofoil", condition: "Near Mint", market_price: 10 }] });
    const photos = { printedName: "Primeape", printedNumber: "29/147", slab: { present: true, labelText: "2003 POKEMON AQUAPOLIS PRIMEAPE REVERSE FOIL #29", grader: "PSA", grade: "7", gradeQualifier: null, certNumber: "1", caseCondition: "INTACT", authenticity: "NONE_SEEN", concerns: [] } };
    const listing = { title: "Primeape Aquapolis PSA 7", aspects: { Set: "Aquapolis", "Card Name": "Primeape", "Card Number": "29" } };
    const result = await identifyCard(listing, photos, { lookupCards: async () => [card] });
    assert.equal(result.identity.status, "IDENTIFIED");
    assert.equal(result.identity.finish, "REVERSE_HOLO");
    const conflict = await identifyCard({ ...listing, title: "Primeape Aquapolis Holo PSA 7" }, photos, { lookupCards: async () => [card] });
    assert.equal(conflict.identity.finish, "CONFLICTING");
});
