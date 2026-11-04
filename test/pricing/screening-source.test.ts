import "../fixtures/isolated-data.ts";
import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { DATA_DIR } from "../../server/lib/paths.ts";
import { readCache, writeCache } from "../../server/lib/cache.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import { createScreeningPriceSource, fetchComps, ScreeningPriceBudgetError, lookupCards } from "../../server/pricing/pkmnprices.ts";
import { createSoldScreening } from "../../server/pricing/screening-sales.ts";
import type { CardRecord, Comp } from "../../server/pricing/types.ts";
import type { ListingSummary, SearchIntent } from "../../shared/types.ts";
import { PRICE_SCREEN_REQUEST_LIMIT } from "../../shared/research-policy.ts";

let clock = Date.now();
function offline(t: { after(run: () => void): void; mock: { method(...args: any[]): unknown } }) {
    const values = { POKEMON_FLIPPER_STORAGE: "file", PKMNPRICES_API_KEY: "offline-screening-test" };
    for (const [key, value] of Object.entries(values)) {
        const previous = process.env[key]; process.env[key] = value;
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    }
    clock += 5_000_000;
    t.mock.method(Date, "now", () => { clock += 2000; return clock; });
}
const gradedPath = (id: number, grader = "PSA", grade: number | string = 8, variant = "Unlimited Holofoil") =>
    `/cards/${id}/listings/ebay?${new URLSearchParams({ graded: "true", grader, grade: String(grade), limit: "20", sort: "date_desc", period: "180d", variant })}`;
const rawPath = (id: number, variant = "Unlimited Holofoil") =>
    `/cards/${id}/listings/ebay?${new URLSearchParams({ graded: "false", period: "90d", sort: "date_desc", limit: "20", variant })}`;
const sale = (id: number, currency = "USD") => ({ id, currency, title: "offline sale", price: 100 });
const requestPath = (input: unknown) => {
    const url = new URL(String(input)); assert.equal(url.origin, "https://api.pkmnprices.com");
    return url.pathname.replace(/^\/v1/, "") + url.search;
};
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(accept => { resolve = accept; });
    return { promise, resolve };
}

test("screening uses canonical first-page sold URLs, exact half grades and no cursor follow-up", async t => {
    offline(t);
    const paths: string[] = [];
    t.mock.method(globalThis, "fetch", async input => {
        paths.push(requestPath(input));
        return Response.json({ data: [sale(1), sale(2, "EUR")], pagination: { has_more: true, next_cursor: "do-not-fetch" } });
    });
    const source = createScreeningPriceSource();
    assert.deepEqual(await source.fetchComps(81001, { grader: "CGC", grade: "8.5", variant: "Unlimited Holofoil" }), [sale(1)]);
    assert.deepEqual(await source.fetchRawComps(81001, "Unlimited Holofoil"), [sale(1)]);
    assert.deepEqual(paths, [gradedPath(81001, "CGC", "8.5"), rawPath(81001)]);
    assert.deepEqual(source.stats(), { requests: 2, limit: PRICE_SCREEN_REQUEST_LIMIT });
});

test("existing catalog and sold pages stay usable with zero new-request allowance", async t => {
    offline(t);
    const item = { id: 82002, name: "Lugia", number: "9", total_set_number: "111", set: { name: "Neo Genesis" }, prices: [] };
    await writeCache("pkmnprices:/sets?name=Genesis&language=English&per_page=50", { data: [{ id: 82001, name: "Neo Genesis" }] });
    await writeCache("pkmnprices:/cards?set_id=82001&name=lugia&per_page=20", { data: [item] });
    await writeCache("pkmnprices:/cards/82002?currency=usd", item);
    await writeCache(`pkmnprices:${gradedPath(82002)}`, { data: [sale(1)] });
    await writeCache(`pkmnprices:${rawPath(82002)}`, { data: [sale(2)] });
    t.mock.method(globalThis, "fetch", async () => { throw new Error("Saved provider responses must not be purchased again"); });
    const source = createScreeningPriceSource({ maxRequests: 0 });
    assert.equal((await source.lookupCards({ set: "Neo Genesis", name: "Lugia", cardNumber: "9/111" }))[0]?.id, 82002);
    assert.equal((await source.fetchComps(82002, { grader: "PSA", grade: 8, variant: "Unlimited Holofoil" })).length, 1);
    assert.equal((await source.fetchRawComps(82002, "Unlimited Holofoil")).length, 1);
    assert.deepEqual(source.stats(), { requests: 0, limit: 0 });
});

