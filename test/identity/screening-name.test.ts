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

test("source-observed rarity and edition descriptors reconcile literal names without erasing Unown letters", () => {
    for (const [title, claim, candidate] of [
        ["POKEMON UNGRADED SNORLAX 11/64 HOLO R JUNGLE NM", "snorlax r", "Snorlax"],
        ["1999 Pokemon Jungle Snorlax Holo #11/64 Rare Unlimited Edition TCG Card Ungraded", "snorlax edition", "Snorlax"],
        ["Gym Challenge Blaine's Arcanine 1/132 Damaged Pokemon Unlimited Holo R Tcg Card", "blaine's arcanine r", "Blaine's Arcanine"],
        ["Blaine's Arcanine 1/132 Gym Challenge PARTIAL SWIRL Holo Rare Pokemon Card DMG", "blaine's arcanine partial", "Blaine's Arcanine"],
        ["Unown R 61/75 Holo R Neo Discovery", "unown r r", "Unown R"],
    ]) assert.equal(resolveScreeningName({ title, claims: [claim], candidate }), candidate, title);
    for (const [title, claim] of [
        ["Unown R Neo Discovery 61/75 Holo", "Unown R"],
        ["Snorlax R Jungle 11/64", "Snorlax R"],
        ["Snorlax Edition Jungle 11/64", "Snorlax Edition"],
        ["Blaine's Arcanine Partial Gym Challenge 1/132", "Blaine's Arcanine Partial"],
    ]) assert.equal(resolveScreeningName({ title, claims: [claim], candidate: "Snorlax" }), claim, title);
});

test("canonical catalog descriptors reconcile claims while owner and form conflicts remain distinct", () => {
    assert.equal(resolveScreeningName({ title: "Snorlax 11/64 Holofoil Jungle", claims: ["Snorlax", "snorlax holofoil"], candidate: "Snorlax" }), "Snorlax");
    assert.equal(resolveScreeningName({ title: "Leafeon V Evolving Skies 167/203", claims: ["Leafeon V", "Leafeon V (Alternate Full Art)"], candidate: "Leafeon V" }), "Leafeon V");
    assert.equal(resolveScreeningName({ title: "Blaine’s Arcanine Gym Challenge", claims: ["Blaine’s Arcanine", "Blaine's Arcanine"], candidate: "Blaine's Arcanine" }), "Blaine's Arcanine");
    assert.equal(resolveScreeningName({ title: "Blaine's Arcanine Gym Challenge", claims: ["Arcanine", "Blaine's Arcanine"], candidate: "Arcanine" }), null);
    assert.equal(resolveScreeningName({ title: "Leafeon VMAX", claims: ["Leafeon VMAX", "Leafeon V"], candidate: "Leafeon V" }), null);
});

test("exact publisher phrases and graded artist suffixes clean real sold-title residue conservatively", () => {
    for (const [title, claim] of [
        ["The Pokémon Company Fossil Dragonite Holo 4/62 Unlimited 1999 English PSA 8", "company dragonite"],
        ["Dragonite 4/62 Holo Rare Unlimited Fossil 1999 PSA 8 NM-MT Himeno", "dragonite -mt himeno"],
        ["Dragonite Fossil 4/62 Unlimited Holo PSA 8 Kagemaru Himeno", "dragonite kagemaru himeno"],
    ]) assert.equal(resolveScreeningName({ title, claims: ["Dragonite", claim], candidate: "Dragonite" }), "Dragonite", title);
    for (const [title, claim] of [
        ["Company Dragonite Fossil PSA 8", "Company Dragonite"],
        ["Dragonite Fossil 4/62 Himeno", "Dragonite Himeno"],
        ["Dragonite Fossil PSA Himeno", "Dragonite Himeno"],
        ["Himeno's Dragonite Fossil PSA 8", "Himeno's Dragonite"],
        ["Pokemon Company's Dragonite Fossil PSA 8", "Pokemon Company's Dragonite"],
        ["Dark Dragonite Fossil 4/62 PSA 8 Himeno", "Dark Dragonite"],
    ]) assert.equal(resolveScreeningName({ title, claims: [claim], candidate: "Dragonite" }), claim, title);
});

test("source-observed art and release descriptors reconcile old saved claims without borrowing an intent species", () => {
    for (const [title, claims, candidate] of [
        ["Rayquaza V Evolving Skies 194/203 Full Art Holo PSA 9", ["Rayquaza V", "rayquaza v full art"], "Rayquaza V"],
        ["Pokemon SWSH Evolving Skies Rayquaza V 194/203 PSA 9", ["Rayquaza V", "swsh rayquaza v"], "Rayquaza V"],
        ["Giratina V Lost Origin 186/196 SWSH11 Alt Full Art PSA 9", ["Giratina V", "giratina v swsh11 alt full art"], "Giratina V"],
    ] as const) assert.equal(resolveScreeningName({ title, claims, candidate }), candidate, title);
    for (const [title, claims, candidate] of [
        ["Dark Charizard Evolving Skies 194/203 Full Art", ["Dark Charizard"], "Charizard"],
        ["Rayquaza VMAX Evolving Skies 194/203 Full Art", ["Rayquaza VMAX"], "Rayquaza V"],
        ["Blaine's Arcanine Evolving Skies 194/203 Alt Art", ["Blaine's Arcanine"], "Arcanine"],
        ["Rayquaza V Evolving Skies 194/203 SWSH11", ["SWSH11 Rayquaza V"], "Rayquaza V"],
        ["SWSH Rayquaza V 194/203", ["SWSH Rayquaza V"], "Rayquaza V"],
        ["Rayquaza V Evolving Skies 194/203 Curious Art", ["Rayquaza V Curious Art"], "Rayquaza V"],
    ] as const) assert.notEqual(resolveScreeningName({ title, claims, candidate }), candidate, title);
});
