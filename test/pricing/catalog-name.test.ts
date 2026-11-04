import "../fixtures/isolated-data.ts";
import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import { writeCache } from "../../server/lib/cache.ts";
import { setSearchTerm } from "../../server/identity/card-identity.ts";
import { createScreeningPriceSource, lookupCards } from "../../server/pricing/pkmnprices.ts";

const setsPath = (set: string) => `/sets?${new URLSearchParams({ name: setSearchTerm(set), language: "English", per_page: "50" })}`;
const listPath = (setId: number, name: string) => `/cards?${new URLSearchParams({ set_id: String(setId), name, per_page: "20" })}`;
const detail = (id: number, name: string, number: string, total: string, set: string) =>
    ({ id, name, number, total_set_number: total, set: { name: set }, prices: [] });

test("saved real-shape catalog records survive descriptor-only differences in both lookup paths", async t => {
    const fixtures = [
        { setId: 51001, set: "Jungle", query: "Snorlax Holofoil", term: "snorlax", item: detail(51002, "Snorlax", "11", "64", "Jungle") },
        { setId: 503, set: "Evolving Skies", query: "Leafeon V", term: "leafeon v", item: detail(17178, "Leafeon V (Alternate Full Art)", "167", "203", "Evolving Skies") },
        { setId: 633, set: "Fusion Strike", query: "Mew VMAX", term: "mew vmax", item: detail(34436, "Mew VMAX (Alternate Art Secret)", "269", "264", "SWSH08: Fusion Strike") },
        { setId: 606, set: "Vivid Voltage", query: "Pikachu VMAX", term: "pikachu vmax", item: detail(27943, "Pikachu VMAX (Secret)", "188", "185", "SWSH04: Vivid Voltage") },
    ];
    for (const { setId, set, term, item } of fixtures) {
        await writeCache(`pkmnprices:${setsPath(set)}`, { data: [{ id: setId, name: set }] });
        await writeCache(`pkmnprices:${listPath(setId, term)}`, { data: [
            { ...item, id: item.id + 3, name: null },
            { ...item, id: item.id + 1, name: "Dark " + item.name },
            { ...item, id: item.id + 2, total_set_number: "999" }, item,
        ] });
        await writeCache(`pkmnprices:/cards/${item.id}?currency=usd`, item);
    }
    t.mock.method(globalThis, "fetch", async () => { throw new Error("Saved catalog matches must require no provider requests"); });
    const source = createScreeningPriceSource({ maxRequests: 0 });
    for (const { set, query: name, item } of fixtures) {
        const query = { set, name, cardNumber: `${item.number}/${item.total_set_number}` };
        assert.deepEqual((await source.lookupCards(query)).map(card => card.id), [item.id]);
        assert.deepEqual((await lookupCards(query)).map(card => card.id), [item.id]);
    }
    assert.deepEqual(source.stats(), { requests: 0, limit: 0 });
});

test("descriptor-only names do not dispatch an empty provider query", async t => {
    t.mock.method(globalThis, "fetch", async () => { throw new Error("Empty research names must not dispatch provider work"); });
    assert.deepEqual(await createScreeningPriceSource({ maxRequests: 0 }).lookupCards({ set: "Jungle", name: "Holofoil", cardNumber: "11/64" }), []);
    assert.deepEqual(await lookupCards({ set: "Jungle", name: "Holofoil", cardNumber: "11/64" }), []);
});

