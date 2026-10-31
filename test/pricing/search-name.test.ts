import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { pricingSearchName } from "../../server/pricing/search-name.ts";
import { lookupCards } from "../../server/pricing/pkmnprices.ts";

test("Unown letter queries match provider naming without broadening unrelated names", () => {
    for (const name of ["Unown A", "Unown [A]", "Unown (I)", "Unown M holo"]) assert.equal(pricingSearchName(name), "unown");
    assert.equal(pricingSearchName("Unown VSTAR"), "unown vstar");
    assert.equal(pricingSearchName("Dark Espeon holo"), "dark espeon");
    assert.equal(pricingSearchName("PRIMEAPE-REVERSE FOIL"), "primeape");
    assert.equal(pricingSearchName("Kingdra Reverse Holofoil"), "kingdra");
    assert.equal(pricingSearchName("Dark Espeon Non-Holo"), "dark espeon");
});

test("provider lookup for Unown A retains exact card-number selection", async t => {
    const previous = process.env.PKMNPRICES_API_KEY; process.env.PKMNPRICES_API_KEY = "offline-test";
    t.after(() => { if (previous === undefined) delete process.env.PKMNPRICES_API_KEY; else process.env.PKMNPRICES_API_KEY = previous; });
    t.mock.method(fs, "readFile", async () => { throw new Error("offline cache miss"); });
    t.mock.method(fs, "writeFile", async () => {}); t.mock.method(fs, "mkdir", async () => undefined);
    t.mock.method(fs, "rename", async () => {}); t.mock.method(fs, "rm", async () => {});
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
