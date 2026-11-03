import "../fixtures/isolated-data.ts";
import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "../../server/lib/paths.ts";
import { writeCache } from "../../server/lib/cache.ts";
import { lookupCards } from "../../server/pricing/pkmnprices.ts";
import { setSearchTerm } from "../../server/identity/card-identity.ts";

let clock = Date.now();
function offline(t: { after(run: () => void): void; mock: { method(...args: any[]): unknown } }) {
    const values = { POKEMON_FLIPPER_STORAGE: "file", PKMNPRICES_API_KEY: "offline-query-test" };
    for (const [key, value] of Object.entries(values)) {
        const previous = process.env[key]; process.env[key] = value;
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    }
    clock += 1000_000;
    t.mock.method(Date, "now", () => { clock += 2000; return clock; });
}
const setsPath = (name: string) => `/sets?${new URLSearchParams({ name: setSearchTerm(name), language: "English", per_page: "50" })}`;
const listPath = (id: number, name: string) => `/cards?${new URLSearchParams({ set_id: String(id), name, per_page: "20" })}`;
const detail = (id: number, name: string, number: string, total: string | null, set: string) => ({ id, name, number, total_set_number: total, set: { name: set }, prices: [] });

test("numeric catalog queries use documented number filters while preserving set families and exact local matching", async t => {
    offline(t);
    await writeCache(`pkmnprices:${setsPath("Base Set")}`, { data: [{ id: 101, name: "Base Set" }, { id: 102, name: "Base Set Shadowless" }] });
    const urls: URL[] = [];
    t.mock.method(globalThis, "fetch", async input => {
        const url = new URL(String(input)); urls.push(url);
        if (url.pathname === "/v1/cards") {
            const set = Number(url.searchParams.get("set_id"));
            return Response.json({ data: [{ id: set, name: "Charizard", number: "004", total_set_number: "102" },
                { id: 9991, name: "Charizard", number: "4", total_set_number: "130" }, { id: 9992, name: "Charizard", number: "5", total_set_number: "102" }] });
        }
        const id = Number(url.pathname.split("/").at(-1));
        assert.ok([101, 102].includes(id), "wrong-number or wrong-total cards must not fetch detail");
        return Response.json(detail(id, "Charizard", "4", "102", id === 101 ? "Base Set" : "Base Set Shadowless"));
    });
    const cards = await lookupCards({ set: "Base Set", name: "Charizard", cardNumber: "#004 / 102" });
    assert.equal(cards.length, 2);
    const lists = urls.filter(url => url.pathname === "/v1/cards");
    assert.equal(lists.length, 2);
    for (const url of lists) {
        assert.equal(url.searchParams.get("number"), "4"); assert.equal(url.searchParams.get("name"), "charizard");
        assert.equal(url.searchParams.get("per_page"), "20");
        for (const unused of ["limit", "search", "min_price", "total_set_number"]) assert.equal(url.searchParams.get(unused), null);
    }
});

test("legacy broader cached catalog lists are reused without buying the new narrower query", async t => {
    offline(t);
    await writeCache(`pkmnprices:${setsPath("Base Set")}`, { data: [{ id: 201, name: "Base Set" }] });
    await writeCache(`pkmnprices:${listPath(201, "blastoise")}`, { data: [{ id: 202, name: "Blastoise", number: "2", total_set_number: "102" }, { id: 203, name: "Blastoise", number: "9", total_set_number: "102" }] });
    await writeCache("pkmnprices:/cards/202?currency=usd", detail(202, "Blastoise", "2", "102", "Base Set"));
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Cached paid catalog data must be reused"); });
    const cards = await lookupCards({ set: "Base Set", name: "Blastoise", cardNumber: "2/102" });
    assert.equal(cards.length, 1); assert.equal(cards[0]!.id, 202); assert.equal(calls, 0);
});

test("broader cached empty searches retain their five-minute cooldown before a numeric lookup", async t => {
    offline(t);
    await writeCache(`pkmnprices:${setsPath("Neo Genesis")}`, { data: [{ id: 301, name: "Neo Genesis" }] });
    const key = `pkmnprices:${listPath(301, "lugia")}`;
    const file = path.join(DATA_DIR, "price-cache", `${createHash("sha1").update(key).digest("hex")}.json`);
    await fs.writeFile(file, JSON.stringify({ key, savedAt: new Date(Date.now() - 60_000).toISOString(), data: { data: [] } }));
    let calls = 0;
    t.mock.method(globalThis, "fetch", async input => {
        calls++;
        const url = new URL(String(input));
        assert.equal(url.searchParams.get("number"), "9");
        return Response.json({ data: [{ id: 302, name: "Lugia", number: "9", total_set_number: "111" }] });
    });
    assert.deepEqual(await lookupCards({ set: "Neo Genesis", name: "Lugia", cardNumber: "9/111" }), []);
    assert.equal(calls, 0);
    await fs.writeFile(file, JSON.stringify({ key, savedAt: new Date(Date.now() - 6 * 60_000).toISOString(), data: { data: [] } }));
    await writeCache("pkmnprices:/cards/302?currency=usd", detail(302, "Lugia", "9", "111", "Neo Genesis"));
    assert.equal((await lookupCards({ set: "Neo Genesis", name: "Lugia", cardNumber: "9/111" })).length, 1);
    assert.equal(calls, 1);
});

test("prefixed gallery numbers retain existing lookup behavior instead of inventing provider filtering rules", async t => {
    offline(t);
    await writeCache(`pkmnprices:${setsPath("Crown Zenith")}`, { data: [{ id: 401, name: "Crown Zenith" }] });
    await writeCache("pkmnprices:/cards/402?currency=usd", detail(402, "Pikachu", "TG05", "TG30", "Crown Zenith"));
    t.mock.method(globalThis, "fetch", async input => {
        const url = new URL(String(input));
        assert.equal(url.pathname, "/v1/cards"); assert.equal(url.searchParams.get("number"), null);
        return Response.json({ data: [{ id: 402, name: "Pikachu", number: "TG05", total_set_number: "TG30" }] });
    });
    const cards = await lookupCards({ set: "Crown Zenith", name: "Pikachu", cardNumber: "TG05/TG30" });
    assert.equal(cards.length, 1); assert.equal(cards[0]!.cardNumber, "TG05/TG30");
});
