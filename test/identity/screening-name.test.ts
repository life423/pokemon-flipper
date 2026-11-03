import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveScreeningName, screeningNameKey } from "../../server/identity/screening-name.ts";

test("recognized seller metadata reconciles saved and literal card names without a species dictionary", () => {
    const cases = [
        ["Venusaur Light Play", "venusaur light play"],
        ["1999 Wizards Venusaur", "wizards venusaur"],
        ["Venusaur SWIRL", "venusaur swirl"],
        ["Venusaur Arita", "venusaur arita"],
        ["1999 Pokemon Unlimited Set #15/102 Venusaur", "set venusaur"],
        ["Pokemon Game Venusaur", "venusaur game"],
        ["Venusaur PSA 8 NM-MT", "venusaur -mt"],
        ["Venusaur PSA 6 EX-MT", "venusaur ex-mt"],
        ["Venusaur PSA 5 EX", "venusaur ex"],
        ["Venusaur BGS 9 Centering 10", "venusaur centering"],
    ];
    for (const [title, polluted] of cases) {
        assert.equal(resolveScreeningName({ title, claims: ["Venusaur", polluted], candidate: "Venusaur" }), "Venusaur", title);
    }
});

test("printed forms, owners and distinct species do not collapse into an intent name", () => {
    for (const name of ["Dark Charizard", "Light Arcanine", "Alolan Ninetales", "Galarian Sirfetch'd", "Mega Charizard X",
        "M Charizard EX", "Radiant Charizard", "Charizard ex", "Charizard EX", "Charizard V", "Charizard VMAX", "Charizard VSTAR",
        "Charizard LV.X", "Misty's Gyarados", "Rocket's Mewtwo", "Blaine's Charizard", "Unown A", "Unown B"]) {
        assert.equal(resolveScreeningName({ title: name, claims: [name], candidate: "Charizard" }), name, name);
    }
    assert.equal(resolveScreeningName({ title: "Mewtwo", claims: ["Mewtwo"], candidate: "Mew" }), "Mewtwo");
    assert.equal(resolveScreeningName({ title: "Dark Charizard", claims: ["Charizard", "Dark Charizard"], candidate: "Charizard" }), null);
    assert.equal(resolveScreeningName({ title: "Charizard ex", claims: ["Charizard", "Charizard ex"], candidate: "Charizard" }), null);
});

test("post-grade EX descriptors cannot erase the card's own ex from a clean cached claim", () => {
    assert.equal(resolveScreeningName({ title: "Charizard ex PSA 5 EX", claims: ["Charizard ex", "charizard ex ex"], candidate: "Charizard ex" }), "Charizard ex");
    assert.equal(resolveScreeningName({ title: "Charizard ex PSA 8 NM-MT", claims: ["Charizard ex", "charizard ex -mt"], candidate: "Charizard ex" }), "Charizard ex");
    assert.equal(resolveScreeningName({ title: "Venusaur ex", claims: ["Venusaur ex"], candidate: "Venusaur" }), "Venusaur ex");
});

test("unknown residuals and conflicting claims remain unresolved instead of borrowing the search", () => {
    assert.equal(resolveScreeningName({ title: "Venusaur Curious Variant", claims: ["Venusaur curious variant"], candidate: "Venusaur" }), "Venusaur curious variant");
    assert.equal(resolveScreeningName({ title: "Venusaur Curious Variant", claims: ["Venusaur", "Venusaur curious variant"], candidate: "Venusaur" }), null);
    assert.equal(resolveScreeningName({ title: "Old Pokemon Card", claims: [], candidate: "Venusaur" }), null);
});

test("name comparison retains gender and printed symbols while normalizing punctuation and accents", () => {
    assert.notEqual(screeningNameKey("Nidoran♀"), screeningNameKey("Nidoran♂"));
    assert.equal(screeningNameKey("Nidoran♀"), screeningNameKey("Nidoran female"));
    assert.notEqual(screeningNameKey("Charizard ☆"), screeningNameKey("Charizard"));
    assert.notEqual(screeningNameKey("Charizard δ"), screeningNameKey("Charizard"));
    assert.equal(screeningNameKey("Flabébé"), screeningNameKey("Flabebe"));
    assert.equal(screeningNameKey("Unown [A]"), screeningNameKey("Unown A"));
    assert.equal(resolveScreeningName({ title: "Nidoran", claims: ["Nidoran♀", "Nidoran♂"] }), null);
});