test("screening reuses cached final-valuation pages when the first page has no confirmed match", async t => {
    offline(t);
    const id = 82102;
    const sold = (saleId: number): Comp => ({ id: saleId, title: "Dragonite Fossil 4/62 Unlimited Holo PSA 8", price: 100 + saleId,
        sold_at: new Date(clock - 86_400_000).toISOString(), variant: "Unlimited Holofoil", grader: "PSA", grade: "8", currency: "USD",
        sale_type: "fixed_price", grade_qualifier: null, attribution: "exact", listing_url: `https://www.ebay.com/itm/${saleId}` });
    const first = [{ ...sold(1), sale_type: null }, { ...sold(2), sale_type: null }], next = [first[0], sold(3), sold(4)];
    const paths: string[] = [];
    t.mock.method(globalThis, "fetch", async input => {
        const requested = requestPath(input); paths.push(requested);
        assert.ok(paths.length <= 2, "saved sold pages must not buy a replacement request");
        return Response.json(requested.includes("cursor=") ? { data: next, pagination: { has_more: true, next_cursor: "unneeded-third" } }
            : { data: first, pagination: { has_more: true, next_cursor: "saved-second" } });
    });
    assert.equal((await fetchComps(id, { grader: "PSA", grade: 8, variant: "Unlimited Holofoil" })).length, 4);
    const source = createScreeningPriceSource({ maxRequests: 0 });
    const record: CardRecord = { source: "pkmnprices", id, name: "Dragonite", setName: "Fossil", cardNumber: "4/62", tcgPlayerId: null,
        variants: [{ name: "Unlimited Holofoil", printing: "UNLIMITED", finish: "HOLO", prices: [] }] };
    const subject: ListingSummary = { id: "saved-row", title: "Dragonite Fossil 4/62 Unlimited Holo PSA 8", isGraded: true,
        currentPrice: 150, shipping: 0, bids: 0, buyingOption: "FIXED_PRICE", endTime: null, images: [], url: "https://www.ebay.com/itm/123", seller: null };
    const intent: SearchIntent = { cardName: "Dragonite", sets: ["Fossil"], cardNumber: "4/62", printing: null, graded: true, titleWords: ["dragonite"], source: "rules" };
    const run = createSoldScreening({ now: () => clock, source: { ...source, lookupCards: async () => [record] } });
    const result = await run(subject, intent);
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, true); assert.equal(result.references[0].summary.count, 2);
    assert.deepEqual(paths, [gradedPath(id), `${gradedPath(id)}&cursor=saved-second`]);
    assert.deepEqual(source.stats(), { requests: 0, limit: 0 });
});

test("cursor pages use canonical half-grade and raw URLs under the same source allowance", async t => {
    offline(t);
    const paths: string[] = [];
    t.mock.method(globalThis, "fetch", async input => { paths.push(requestPath(input)); return Response.json({ data: [sale(paths.length)] }); });
    const source = createScreeningPriceSource({ maxRequests: 2 });
    await source.fetchSoldPage(82202, { grader: "CGC", grade: "8.5", variant: "Unlimited Holofoil", cursor: "next graded" });
    await source.fetchSoldPage(82202, { grader: null, grade: null, variant: "Unlimited Holofoil", cursor: "next raw" });
    await assert.rejects(source.fetchSoldPage(82203, { grader: null, grade: null, variant: "Unlimited Holofoil" }), ScreeningPriceBudgetError);
    assert.deepEqual(paths, [`${gradedPath(82202, "CGC", "8.5")}&cursor=next+graded`, `${rawPath(82202)}&cursor=next+raw`]);
    assert.deepEqual(source.stats(), { requests: 2, limit: 2 });
    await source.fetchSoldPage(82202, { grader: null, grade: null, variant: "Unlimited Holofoil", cursor: "next raw" });
    assert.equal(paths.length, 2, "cached cursor pages remain readable after the request limit");
});

