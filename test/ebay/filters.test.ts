import { test } from "node:test";
import assert from "node:assert/strict";
import { exclusionReason } from "../../server/ebay/filters.ts";

// Titles below are real eBay listings from a "charizard" search.
const single = (title, itemId = "v1|111|0") => ({ title, itemId });

test("keeps a single card whose title matches the search", () => {
    const item = single("Pokemon TCG English Charizard 3/70 Dragon Holo");
    assert.equal(exclusionReason(item), null);
});

test("drops pick-your-card listings even when an option matches", () => {
    const item = single(
        "Pokemon 151 Cards! Holo/Reverse Holo Ex Illustration Ultra Double Rare Card!",
        "v1|156241664107|458154877035"
    );
    assert.match(exclusionReason(item), /Pick-your-card/);
});

test("drops lots and bundles", () => {
    const item = single("1999 GUARANTEED VINTAGE- Holos, Ultra Rares, 50 Cards POKEMON - CHARIZARD");
    assert.equal(exclusionReason(item), "Lot or bundle");
});

test("drops TCG Pocket items but keeps vintage Pocket Monsters cards", () => {
    const digital = single("Pokemon TCG Pocket - MEGA CHARIZARD X EX from DELUXE PACK MEGA");
    const vintage = single("Charizard Pocket Monsters Japanese Base Set No Rarity Holo");
    assert.equal(exclusionReason(digital), "Digital item");
    assert.equal(exclusionReason(vintage), null);
});

test("drops proxies and customs", () => {
    const custom = single("Charizard Custom Gold Metal Card Proxy");
    const fanArt = single("Pokémon TCG Steel Charizard VMAX *Fan Art* Full Art Holo");
    assert.equal(exclusionReason(custom), "Proxy, custom, or replica");
    assert.equal(exclusionReason(fanArt), "Proxy, custom, or replica");
});

test("keeps any clean single card", () => {
    assert.equal(exclusionReason(single("Lugia Neo Genesis 9/111 Holo")), null);
});
