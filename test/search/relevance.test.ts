import { test } from "node:test";
import assert from "node:assert/strict";
import { cardMismatch, gradingMatches, isEnglish, setMatches, titleMatches } from "../../server/search/relevance.ts";
import { readSearchByRules } from "../../server/search/intent.ts";

// "base set 1999 charizard", as the AI reads it.
const INTENT = {
    cardName: "Charizard",
    sets: ["Base Set"],
    cardNumber: null,
    printing: null,
    graded: null,
    titleWords: ["charizard"],
    source: "ai",
};

const screen = (card) => ({ status: "CANDIDATE", reason: null, card, bestCase: null, assumed: null });
const card = (set, extra = {}) => ({
    name: "Charizard",
    set,
    cardNumber: "004/102",
    printing: "UNLIMITED",
    printingLabel: "Unlimited",
    ...extra,
});

test("a title has to name the card, not repeat every word of the search", () => {
    // Both were dropped before for missing "1999" or "base set".
    assert.equal(titleMatches("PSA 5 - VINTAGE - Charizard 4/102 Base Set Holo", INTENT), true);
    assert.equal(titleMatches("1999 POKEMON GAME 4 CHARIZARD-HOLO PSA 5", INTENT), true);
    assert.equal(titleMatches("Blastoise 2/102 Base Set Holo Rare", INTENT), false);
});

test("graded or raw only matters when the search asks", () => {
    assert.equal(gradingMatches(true, INTENT), true);
    assert.equal(gradingMatches(false, { ...INTENT, graded: true }), false);
    assert.equal(gradingMatches(false, { ...INTENT, graded: false }), true);
});

test("an identified listing from another set, card, or printing doesn't match", () => {
    assert.equal(cardMismatch(screen(card("Base Set (Shadowless)")), INTENT), null);
    assert.equal(cardMismatch(screen(card("Celebrations: Classic Collection")), INTENT), "OTHER_SET");
    assert.equal(cardMismatch(screen(card("Base Set")), { ...INTENT, cardNumber: "2/102" }), "OTHER_CARD");
    assert.equal(cardMismatch(screen(card("Base Set")), { ...INTENT, printing: "SHADOWLESS" }), "OTHER_PRINTING");
    // Not identified: it stays, and the free check says why.
    assert.equal(cardMismatch(screen(null), INTENT), null);
});

test("without the AI, a search keeps every eBay result and reads only plain words", () => {
    const read = readSearchByRules("base set 1999 charizard shadowless psa 9");

    assert.deepEqual(read.titleWords, []);
    assert.deepEqual(read.sets, []);
    assert.equal(read.printing, "SHADOWLESS");
    assert.equal(read.graded, true);
    assert.equal(read.source, "rules");
});

test("non-English cards are skipped", () => {
    assert.equal(titleMatches("Charizard Japanese Base Set No Rarity Holo", INTENT), false);
    assert.equal(titleMatches("Pokemon Charizard JPN Expansion Pack Holo", INTENT), false);
    assert.equal(titleMatches("Charizard 4/102 Base Set Holo English WOTC", INTENT), true);
    assert.equal(isEnglish("Japanese"), false);
    assert.equal(isEnglish("English"), true);
    assert.equal(isEnglish("EN"), true);
    assert.equal(isEnglish("ENG"), true);
    assert.equal(isEnglish(undefined), true);
});

test("a set fits the search when it's in the family, or unknown", () => {
    assert.equal(setMatches("Base Set (Shadowless)", INTENT), true);
    assert.equal(setMatches("Scarlet & Violet 151", INTENT), false);
    assert.equal(setMatches(null, INTENT), true);
    assert.equal(setMatches("Scarlet & Violet 151", { ...INTENT, sets: [] }), true);
});
