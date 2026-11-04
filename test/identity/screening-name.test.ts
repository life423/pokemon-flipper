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

test("source-observed accompanying holders reconcile old name fragments without erasing printed names", () => {
    const title = "Charizard Base Set 4/102 CGC 9 with a protective holder";
    assert.equal(resolveScreeningName({ title, claims: ["Charizard", "charizard a protective holder"], candidate: "Charizard" }), "Charizard");
    assert.equal(resolveScreeningName({ title: "Charizard CGC 9 w/ Guard", claims: ["Charizard", "charizard w/ guard"] }), "Charizard");
    assert.equal(resolveScreeningName({ title: "Wizards of the Coast Charizard CGC 9", claims: ["Charizard", "wizards of coast charizard"] }), "Charizard");
    for (const claims of [["Guard Spec.", "guard spec. guard"], ["Guard Spec."]]) {
        assert.equal(resolveScreeningName({ title: "Guard Spec. PSA 9 with Guard", claims, candidate: "Guard Spec." }), "Guard Spec.");
    }
    assert.equal(resolveScreeningName({ title: "Dark Charizard CGC 9 with Guard", claims: ["Charizard", "dark charizard guard"], candidate: "Charizard" }), null);
});

test("name cleanup does not remove unanchored, ungraded or unrelated holder wording", () => {
    for (const [title, claim] of [
        ["Charizard inspired CGC 9 with Guard", "charizard inspired guard"],
        ["Charizard CGC 9 Guard", "charizard guard"],
        ["Charizard with Guard", "charizard guard"],
        ["Charizard CGC with Guard", "charizard guard"],
        ["Charizard CGC 9 with Guard collection", "charizard guard collection"],
        ["Guardians Rising Charizard CGC 9", "guardians rising charizard"],
        ["Guard's Charizard CGC 9 with Guard", "guard's charizard guard"],
    ]) {
        assert.notEqual(resolveScreeningName({ title, claims: [claim], candidate: "Charizard" }), "Charizard", title);
    }
});
