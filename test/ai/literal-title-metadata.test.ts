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
