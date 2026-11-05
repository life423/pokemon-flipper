import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveScreeningName, screeningNameKey } from "../../server/identity/screening-name.ts";
import { readTitleByRules } from "../../server/ai/title-reader.ts";

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

test("complete pre-grader GEM MINT descriptions do not pollute literal or saved card names", () => {
    const title = "Pokemon 1999 Dragonite 4/62 Holo Fossil GEM MINT CGC 10";
    assert.equal(readTitleByRules(title).cardName, "dragonite");
    assert.equal(resolveScreeningName({ title, claims: ["Dragonite", "dragonite gem"], candidate: "Dragonite" }), "Dragonite");
    for (const name of ["Dark Dragonite", "Charizard ex", "Mew VMAX", "Rocket's Mewtwo", "Unown G", "Gem Dragonite"]) {
        for (const descriptor of ["GEM MINT CGC 10", "GEM MT PSA - 10"]) {
            const source = `${name} ${descriptor}`;
            assert.equal(resolveScreeningName({ title: source, claims: [name, `${name} gem`], candidate: name }), name, source);
        }
    }
    assert.equal(resolveScreeningName({ title: "GEM MINT CGC 10 Gem Dragonite", claims: ["Gem Dragonite"], candidate: "Dragonite" }), "Gem Dragonite");
    for (const source of ["Dragonite GEM", "Dragonite GEM MINT", "Dragonite GEM MINT CGC", "Dragonite GEM MINT CGC Authentic", "Dragonite GEM MINT curious CGC 10"]) {
        assert.equal(resolveScreeningName({ title: source, claims: ["Dragonite gem"], candidate: "Dragonite" }), "Dragonite gem", source);
    }
    assert.equal(resolveScreeningName({ title: "Dark Dragonite GEM MINT CGC 10", claims: ["Dragonite", "Dark Dragonite gem"], candidate: "Dragonite" }), null);
    assert.equal(resolveScreeningName({ title: "Dragonite GEM MINT CGC 10 Curious", claims: ["Dragonite gem curious"], candidate: "Dragonite" }), "Dragonite curious");
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

test("anchored art abbreviations reconcile older saved name residue while retaining source identity conflicts", () => {
    for (const [title, polluted, candidate] of [
        ["Pokemon Gengar Vmax Fusion Strike 271/264 Secret Rare Full Alt Art PSA 9 Mint", "gengar vmax full", "Gengar VMAX"],
        ["2021 Pokemon SWSH Fusion Strike Gengar VMAX 271/264 Alt Art Holo PSA 9", "swsh gengar vmax", "Gengar VMAX"],
        ["PSA 9 Giratina VSTAR GG69/GG70 Crown Zenith Galarian Gallery FA Holo ENG", "giratina vstar fa", "Giratina VSTAR"],
        ["2023 EN POKÉMON FA/PIKACHU #160/159 - CROWN ZENITH - PSA 9", "fa/pikachu", "Pikachu"],
        ["2023 Pokemon SWSH Full Art FA Pikachu Crown Zenith 160/159 PSA 9 MINT", "fa pikachu", "Pikachu"],
        ["Charizard ex Scarlet & Violet 151 199/165 SIR Holo PSA 9", "charizard ex sir", "Charizard ex"],
        ["Pokemon Charizard EX Holo PSA 9 Mint 199/165 Sv: Scarlet & Violet 151", "charizard ex sv", "Charizard ex"],
    ]) assert.equal(resolveScreeningName({ title, claims: [candidate, polluted], candidate }), candidate, title);
    for (const [title, polluted, candidate] of [
        ["Dark Pikachu Crown Zenith 160/159 FA PSA 9", "dark pikachu fa", "Pikachu"],
        ["Misty's Pikachu Crown Zenith 160/159 FA PSA 9", "misty's pikachu fa", "Pikachu"],
        ["Gengar VMAX Fusion Strike 271/264 FA PSA 9", "gengar vmax fa", "Gengar V"],
        ["Giratina VSTAR Crown Zenith Galarian Gallery GG69/GG70 FA PSA 9", "giratina vstar fa", "Giratina V"],
        ["Nidoran female Crown Zenith 160/159 FA PSA 9", "nidoran female fa", "Nidoran male"],
    ]) assert.equal(resolveScreeningName({ title, claims: [candidate, polluted], candidate }), null, title);
    for (const [title, claim] of [
        ["Pikachu Crown Zenith FA PSA 9", "pikachu fa"],
        ["Pikachu Crown Zenith 160/159 FA", "pikachu fa"],
        ["Charizard ex SV 151 199/165 SIR PSA 9", "charizard ex sir"],
        ["FA's Pikachu Crown Zenith 160/159 PSA 9", "FA's Pikachu"],
        ["Pikachu Crown Zenith 160/159 FA Misprint PSA 9", "pikachu fa misprint"],
    ]) assert.notEqual(resolveScreeningName({ title, claims: [claim], candidate: "Pikachu" }), "Pikachu", title);
});

test("observed Cosmos Holo metadata needs a full number and written catalog release", () => {
    const title = "Lugia Neo Genesis 9/111 Unlimited Cosmos Holo PSA 9";
    assert.equal(resolveScreeningName({ title, claims: ["Lugia", "lugia cosmos"], candidate: "Lugia", set: "Neo Genesis" }), "Lugia");
    for (const [source, set] of [
        ["Lugia Neo Genesis #9 Cosmos Holo PSA 9", "Neo Genesis"],
        ["Lugia 9/111 Cosmos Holo PSA 9", "Neo Genesis"],
        [title, "Neo Revelation"],
        ["Lugia Neo Genesis 9/111 Cosmos PSA 9", "Neo Genesis"],
        ["Lugia Neo Genesis 9/111 Curious Holo PSA 9", "Neo Genesis"],
    ]) assert.notEqual(resolveScreeningName({ title: source, claims: [source.includes("Curious") ? "lugia curious" : "lugia cosmos"], candidate: "Lugia", set }), "Lugia", source);
    for (const name of ["Cosmos Pikachu", "Cosmos's Lugia", "Dark Lugia"]) {
        const source = `${name} Neo Genesis 9/111 Cosmos Holo PSA 9`;
        assert.equal(resolveScreeningName({ title: source, claims: [name, `${name} cosmos`], candidate: "Lugia", set: "Neo Genesis" }), name, source);
    }
});

test("Sun and Moon era metadata requires a separate written release, full number and slab grade", () => {
    for (const era of ["Sun & Moon", "Sun and Moon", "Sun Moon"]) {
        const title = `2017 Pokemon ${era} Shining Legends Mewtwo GX 78/73 PSA 9`;
        assert.equal(readTitleByRules(title, ["Shining Legends"]).cardName, "mewtwo gx");
        assert.equal(resolveScreeningName({ title, set: "Shining Legends", claims: ["mewtwo gx", "sun moon mewtwo gx"], candidate: "Mewtwo GX" }), "Mewtwo GX");
    }
    for (const [title, set] of [
        ["Sun & Moon Mewtwo GX 78/73 PSA 9", "Shining Legends"],
        ["Sun & Moon Shining Legends Mewtwo GX #78 PSA 9", "Shining Legends"],
        ["Sun & Moon Shining Legends Mewtwo GX 78/73 raw", "Shining Legends"],
        ["Sun & Moon Shining Legends Mewtwo GX 78/73 PSA", "Shining Legends"],
        ["Sun & Moon Mewtwo GX 78/73 PSA 9", "Sun & Moon"],
        ["Moon & Sun Shining Legends Mewtwo GX 78/73 PSA 9", "Shining Legends"],
    ]) assert.notEqual(resolveScreeningName({ title, set, claims: ["sun moon mewtwo gx"], candidate: "Mewtwo GX" }), "Mewtwo GX", title);
    const title = "Sun & Moon Shining Legends Shining Mewtwo 78/73 PSA 9";
    assert.equal(readTitleByRules(title, ["Shining Legends"]).cardName, "shining mewtwo");
    assert.equal(resolveScreeningName({ title: title + " Curious", set: "Shining Legends", claims: ["sun moon shining mewtwo curious"], candidate: "Mewtwo" }), "shining mewtwo curious");
    for (const word of ["SunMoon", "SunandMoon", "Sun andMoon", "Sunand Moon", "Moon's Sun"]) {
        const source = `${word} Shining Legends Mewtwo GX 78/73 PSA 9`;
        assert.notEqual(readTitleByRules(source, ["Shining Legends"]).cardName, "mewtwo gx");
        assert.notEqual(resolveScreeningName({ title: source, set: "Shining Legends", claims: [`${word} Mewtwo GX`], candidate: "Mewtwo GX" }), "Mewtwo GX");
    }
});
