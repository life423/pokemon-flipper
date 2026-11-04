import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readTitleByRules, readTitleWithoutAi } from "../../server/ai/title-reader.ts";
import { readSearchLocally, readSearchWithoutAi } from "../../server/search/intent.ts";
import { createCachedSetNames } from "../../server/search/set-catalog.ts";
import { writeCache } from "../../server/lib/cache.ts";
import { MODEL } from "../../server/ai/openai.ts";
import { findDeals } from "../../server/deals/find-deals.ts";
import type { ListingSummary } from "../../shared/types.ts";

test("literal slab names survive explicit publisher and accompanying holder metadata", t => {
    t.mock.method(globalThis, "fetch", async () => assert.fail("literal name extraction needs no provider"));
    const cases = [
        ["1999 Pokemon Base Set Unlimited Charizard Holo Card 4/102 CGC 9 Mint w/ Guard", "charizard", "Base Set", "4/102", "CGC", "9"],
        ["Wizards of the Coast Pokemon Base Set Unlimited Charizard 4/102 Holo CGC 9 1999", "charizard", "Base Set", "4/102", "CGC", "9"],
        ["Wizards of the Coast Vaporeon Jungle 12/64 Holo PSA 8 with a protective case", "vaporeon", "Jungle", "12/64", "PSA", "8"],
        ["Dark Gyarados Team Rocket 8/82 Holo BGS 8.5 including magnetic holder", "dark gyarados", "Team Rocket", "8/82", "BGS", "8.5"],
        ["Misty's Gyarados Gym Heroes 13/132 Holo CGC 9 includes a sleeve", "misty's gyarados", "Gym Heroes", "13/132", "CGC", "9"],
        ["Guard Spec. Base Set 79/102 PSA 9 with Guard", "guard spec.", "Base Set", "79/102", "PSA", "9"],
        ["Jolteon Jungle 4/64 Holo PSA- 8", "jolteon", "Jungle", "4/64", "PSA", "8"],
        ["Dark Gyarados Team Rocket 8/82 Holo BGS - 8.5 including magnetic holder", "dark gyarados", "Team Rocket", "8/82", "BGS", "8.5"],
        ["Misty's Gyarados Gym Heroes 13/132 Holo CGC– 9 includes a sleeve", "misty's gyarados", "Gym Heroes", "13/132", "CGC", "9"],
        ["Pokemon Card - Mewtwo VSTAR GG44/GG70 Crown Zenith Galarian Gallery Holo - PSA 9", "mewtwo vstar", "Crown Zenith Galarian Gallery", "GG44/GG70", "PSA", "9"],
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
    assert.equal(readTitleByRules("Ho-Oh Neo Revelation 7/64 - PSA 8").cardName, "ho-oh", "standalone separators do not split printed hyphenated names");
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

test("complete art phrases and anchored slab abbreviations retain source-observed modern names", t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("literal slab metadata cleanup must remain offline"));
    for (const [title, name, set, number] of [
        ["Pokemon Gengar Vmax Fusion Strike 271/264 Secret Rare Full Alt Art PSA 9 Mint", "gengar vmax", "fusion strike", "271/264"],
        ["Gengar VMAX Fusion Strike 271/264 Full Alternate Art Holo PSA 9", "gengar vmax", "fusion strike", "271/264"],
        ["2021 Pokemon SWSH Fusion Strike Gengar VMAX 271/264 Alt Art Holo PSA 9", "gengar vmax", "fusion strike", "271/264"],
        ["PSA 9 Giratina VSTAR GG69/GG70 Crown Zenith Galarian Gallery FA Holo ENG", "giratina vstar", "Crown Zenith Galarian Gallery", "GG69/GG70"],
        ["2023 Pokemon SWSH Full Art FA Pikachu Crown Zenith  160/159 PSA 9 MINT", "pikachu", "Crown Zenith", "160/159"],
        ["2023 EN POKÉMON FA/PIKACHU #160/159 - CROWN ZENITH - PSA 9", "pikachu", "Crown Zenith", "160/159"],
        ["2023 Pokémon TCG SWSH FA/pikachu Crown Zenith PSA 9 Mint 160/159", "pikachu", "Crown Zenith", "160/159"],
        ["2023 Pokemon Scarlet & Violet 151 - Charizard ex 199/165 SIR - PSA 9", "charizard ex", "Scarlet & Violet 151", "199/165"],
        ["Pokemon Charizard EX Holo PSA 9 Mint 199/165 Sv: Scarlet & Violet 151", "charizard ex", "Scarlet & Violet 151", "199/165"],
        ["Pokemon 2023 Charizard ex 199/165 PSA 9 SIR Holo Sv: Scarlet & Violet 151 EN", "charizard ex", "Scarlet & Violet 151", "199/165"],
    ]) {
        const reading = readTitleByRules(title, ["fusion strike"]);
        assert.deepEqual([reading.cardName, reading.set, reading.cardNumber, reading.grader, reading.grade], [name, set, number, "PSA", "9"], title);
    }
    const raw = readTitleByRules("Gengar VMAX Fusion Strike 271/264 Full Alt Art Holo HP", ["fusion strike"]);
    assert.equal(raw.cardName, "gengar vmax"); assert.equal(raw.condition, "Heavily Played");
    assert.equal(raw.grader, null); assert.equal(raw.grade, null);
    for (const name of ["Dark Pikachu", "Misty's Pikachu", "Pikachu ex", "Pikachu V", "Pikachu VMAX", "Pikachu VSTAR", "Nidoran female", "Nidoran male"]) {
        assert.equal(readTitleByRules(`${name} Crown Zenith 160/159 FA Holo PSA 9`).cardName, name.toLowerCase(), name);
    }
});

test("art abbreviations require complete release and numeric slab anchors without hiding other claims", () => {
    for (const [title, name] of [
        ["FA Pikachu Crown Zenith PSA 9", "pikachu"],
        ["Pikachu FA 160/159 PSA 9", "pikachu"],
        ["Pikachu FA Crown Zenith 160/159 PSA", "pikachu"],
        ["Pikachu FA Crown Zenith 160/159 NM", "pikachu"],
        ["FA's Pikachu Crown Zenith 160/159 PSA 9", "pikachu"],
        ["Charizard ex SIR 199/165 SV 151 Holo PSA 9", "charizard ex"],
        ["Charizard ex SV 199/165 PSA 9", "charizard ex"],
        ["Charizard ex SIR Scarlet & Violet 151 PSA 9", "charizard ex"],
        ["Charizard ex SIR Scarlet & Violet 151 199/165 NM", "charizard ex"],
        ["SV's Charizard ex Scarlet & Violet 151 199/165 PSA 9", "charizard ex"],
        ["Pikachu FA Crown Zenith 160/159 PSA 9 (OC)", "pikachu"],
        ["Pikachu FA Crown Zenith 160/159 Misprint PSA 9", "pikachu"],
        ["Pikachu FA Crown Zenith 160/159 raw potential PSA 10", "pikachu"],
        ["Pikachu FA Crown Zenith 160/159 PSA-ready 10", "pikachu"],
    ]) assert.notEqual(readTitleByRules(title).cardName, name, title);
    for (const [title, number, name] of [
        ["Pikachu FA Crown Zenith #160 PSA 9", "160", "pikachu"],
        ["Charizard ex SIR Scarlet & Violet 151 #199 PSA 9", "199", "charizard ex"],
        ["Pikachu FA Crown Zenith SWSH194 PSA 9", "SWSH194", "pikachu"],
        ["Pikachu FA Aquapolis H28/147 PSA 9", "H28/147", "pikachu"],
        ["Pikachu FA Aquapolis 95a/147 PSA 9", "95a/147", "pikachu"],
    ]) {
        const reading = readTitleByRules(title);
        assert.equal(reading.cardNumber, number, title);
        assert.notEqual(reading.cardName, name, title);
    }
    for (const wording of ["proxy", "custom card", "no card"]) {
        const reading = readTitleByRules(`Pikachu Crown Zenith 160/159 FA Holo PSA 9 ${wording}`);
        assert.equal(reading.kind, "NOT_A_CARD", wording); assert.equal(reading.cardName, null, wording);
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
    const dashedQualifier = readTitleByRules("Giratina V Lost Origin 186/196 Full Art Holo PSA- 9 (OC)");
    assert.notEqual(dashedQualifier.cardName, "giratina v");
    assert.equal(dashedQualifier.grade, "9");
    for (const title of ["Giratina V Lost Origin 186/196 Holo raw potential PSA- 10", "Giratina V Lost Origin 186/196 Holo PSA-ready 10",
        "Giratina V Lost Origin 186/196 Holo BGS 9 cross to PSA- 10"]) {
        assert.notEqual(readTitleByRules(title).cardName, "giratina v", title);
    }
});

test("cached English set phrases resolve unfamiliar releases without erasing card forms or overlapping releases", () => {
    const names = ["paldea evolved", "fusion strike", "vivid voltage", "scarlet violet", "scarlet violet 151", "base set", "ex team rocket returns"];
    for (const [title, name, set] of [
        ["Magikarp Paldea Evolved 203/193 PSA 9", "magikarp", "paldea evolved"],
        ["Gengar VMAX Fusion Strike 271/264 PSA 9", "gengar vmax", "fusion strike"],
        ["Pikachu VMAX Vivid-Voltage 188/185 PSA 9", "pikachu vmax", "vivid voltage"],
        ["Charizard ex Scarlet & Violet 151 199/165 PSA 9", "charizard ex", "Scarlet & Violet 151"],
        ["Blastoise Base Set 2 2/130 PSA 8", "blastoise", "Base Set 2"],
        ["Rocket's Suicune ex EX Team Rocket Returns 105/109 PSA 7", "rocket's suicune ex", "ex team rocket returns"],
    ]) {
        const reading = readTitleByRules(title, names);
        assert.equal(reading.cardName, name, title);
        assert.equal(reading.set, set, title);
    }
    const intent = readSearchLocally("Magikarp Paldea Evolved 203/193 PSA 9", names);
    assert.equal(intent.cardName, "magikarp"); assert.deepEqual(intent.sets, ["paldea evolved"]);
    assert.deepEqual(intent.titleWords, ["magikarp"]); assert.equal(intent.cardNumber, "203/193");
    assert.equal(intent.minGrade, 9); assert.equal(intent.maxGrade, 9);
    assert.deepEqual(readSearchLocally("Rocket's Suicune ex EX Team Rocket Returns 105/109 PSA 7", names).sets, ["ex team rocket returns"]);
    assert.equal(readTitleByRules("Magikarp Paldea Evolvedness 203/193 PSA 9", names).set, null, "a substring does not identify a release");
    assert.equal(readTitleByRules("Charizard Base Set Celebrations 4/102 PSA 9", names).set, "Celebrations", "literal reprint evidence retains precedence");
});

test("explicit illustration rarity phrases clean modern listing names while forms and unresolved wording remain", t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("literal rarity cleanup must remain offline"));
    const names = ["paldea evolved"];
    for (const title of [
        "Pokemon Paldea Evolved Magikarp 203/193 Illustration Rare Holo PSA 9",
        "Pokemon Magikarp Paldea Evolved 203/193 Illustration Rare PSA 9",
        "Pokemon Magikarp Paldea Evolved 203/193 Special Illustration Rare Holo PSA 9",
    ]) {
        const reading = readTitleByRules(title, names);
        assert.deepEqual([reading.cardName, reading.set, reading.cardNumber, reading.grader, reading.grade], ["magikarp", "paldea evolved", "203/193", "PSA", "9"], title);
    }
    for (const name of ["Dark Magikarp", "Magikarp ex", "Misty's Magikarp", "Magikarp VSTAR"]) {
        assert.equal(readTitleByRules(`${name} Paldea Evolved 203/193 Special Illustration Rare Holo PSA 9`, names).cardName, name.toLowerCase());
    }
    for (const wording of ["Illustration", "IR", "SIR", "Illustration Rare (OC)", "Illustration Rare Misprint", "Illustration Rare's"]) {
        assert.notEqual(readTitleByRules(`Magikarp Paldea Evolved 203/193 ${wording} Holo PSA 9`, names).cardName, "magikarp", wording);
    }
    for (const wording of ["proxy", "custom card", "no card"]) {
        const reading = readTitleByRules(`Magikarp Paldea Evolved 203/193 Illustration Rare Holo PSA 9 ${wording}`, names);
        assert.equal(reading.kind, "NOT_A_CARD", wording); assert.equal(reading.cardName, null, wording);
    }
});