test("owner apostrophes remain intact in provider queries and exact catalog matching", async t => {
    const previous = process.env.PKMNPRICES_API_KEY;
    process.env.PKMNPRICES_API_KEY = "offline-owner-catalog-test";
    t.after(() => { if (previous === undefined) delete process.env.PKMNPRICES_API_KEY; else process.env.PKMNPRICES_API_KEY = previous; });
    const set = "Gym Challenge", setId = 52001;
    const item = detail(52002, "Blaine's Arcanine", "1", "132", set);
    await writeCache(`pkmnprices:${setsPath(set)}`, { data: [{ id: setId, name: set }] });
    await writeCache(`pkmnprices:${listPath(setId, "blaine s arcanine")}`, { data: [] });
    await writeCache(`pkmnprices:/cards/${item.id}?currency=usd`, item);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async input => {
        requests++;
        const url = new URL(String(input));
        assert.equal(url.pathname, "/v1/cards");
        assert.equal(url.searchParams.get("name"), "blaine's arcanine");
        assert.equal(url.searchParams.get("set_id"), String(setId));
        assert.equal(url.searchParams.get("number"), "1");
        return Response.json({ data: [
            { ...item, id: 52003, name: "Arcanine" },
            { ...item, id: 52004, name: "Blaine's Charizard" }, item,
        ] });
    });
    const source = createScreeningPriceSource();
    const cards = await source.lookupCards({ set, name: "Blaine’s Arcanine Holofoil", cardNumber: "1/132" });
    assert.deepEqual(cards.map(card => card.id), [item.id]);
    assert.deepEqual((await source.lookupCards({ set, name: "Blaine's Arcanine", cardNumber: "1/132" })).map(card => card.id), [item.id]);
    assert.equal(requests, 1);
});

test("positive legacy owner catalog lists remain reusable without dispatching the malformed query", async t => {
    const set = "Gym Challenge", setId = 54001;
    await writeCache(`pkmnprices:${setsPath(set)}`, { data: [{ id: setId, name: set }] });
    t.mock.method(globalThis, "fetch", async () => { throw new Error("Positive legacy owner evidence must remain reusable"); });
    const cases = [
        { item: detail(54002, "Erika's Venusaur", "4", "132", set), query: "Erika’s Venusaur", term: "erika s venusaur", numeric: false },
        { item: detail(54003, "Blaine's Arcanine", "1", "132", set), query: "Blaine's Arcanine Holofoil", term: "blaine s arcanine", numeric: true },
    ];
    for (const { item, query: name, term, numeric } of cases) {
        const legacy = listPath(setId, term) + (numeric ? `&number=${item.number}` : "");
        await writeCache(`pkmnprices:${legacy}`, { data: [
            { ...item, id: item.id + 10, name: "Dark " + item.name },
            { ...item, id: item.id + 11, total_set_number: "999" }, item,
        ] });
        await writeCache(`pkmnprices:/cards/${item.id}?currency=usd`, item);
        const query = { set, name, cardNumber: `${item.number}/${item.total_set_number}` };
        assert.deepEqual((await createScreeningPriceSource({ maxRequests: 0 }).lookupCards(query)).map(card => card.id), [item.id]);
        assert.deepEqual((await lookupCards(query)).map(card => card.id), [item.id]);
    }
});

test("detail responses must retain the requested catalog name, set family and collector number", async t => {
    const set = "Neo Discovery", setId = 53001;
    await writeCache(`pkmnprices:${setsPath(set)}`, { data: [{ id: setId, name: set }] });
    const item = detail(53002, "Unown [A]", "14", "75", set);
    await writeCache(`pkmnprices:${listPath(setId, "unown")}`, { data: [item] });
    t.mock.method(globalThis, "fetch", async () => { throw new Error("Wrong detail responses must not trigger recovery requests"); });
    const query = { set, name: "Unown A", cardNumber: "14/75" };
    for (const mismatch of [
        { name: "Unown [R]" }, { set: { name: "Neo Revelation" } }, { number: "40" }, { total_set_number: "111" },
    ]) {
        await writeCache(`pkmnprices:/cards/${item.id}?currency=usd`, { ...item, ...mismatch });
        assert.deepEqual(await createScreeningPriceSource({ maxRequests: 0 }).lookupCards(query), []);
        assert.deepEqual(await lookupCards(query), []);
    }
});