test("catalog and sold misses share one allowance while cached work continues after exhaustion", async t => {
    offline(t);
    const item = { id: 83002, name: "Espeon", number: "1", total_set_number: "75", set: { name: "Neo Discovery" }, prices: [] };
    const paths: string[] = [];
    t.mock.method(globalThis, "fetch", async input => {
        const requested = requestPath(input); paths.push(requested);
        if (requested.startsWith("/sets?")) return Response.json({ data: [{ id: 83001, name: "Neo Discovery" }] });
        if (requested.startsWith("/cards?")) return Response.json({ data: [item] });
        throw new Error("Only the first two cache misses may dispatch");
    });
    const source = createScreeningPriceSource({ maxRequests: 2 });
    const query = { set: "Neo Discovery", name: "Espeon", cardNumber: "1/75" };
    await assert.rejects(source.lookupCards(query), ScreeningPriceBudgetError);
    assert.equal(paths.length, 2); assert.deepEqual(source.stats(), { requests: 2, limit: 2 });
    await writeCache("pkmnprices:/cards/83002?currency=usd", item);
    await writeCache(`pkmnprices:${rawPath(83002)}`, { data: [sale(3)] });
    assert.equal((await source.lookupCards(query)).length, 1);
    assert.equal((await source.fetchRawComps(83002, "Unlimited Holofoil")).length, 1);
    await assert.rejects(source.fetchComps(83002, { grader: "PSA", grade: 8 }), ScreeningPriceBudgetError);
    assert.equal(paths.length, 2);
});

test("screening without a collector number loads at most four exact-name card details", async t => {
    offline(t);
    const item = (id: number, name = "Charizard") => ({ id, name, number: String(id - 89000), total_set_number: "165", set: { name: "Expedition" }, prices: [] });
    const items = [item(89001, "Dark Charizard"), ...Array.from({ length: 8 }, (_, index) => item(89002 + index))];
    await writeCache("pkmnprices:/sets?name=Expedition&language=English&per_page=50", { data: [{ id: 89000, name: "Expedition" }] });
    await writeCache("pkmnprices:/cards?set_id=89000&name=charizard&per_page=20", { data: items });
    const paths: string[] = [];
    t.mock.method(globalThis, "fetch", async input => {
        const requested = requestPath(input); paths.push(requested);
        const id = Number(new URL(String(input)).pathname.split("/").at(-1));
        assert.ok(id >= 89002 && id <= 89005);
        return Response.json(item(id));
    });
    const source = createScreeningPriceSource();
    const result = await source.lookupCards({ set: "Expedition", name: "Charizard", cardNumber: "" });
    assert.deepEqual(result.map(record => record.id), [89002, 89003, 89004, 89005]);
    assert.equal(paths.length, 4); assert.deepEqual(source.stats(), { requests: 4, limit: PRICE_SCREEN_REQUEST_LIMIT });
    assert.deepEqual(await lookupCards({ set: "Expedition", name: "Charizard", cardNumber: "" }), [], "ordinary lookup semantics still require a collector-number match");
    assert.equal(paths.length, 4);
});

test("concurrent searches share a sold page and one stopped subscriber cannot cancel its other consumer", async t => {
    offline(t);
    const started = deferred<void>(), response = deferred<Response>();
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; started.resolve(); return response.promise; });
    const stopped = new AbortController(), useful = new AbortController();
    const a = createScreeningPriceSource({ signal: stopped.signal, maxRequests: 1 });
    const b = createScreeningPriceSource({ signal: useful.signal, maxRequests: 1 });
    const first = a.fetchRawComps(84001, "Unlimited Holofoil");
    const second = b.fetchRawComps(84001, "Unlimited Holofoil");
    const rejection = assert.rejects(first, /stop one search/);
    await started.promise; stopped.abort(new Error("stop one search"));
    response.resolve(Response.json({ data: [sale(4)] }));
    await rejection;
    assert.deepEqual(await second, [sale(4)]);
    assert.equal(requests, 1); assert.equal(a.stats().requests + b.stats().requests, 1);
    assert.deepEqual(await createScreeningPriceSource({ maxRequests: 0 }).fetchRawComps(84001, "Unlimited Holofoil"), [sale(4)]);
});

