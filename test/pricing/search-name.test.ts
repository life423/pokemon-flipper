import "../fixtures/isolated-data.ts";
import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import { canonicalCatalogName, pricingSearchName, sameCatalogName } from "../../server/pricing/search-name.ts";
import { lookupCards } from "../../server/pricing/pkmnprices.ts";

test("Unown letter queries match provider naming without broadening unrelated names", () => {
    for (const name of ["Unown A", "Unown [A]", "Unown (I)", "Unown M holo"]) assert.equal(pricingSearchName(name), "unown");
    assert.equal(pricingSearchName("Unown VSTAR"), "unown vstar");
    assert.equal(pricingSearchName("Dark Espeon holo"), "dark espeon");
    assert.equal(pricingSearchName("PRIMEAPE-REVERSE FOIL"), "primeape");
    assert.equal(pricingSearchName("Kingdra Reverse Holofoil"), "kingdra");
    assert.equal(pricingSearchName("Dark Espeon Non-Holo"), "dark espeon");
});

test("catalog names remove known descriptive suffixes while preserving owners and printed forms", () => {
    for (const [source, expected] of [
        ["Snorlax Holofoil", "snorlax"],
        ["Leafeon V (Alternate Full Art)", "leafeon v"],
        ["Mew VMAX (Alternate Art Secret)", "mew vmax"],
        ["Pikachu VMAX (Secret)", "pikachu vmax"],
        ["Mewtwo GX (Secret Shining)", "mewtwo gx"],
        ["Leafeon V Full Art Holofoil", "leafeon v"],
        ["Blaine’s Arcanine", "blaine's arcanine"],
        ["Rocket's Mewtwo", "rocket's mewtwo"],
        ["Galarian Sirfetch’d", "galarian sirfetch'd"],
        ["Nidoran♀", "nidoran female"],
        ["Charizard ☆", "charizard star"],
        ["Pikachu δ", "pikachu delta"],
    ]) {
        assert.equal(canonicalCatalogName(source), expected, source);
        assert.equal(pricingSearchName(source), expected, source);
    }
    assert.ok(sameCatalogName("Leafeon V", "Leafeon V (Alternate Full Art)"));
    assert.ok(sameCatalogName("Mew VMAX", "Mew VMAX (Alternate Art Secret)"));
    assert.ok(sameCatalogName("Pikachu VMAX", "Pikachu VMAX (Secret)"));
    assert.ok(sameCatalogName("Unown [R]", "Unown R"));
    for (const [left, right] of [
        ["Mew", "Mewtwo"], ["Arcanine", "Blaine's Arcanine"], ["Blaines Arcanine", "Blaine's Arcanine"],
        ["Charizard", "Dark Charizard"], ["Charizard ex", "Charizard"], ["Leafeon V", "Leafeon VMAX"],
        ["Mega Charizard X", "Mega Charizard Y"], ["Unown A", "Unown R"], ["Nidoran♀", "Nidoran♂"],
        ["Charizard ☆", "Charizard"], ["Pikachu δ", "Pikachu"], ["Leafeon V Curious Art", "Leafeon V"],
        ["Snorlax R", "Snorlax"], ["Snorlax Edition", "Snorlax"],
        ["Mew VMAX (Alternate Art Secret)", "Mew V"], ["Pikachu VMAX (Secret)", "Pikachu"],
        ["Rocket's Mewtwo (Secret)", "Mewtwo"], ["Unown (R) (Secret)", "Unown A"],
        ["Mew VMAX Secret", "Mew VMAX"], ["Mew VMAX (Secret Power)", "Mew VMAX"],
        ["Mewtwo GX Secret Shining", "Mewtwo GX"], ["Mewtwo GX (Shining)", "Mewtwo GX"],
        ["Shining Mewtwo (Secret)", "Mewtwo"], ["Mewtwo GX (Secret Shining)", "Shining Mewtwo"],
    ]) assert.equal(sameCatalogName(left, right), false, `${left} / ${right}`);
    assert.equal(sameCatalogName("Holofoil", ""), false);
    assert.equal(sameCatalogName(undefined, "Snorlax"), false);
});

test("provider lookup for Unown A retains exact card-number selection", async t => {
    const previous = process.env.PKMNPRICES_API_KEY; process.env.PKMNPRICES_API_KEY = "offline-test";
    t.after(() => { if (previous === undefined) delete process.env.PKMNPRICES_API_KEY; else process.env.PKMNPRICES_API_KEY = previous; });
    const paths: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
        const parsed = new URL(String(url)); paths.push(parsed.pathname + parsed.search);
        const body = parsed.pathname === "/v1/sets" ? { data: [{ id: 551, name: "Neo Discovery" }] }
            : parsed.pathname === "/v1/cards" ? { data: [{ id: 1, name: "Unown [A]", number: "14", total_set_number: "75" }, { id: 2, name: "Unown [I]", number: "40", total_set_number: "75" }] }
            : { id: 1, name: "Unown [A]", number: "14", total_set_number: "75", set: { name: "Neo Discovery" }, prices: [] };
        return new Response(JSON.stringify(body), { status: 200 });
    });
    const cards = await lookupCards({ set: "Neo Discovery", name: "Unown A", cardNumber: "14/75" });
    assert.equal(cards.length, 1); assert.equal(cards[0].name, "Unown [A]");
    assert.ok(paths.some(path => path.includes("name=unown&"))); assert.ok(!paths.some(path => path.startsWith("/v1/cards/2")));
});
