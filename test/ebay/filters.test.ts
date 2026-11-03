import { test } from "node:test";
import assert from "node:assert/strict";
import { exclusionReason } from "../../server/ebay/filters.ts";
import { readTitleByRules } from "../../server/ai/title-reader.ts";

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

test("drops sealed product, merch, empty slabs, and multiples", () => {
    const reason = (title) => exclusionReason(single(title));

    assert.equal(reason("Pokemon Base Set Booster Pack Charizard Art"), "Sealed product");
    assert.equal(reason("Charizard Elite Trainer Box ETB"), "Sealed product");
    assert.equal(reason("Charizard Plush 12 inch Pokemon Center"), "Merchandise, not a card");
    assert.equal(reason("Charizard Pokemon Keychain"), "Merchandise, not a card");
    assert.equal(reason("PSA 10 Empty Slab Charizard Label"), "Empty slab, case, or label");
    assert.equal(reason("Charizard 4/102 Base Set Holo x2"), "Lot or bundle");
    assert.match(reason("Charizard Grab Bag Vintage"), /Mystery/);
});

test("keeps single cards that mention how they ship, or an X in the name", () => {
    assert.equal(exclusionReason(single("Charizard 4/102 Base Set Holo PSA 9 ships in toploader")), null);
    assert.equal(exclusionReason(single("Charizard 4/102 Base Set Holo NM in sleeve")), null);
    assert.equal(exclusionReason(single("Mega Charizard X ex 125/094 Phantasmal Flames")), null);
    assert.equal(exclusionReason(single("Charizard X 2016 Promo")), null);
    assert.equal(exclusionReason(single("2020 Pokemon SWSH Black Star Promo Champions Path ETB #SWSH050 Charizard V")), null);
});

test("drops random-card fillers and novelty cards", () => {
    const reason = (title) => exclusionReason(single(title));

    assert.match(reason("Pokemon (1) Card 100% Vintage WOTC Guaranteed Authentic 1999 Base Set"), /Mystery/);
    assert.match(reason("Pokemon TCG assorted cards Vintage Only - WOTC Base set / Jungle"), /Mystery/);
    assert.equal(reason("Charizard #6 VTG Pokemon Burger King PokeTrivia Movie Card 1999"), "Merchandise, not a card");
    assert.equal(reason("Topps 1999 Charizard #06E6 of 12 Vintage Pokemon Trading Cards"), "Merchandise, not a card");
    assert.equal(reason("Pokemon Sticker - Charizard Original Base Set Card Artwork, Vinyl Decal"), "Merchandise, not a card");
});

test("authenticity assurances do not turn named single cards into mystery offers", () => {
    for (const assurance of ["Authenticity Guaranteed", "eBay AUTHENTICITY GUARANTEED", "Authenticity-Guaranteed",
        "Authenticity—Guaranteed", "Guaranteed Authentic", "Genuine Guaranteed"]) {
        const title = `Charizard Base Set 4/102 Holo PSA 8 ${assurance}`;
        assert.equal(exclusionReason(single(title)), null, title);
        assert.notEqual(readTitleByRules(title).kind, "NOT_A_CARD", "local title rules use the same exclusion predicate");
    }
});

test("custom holders accompanying a card do not imply a custom card", () => {
    for (const accompaniment of ["with a custom protective case", "with a custom‑protective case", "in custom magnetic holder", "ships in a custom card sleeve",
        "includes custom top-loader", "comes with a custom fitted acrylic case", "custom protective case included"]) {
        const title = `Charizard Base Set 4/102 Holo PSA 8 ${accompaniment}`;
        assert.equal(exclusionReason(single(title)), null, title);
        assert.notEqual(readTitleByRules(title).kind, "NOT_A_CARD");
    }
    assert.equal(exclusionReason(single("Custom protective case for Charizard")), "Proxy, custom, or replica", "a holder-only offer is not an accompanying card accessory");
});

test("benign assurance or holder phrases cannot whitelist other junk in the same listing", () => {
    const rejected = [
        ["Charizard custom gold metal card with a custom protective case", /Proxy/],
        ["Charizard proxy Authenticity Guaranteed with a custom protective case", /Proxy/],
        ["Charizard replica Guaranteed Authentic", /Proxy/],
        ["Charizard fan art Authenticity Guaranteed", /Proxy/],
        ["Charizard mystery repack Authenticity Guaranteed with a custom protective case", /Mystery/],
        ["Pokemon random guaranteed holo with a custom protective case", /Mystery/],
        ["Pokemon (1) Card Guaranteed Authentic", /Mystery/],
        ["Pokemon ( 1 ) Pokemon Card Guaranteed Authentic Vintage", /Mystery/],
        ["1 Pokemon Card Guaranteed Authentic Vintage WOTC", /Mystery/],
        ["Charizard empty slab Authenticity Guaranteed with a custom protective case", /Empty/],
        ["Charizard slab only with a custom protective case", /Empty/],
        ["Charizard with a custom protective case only", /Empty/],
        ["Charizard plush Authenticity Guaranteed", /Merchandise/],
        ["Charizard booster pack Guaranteed Authentic", /Sealed/],
        ["Charizard digital code card with custom protective case", /Digital/],
        ["Charizard 4/102 x2 Authenticity Guaranteed", /Lot/],
    ] as const;
    for (const [title, reason] of rejected) {
        assert.match(exclusionReason(single(title)) ?? "", reason, title);
        assert.equal(readTitleByRules(title).kind, "NOT_A_CARD", title);
    }
    const benign = "Charizard 4/102 Authenticity Guaranteed with a custom protective case";
    assert.match(exclusionReason(single(benign, "v1|111|123")) ?? "", /Pick-your-card/);
    assert.match(exclusionReason({ ...single(benign), itemGroupType: "SELLER_DEFINED_VARIATIONS" }) ?? "", /Pick-your-card/);
});