test("stop before dispatch blocks queued requests without consuming their allowance", async t => {
    offline(t);
    const bothStarted = deferred<void>(), response = deferred<Response>();
    const paths: string[] = [];
    t.mock.method(globalThis, "fetch", async input => {
        paths.push(requestPath(input)); if (paths.length === 2) bothStarted.resolve();
        return response.promise;
    });
    const occupying = createScreeningPriceSource({ maxRequests: 2 });
    const active = [occupying.fetchRawComps(85001, "Unlimited Holofoil"), occupying.fetchRawComps(85002, "Unlimited Holofoil")];
    await bothStarted.promise;
    const controller = new AbortController();
    const queued = createScreeningPriceSource({ signal: controller.signal, maxRequests: 1 });
    const pending = queued.fetchRawComps(85003, "Unlimited Holofoil");
    const rejection = assert.rejects(pending, /stop queued/);
    await setImmediate(); controller.abort(new Error("stop queued"));
    await rejection; response.resolve(Response.json({ data: [sale(5)] }));
    await Promise.all(active); await setImmediate();
    assert.equal(paths.length, 2); assert.deepEqual(queued.stats(), { requests: 0, limit: 1 });
});

test("an accepted response still saves after its final subscriber stops", async t => {
    offline(t);
    const started = deferred<void>(), response = deferred<Response>();
    t.mock.method(globalThis, "fetch", async () => { started.resolve(); return response.promise; });
    const controller = new AbortController();
    const source = createScreeningPriceSource({ signal: controller.signal });
    const result = source.fetchRawComps(86001, "Unlimited Holofoil");
    const rejection = assert.rejects(result, /stop accepted/);
    await started.promise; controller.abort(new Error("stop accepted")); await rejection;
    response.resolve(Response.json({ data: [sale(6)] }));
    let stored: { data: unknown[] } | null = null;
    for (let attempt = 0; attempt < 100 && !stored; attempt++) {
        await setImmediate(); stored = await readCache(`pkmnprices:${rawPath(86001)}`, 6);
    }
    assert.deepEqual(stored?.data, [sale(6)]); assert.equal(source.stats().requests, 1);
});

test("storage failures do not become new provider requests", async t => {
    offline(t);
    const requested = rawPath(87001), key = `pkmnprices:${requested}`;
    const file = path.join(DATA_DIR, "price-cache", `${createHash("sha1").update(key).digest("hex")}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "not valid JSON");
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("No replacement work"); });
    const source = createScreeningPriceSource();
    await assert.rejects(source.fetchRawComps(87001, "Unlimited Holofoil"), StorageUnavailableError);
    assert.equal(requests, 0); assert.equal(source.stats().requests, 0);
});

test("rate limits make one attempt and preserve cached reads without automatic retries", async t => {
    offline(t);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ error: { code: "rate_limit", message: "Wait" } }, { status: 429, headers: { "retry-after": "60" } }); });
    const source = createScreeningPriceSource();
    await assert.rejects(source.fetchRawComps(88001, "Unlimited Holofoil"), /rate limited/);
    assert.equal(requests, 1); assert.equal(source.stats().requests, 1);
    await writeCache(`pkmnprices:${rawPath(88002)}`, { data: [sale(8)] });
    assert.deepEqual(await source.fetchRawComps(88002, "Unlimited Holofoil"), [sale(8)]);
    assert.equal(requests, 1);
});

test("invalid screening allowances fail before any work", () => {
    for (const maxRequests of [-1, NaN, Infinity, 1.5]) assert.throws(() => createScreeningPriceSource({ maxRequests }), RangeError);
});