test("set catalog shares local reads and caches a miss without making a provider refresh", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("set catalog lookup must remain cache-only"));
    let calls = 0, now = 0;
    const names = createCachedSetNames({ load: async () => { calls++; return calls === 1 ? null : { "SV02: Paldea Evolved": 2023 }; }, now: () => now, ttlMs: 100 });
    assert.deepEqual(await Promise.all(Array.from({ length: 50 }, () => names())), Array.from({ length: 50 }, () => []));
    assert.equal(calls, 1);
    assert.deepEqual(await names(), []); assert.equal(calls, 1);
    now = 101;
    assert.deepEqual(await names(), ["paldea evolved"]); assert.equal(calls, 2);
});

test("async search and listing fallbacks reuse the stored catalog while accepted paid title readings remain unchanged", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("catalog-backed readers need no paid or provider work"));
    await writeCache("pokemonpricetracker:set-years", { "paldea evolved": 2023, "fusion strike": 2021, "ex team rocket returns": 2004 });
    const intent = await readSearchWithoutAi("Magikarp Paldea Evolved 203/193 PSA 9");
    assert.equal(intent.cardName, "magikarp"); assert.deepEqual(intent.sets, ["paldea evolved"]);
    const reading = await readTitleWithoutAi("Pokemon Magikarp Paldea Evolved 203/193 PSA 9");
    assert.equal(reading.cardName, "magikarp"); assert.equal(reading.set, "paldea evolved");
    const returns = "2004 POKEMON EX TEAM ROCKET RETURNS #105 ROCKET’S SUICUNE EX-HOLO PSA 7";
    assert.equal((await readTitleWithoutAi(returns)).set, "ex team rocket returns");
    assert.deepEqual((await readSearchWithoutAi("Suicune EX Team Rocket Returns PSA 7")).sets, ["ex team rocket returns"]);
    const wrongSet: ListingSummary = { id: "wrong-modern-set", title: returns, currentPrice: 100, shipping: 0, buyingOption: "FIXED_PRICE", bids: 0,
        isGraded: true, endTime: null, images: ["front"], url: "#", seller: null };
    const rows = await findDeals("Suicune Team Rocket PSA 7", {}, {
        readIntent: readSearchWithoutAi, readTitle: readTitleWithoutAi,
        search: async () => ({ listings: [wrongSet], total: 1, skipped: 0 }),
        soldScreening: () => async () => assert.fail("a known newer set must be excluded before sold-price research"),
    });
    assert.deepEqual(rows, [], "the longer catalog release cannot borrow the original Team Rocket search scope");
    const title = "Gengar VMAX Fusion Strike 271/264 PSA 9";
    const paid = { kind: "SINGLE_CARD", cardName: "Gengar VMAX", set: "Fusion Strike", cardNumber: "271/264", language: "English", grader: "PSA", grade: "9", condition: null };
    await writeCache(`title-reading:v6:${MODEL}:${title.toLowerCase()}`, paid);
    assert.deepEqual(await readTitleWithoutAi(title), paid);
});
