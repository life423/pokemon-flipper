import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readTitleByRules } from "../../server/ai/title-reader.ts";

test("literal slab names survive explicit publisher and accompanying holder metadata", t => {
    t.mock.method(globalThis, "fetch", async () => assert.fail("literal name extraction needs no provider"));
    const cases = [
        ["1999 Pokemon Base Set Unlimited Charizard Holo Card 4/102 CGC 9 Mint w/ Guard", "charizard", "Base Set", "4/102", "CGC", "9"],
        ["Wizards of the Coast Pokemon Base Set Unlimited Charizard 4/102 Holo CGC 9 1999", "charizard", "Base Set", "4/102", "CGC", "9"],
        ["Wizards of the Coast Vaporeon Jungle 12/64 Holo PSA 8 with a protective case", "vaporeon", "Jungle", "12/64", "PSA", "8"],
        ["Dark Gyarados Team Rocket 8/82 Holo BGS 8.5 including magnetic holder", "dark gyarados", "Team Rocket", "8/82", "BGS", "8.5"],
        ["Misty's Gyarados Gym Heroes 13/132 Holo CGC 9 includes a sleeve", "misty's gyarados", "Gym Heroes", "13/132", "CGC", "9"],
        ["Guard Spec. Base Set 79/102 PSA 9 with Guard", "guard spec.", "Base Set", "79/102", "PSA", "9"],
    ];
    for (const [title, name, set, number, grader, grade] of cases) {
        const reading = readTitleByRules(title);
        assert.deepEqual([reading.cardName, reading.set, reading.cardNumber, reading.grader, reading.grade], [name, set, number, grader, grade], title);
    }
});

test("literal name extraction retains unknown words, printed forms and missing identity fields", () => {
    for (const title of [
        "Charizard inspired Base Set 4/102 CGC 9 with Guard",
        "Charizard Base Set 4/102 CGC 9 Guard",
        "Charizard Base Set 4/102 with Guard",
        "Charizard Base Set 4/102 CGC with Guard",
        "Charizard Base Set 4/102 CGC 9 with Guard collection",
        "Guardians Rising Charizard CGC 9",
    ]) assert.notEqual(readTitleByRules(title).cardName, "charizard", title);
    assert.equal(readTitleByRules("Dark Charizard Team Rocket 4/82 CGC 9 with Guard").cardName, "dark charizard");
    assert.equal(readTitleByRules("Charizard ex Scarlet & Violet 151 199/165 CGC 9 with Guard").cardName, "charizard ex");
    const noSet = readTitleByRules("1999 Pokemon Unlimited Charizard Rare Holo #4/102 CGC 9");
    assert.equal(noSet.cardName, "charizard"); assert.equal(noSet.set, null);
    assert.equal(readTitleByRules("Wizards of the Coast Charizard CGC 9 with Guard").cardNumber, null);
});

test("name-only cleaning cannot hide junk or change explicit seller grading and release claims", () => {
    for (const title of [
        "Charizard Base Set 4/102 CGC 9 with case only",
        "Charizard Base Set 4/102 CGC 9 with custom card",
        "Charizard Base Set 4/102 CGC 9 no card with Guard",
        "Charizard Base Set 4/102 replica CGC 9 with Guard",
    ]) {
        const reading = readTitleByRules(title);
        assert.equal(reading.kind, "NOT_A_CARD", title); assert.equal(reading.cardName, null, title);
    }
    const release = readTitleByRules("Charizard Celebrations 4/102 CGC 9 with Guard");
    assert.equal(release.set, "Celebrations"); assert.equal(release.grader, "CGC"); assert.equal(release.grade, "9");
});

test("explicit art descriptors and matched Sword and Shield publisher metadata retain literal modern card names", () => {
    for (const [title, name, set, number] of [
        ["PSA 9 Pokemon 2021 Rayquaza V 194/203 Full Art Ultra Rare Evolving Skies", "rayquaza v", "Evolving Skies", "194/203"],
        ["2021 Pokemon SWSH Evolving Skies Rayquaza V #194/203 Full Art Ultra Rare PSA 9", "rayquaza v", "Evolving Skies", "194/203"],
        ["Pokemon Rayquaza V (Alternate Full Art) 194/203 SWSH07:Evolving Skies Holo PSA 9", "rayquaza v", "Evolving Skies", "194/203"],
        ["Rayquaza V Alt/Full Art Holo 194/203 Evolving Skies PSA 9", "rayquaza v", "Evolving Skies", "194/203"],
        ["Pokemon Sword & Shield Giratina V 186/196 Lost Origin Alternate Full Art PSA 9", "giratina v", "Lost Origin", "186/196"],
        ["Giratina V SWSH11 Lost Origin 186/196 Alt Full Art Holo PSA 9", "giratina v", "Lost Origin", "186/196"],
        ["Leafeon V Evolving Skies 167/203 SWSH07 Full Art Holo PSA 9", "leafeon v", "Evolving Skies", "167/203"],
    ]) {
        const reading = readTitleByRules(title);
        assert.deepEqual([reading.cardName, reading.set, reading.cardNumber, reading.grader, reading.grade], [name, set, number, "PSA", "9"], title);
    }
});

test("art cleanup preserves printed forms, owners, unknown words and incompatible release codes", () => {
    for (const name of ["Dark Charizard", "Mega Charizard X", "M Charizard EX", "Alolan Ninetales GX", "Galarian Sirfetch'd V",
        "Blaine's Arcanine", "Misty's Gyarados", "Charizard ex", "Rayquaza VMAX", "Rayquaza VSTAR", "Unown R"]) {
        assert.equal(readTitleByRules(`${name} Evolving Skies 194/203 Alternate Full Art Holo PSA 9`).cardName, name.toLowerCase(), name);
    }
    for (const title of [
        "Rayquaza V Evolving Skies 194/203 Curious Art Holo PSA 9",
        "Rayquaza V Evolving Skies 194/203 SWSH11 Holo PSA 9",
        "Rayquaza V Evolving Skies 194/203 SWSH007 Holo PSA 9",
        "Rayquaza V 194/203 SWSH07 Holo PSA 9",
        "SWSH's Rayquaza V Evolving Skies 194/203 Holo PSA 9",
    ]) assert.notEqual(readTitleByRules(title).cardName, "rayquaza v", title);
    assert.equal(readTitleByRules("Rayquaza V Evolving Skies SWSH194 Holo PSA 9").cardNumber, "SWSH194", "a promo number is transcribed, never erased as a release code");
    assert.equal(readTitleByRules("Rayquaza V Evolving Skies SWSH07 Holo PSA 9").cardNumber, "SWSH07", "without a separate collector fraction the code remains the literal number");
    const raw = readTitleByRules("Rayquaza V Evolving Skies 194/203 Alt Full Art Holo HP");
    assert.equal(raw.cardName, "rayquaza v"); assert.equal(raw.condition, "Heavily Played");
    assert.equal(raw.grader, null); assert.equal(raw.grade, null);
    const qualifier = readTitleByRules("Giratina V Lost Origin 186/196 Full Art Holo PSA 9 (OC)");
    assert.notEqual(qualifier.cardName, "giratina v", "name-only cleaning must not erase the original qualifier");
    assert.equal(qualifier.grade, "9");
});
