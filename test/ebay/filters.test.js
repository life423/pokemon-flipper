import { test } from "node:test";
import assert from "node:assert/strict";
import { exclusionReason, searchTerms } from "../../server/ebay/filters.ts";

// Titles below are real eBay listings from a "charizard" search.
const single = (title, itemId = "v1|111|0") => ({ title, itemId });

test("keeps a single card whose title matches the search", () => {
    const item = single("Pokemon TCG English Charizard 3/70 Dragon Holo");
    assert.equal(exclusionReason(item, "charizard"), null);
});

test("drops pick-your-card listings even when an option matches", () => {
    const item = single(
        "Pokemon 151 Cards! Holo/Reverse Holo Ex Illustration Ultra Double Rare Card!",
        "v1|156241664107|458154877035"
    );
    assert.match(exclusionReason(item, "charizard"), /Pick-your-card/);
});

test("drops listings whose title doesn't mention the search", () => {
    const item = single("Rattata #19, Pokemon TCG Blue Logo Topps TV Animation Edition");
    assert.match(exclusionReason(item, "charizard"), /doesn't mention charizard/);
});

test("matches accented titles and searches", () => {
    const item = single("Pokémon Charizard Base Set 4/102 Holo");
    assert.equal(exclusionReason(item, "Pokémon charizard"), null);
});

test("drops lots and bundles", () => {
    const item = single("1999 GUARANTEED VINTAGE- Holos, Ultra Rares, 50 Cards POKEMON - CHARIZARD");
    assert.equal(exclusionReason(item, "charizard"), "Lot or bundle");
});

test("drops TCG Pocket items but keeps vintage Pocket Monsters cards", () => {
    const digital = single("Pokemon TCG Pocket - MEGA CHARIZARD X EX from DELUXE PACK MEGA");
    const vintage = single("Charizard Pocket Monsters Japanese Base Set No Rarity Holo");
    assert.equal(exclusionReason(digital, "charizard"), "Digital item");
    assert.equal(exclusionReason(vintage, "charizard"), null);
});

test("drops proxies and customs", () => {
    const custom = single("Charizard Custom Gold Metal Card Proxy");
    const fanArt = single("Pokémon TCG Steel Charizard VMAX *Fan Art* Full Art Holo");
    assert.equal(exclusionReason(custom, "charizard"), "Proxy, custom, or replica");
    assert.equal(exclusionReason(fanArt, "charizard"), "Proxy, custom, or replica");
});

test("an empty search keeps any clean single card", () => {
    assert.deepEqual(searchTerms(""), []);
    assert.equal(exclusionReason(single("Lugia Neo Genesis 9/111 Holo"), ""), null);
});
