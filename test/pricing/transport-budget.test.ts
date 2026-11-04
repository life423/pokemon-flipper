import "../fixtures/isolated-data.ts";
import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createScreeningPriceSource, fetchComps, fetchRawComps, pricingCooldown } from "../../server/pricing/pkmnprices.ts";
import { priceResearchSummary, reservePriceRequest, withPriceResearchSignal, PriceResearchBudgetError, PRICE_RESEARCH_LIMIT } from "../../server/pricing/research-budget.ts";
import { getAiUsageContext, withAiUsageContext } from "../../server/ai/usage-context.ts";
import { readCache } from "../../server/lib/cache.ts";
import { PRICE_SCREEN_REQUEST_LIMIT } from "../../shared/research-policy.ts";

let clock = Date.now();
function offline(t: { after(run: () => void): void; mock: { method(...args: any[]): unknown } }) {
    const key = process.env.PKMNPRICES_API_KEY;
    process.env.PKMNPRICES_API_KEY = "offline-price-transport";
    t.after(() => { if (key === undefined) delete process.env.PKMNPRICES_API_KEY; else process.env.PKMNPRICES_API_KEY = key; });
    clock += 5_000_000;
    t.mock.method(Date, "now", () => { clock += 2000; return clock; });
}
const sold = (id: number) => ({ id, currency: "USD", title: "Offline actual-response fixture", price: 100 });
const response = (data: unknown, credits = 1) => Response.json(data, { headers: { "x-credits-charged": String(credits), "x-credits-limit": "20000", "x-credits-remaining": "19000" } });
const rawPath = (id: number) => `/cards/${id}/listings/ebay?${new URLSearchParams({ graded: "false", period: "90d", sort: "date_desc", limit: "20", variant: "Unlimited Holofoil" })}`;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
async function eventually<T>(read: () => Promise<T>, accepted: (value: T) => boolean): Promise<T> {
    for (let i = 0; i < 200; i++) { const value = await read(); if (accepted(value)) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error("Accepted offline response did not finish saving");
}

test("catalog, screening and final raw/slab requests share one ledger while cache reads stay free", async t => {
    offline(t); const paths: string[] = [];
    t.mock.method(globalThis, "fetch", async input => {
        const url = new URL(String(input)); paths.push(url.pathname);
        if (url.pathname === "/v1/sets") return response({ data: [{ id: 91, name: "Neo Discovery" }] });
        if (url.pathname === "/v1/cards") return response({ data: [{ id: 91001, name: "Espeon", number: "1", total_set_number: "75" }] });
        if (url.pathname === "/v1/cards/91001") return response({ id: 91001, name: "Espeon", number: "1", total_set_number: "75", set: { name: "Neo Discovery" }, prices: [{ currency: "USD", variant: "Unlimited Holofoil", condition: "Near Mint", market_price: 100 }] });
        const graded = url.searchParams.get("graded") === "true";
        return response({ data: graded ? [sold(1), sold(2)] : [sold(1), sold(2), sold(3)] }, graded ? 2 : 3);
    });
    const source = createScreeningPriceSource();
    assert.equal((await source.lookupCards({ name: "Espeon", set: "Neo Discovery", cardNumber: "1/75" })).length, 1);
    await source.fetchRawComps(91001, "Unlimited Holofoil");
    await fetchComps(91001, { grader: "PSA", grade: "8", variant: "Unlimited Holofoil" });
    await fetchRawComps(91001, "Unlimited Holofoil");
    await source.fetchRawComps(91001, "Unlimited Holofoil");
    const usage = await priceResearchSummary();
    assert.equal(paths.length, 5); assert.equal(usage?.used, 5); assert.equal(usage?.completed, 5);
    assert.equal(usage?.reportedCredits, 8); assert.equal(usage?.returnedRows, 8);
    assert.deepEqual(source.stats(), { requests: 4, limit: PRICE_SCREEN_REQUEST_LIMIT });
});

test("simultaneous preliminary and final reads share one exact sold-page attempt even with no preliminary allowance", async t => {
    offline(t); let calls = 0, started = deferred<void>(), answer = deferred<Response>();
    t.mock.method(globalThis, "fetch", async () => { calls++; started.resolve(); return answer.promise; });
    for (const [index, [screeningFirst, maximum]] of ([[true, 1], [false, 1], [true, 0]] as const).entries()) {
        started = deferred<void>(); answer = deferred<Response>();
        const source = createScreeningPriceSource({ maxRequests: maximum });
        const id = 91100 + index;
        const preliminary = () => source.fetchRawComps(id, "Unlimited Holofoil");
        const final = () => fetchRawComps(id, "Unlimited Holofoil");
        const work = screeningFirst ? [preliminary(), final()] : [final(), preliminary()];
        await started.promise;
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(calls, index + 1, "overlapping stages may not purchase the same page twice");
        answer.resolve(response({ data: [sold(1)] }));
        assert.deepEqual((await Promise.all(work)).map(sales => sales.length), [1, 1]);
        assert.ok(source.stats().requests <= maximum);
        if (maximum === 0) assert.equal(source.stats().requests, 0);
    }
    const usage = await priceResearchSummary();
    assert.equal(usage?.used, 3); assert.equal(usage?.completed, 3);
});

test("new searches allow64 screening misses while preserving the separate128-request total", async t => {
    offline(t); let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return response({ data: [sold(calls)] }); });
    const source = createScreeningPriceSource();
    for (let index = 0; index < PRICE_SCREEN_REQUEST_LIMIT; index++) await source.fetchRawComps(91500 + index, "Unlimited Holofoil");
    await assert.rejects(source.fetchRawComps(91600, "Unlimited Holofoil"), /price-screening request allowance is exhausted/);
    assert.equal(calls, PRICE_SCREEN_REQUEST_LIMIT);
    assert.equal((await source.fetchRawComps(91500, "Unlimited Holofoil")).length, 1, "screening cache hits stay usable at its limit");
    assert.deepEqual(source.stats(), { requests: PRICE_SCREEN_REQUEST_LIMIT, limit: PRICE_SCREEN_REQUEST_LIMIT });
    const beforeFinal = await priceResearchSummary();
    assert.equal(beforeFinal?.limit, PRICE_RESEARCH_LIMIT); assert.equal(beforeFinal?.used, PRICE_SCREEN_REQUEST_LIMIT);
    await fetchComps(91600, { grader: "PSA", grade: 8, variant: "Unlimited Holofoil" });
    assert.equal(calls, PRICE_SCREEN_REQUEST_LIMIT + 1, "final research can still use the shared total's remaining requests");
    assert.equal((await priceResearchSummary())?.remaining, PRICE_RESEARCH_LIMIT - PRICE_SCREEN_REQUEST_LIMIT - 1);
});

test("sharing the first page retains final pagination without extending preliminary screening", async t => {
    offline(t); const started = deferred<void>(), first = deferred<Response>(); const cursors: (string | null)[] = [];
    t.mock.method(globalThis, "fetch", async input => {
        const cursor = new URL(String(input)).searchParams.get("cursor"); cursors.push(cursor);
        if (!cursor) { started.resolve(); return first.promise; }
        assert.equal(cursor, "second-page"); return response({ data: [sold(2)] });
    });
    const source = createScreeningPriceSource();
    const preliminary = source.fetchRawComps(91150, "Unlimited Holofoil");
    // Establish the sponsor before the second subscriber races through its
    // asynchronous cache read. Otherwise either stage may correctly pay for
    // the shared first page, making the exact preliminary count nondeterministic.
    await started.promise;
    const final = fetchRawComps(91150, "Unlimited Holofoil");
    first.resolve(response({ data: [sold(1)], pagination: { has_more: true, next_cursor: "second-page" } }));
    assert.equal((await preliminary).length, 1); assert.equal((await final).length, 2);
    assert.deepEqual(cursors, [null, "second-page"]);
    assert.equal(source.stats().requests, 1); assert.equal((await priceResearchSummary())?.used, 2);
});

test("a shared throttle lets normal pricing retry without retrying its preliminary subscriber", async t => {
    offline(t); const started = deferred<void>(), first = deferred<Response>(); let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
        if (++calls === 1) { started.resolve(); return first.promise; }
        return response({ data: [sold(2)] });
    });
    const source = createScreeningPriceSource({ maxRequests: 1 });
    const preliminary = assert.rejects(source.fetchRawComps(91200, "Unlimited Holofoil"), /screening will not retry/);
    const final = fetchRawComps(91200, "Unlimited Holofoil");
    await started.promise;
    first.resolve(Response.json({ error: { limit_type: "per_minute" } }, { status: 429, headers: { "retry-after": "0.001", "x-credits-charged": "0" } }));
    await preliminary;
    assert.equal((await final).length, 1);
    assert.equal(calls, 2); assert.equal(source.stats().requests, 1);
    assert.equal((await priceResearchSummary())?.used, 2);
});

test("a stopped normal subscriber leaves screening with no hidden retry", async t => {
    offline(t); const stopped = new AbortController(), started = deferred<void>(), answer = deferred<Response>(); let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; started.resolve(); return answer.promise; });
    const source = createScreeningPriceSource();
    const normal = withPriceResearchSignal(stopped.signal, () => fetchRawComps(91300, "Unlimited Holofoil"));
    const preliminary = assert.rejects(source.fetchRawComps(91300, "Unlimited Holofoil"), /screening will not retry/);
    const cancelled = assert.rejects(normal, { name: "AbortError" });
    await started.promise; stopped.abort(); await cancelled;
    answer.resolve(Response.json({ error: { limit_type: "per_minute" } }, { status: 429, headers: { "retry-after": "0.001" } }));
    await preliminary;
    assert.equal(calls, 1); assert.equal((await priceResearchSummary())?.used, 1);
});

test("an accepted daily throttle still records its cooldown after every subscriber stops", async t => {
    offline(t); const stopped = new AbortController(), started = deferred<void>(), answer = deferred<Response>();
    const fetch = t.mock.method(globalThis, "fetch", async () => { started.resolve(); return answer.promise; });
    const work = withPriceResearchSignal(stopped.signal, () => fetchRawComps(91400, "Unlimited Holofoil"));
    const cancelled = assert.rejects(work, { name: "AbortError" });
    await started.promise; stopped.abort(); await cancelled;
    answer.resolve(Response.json({ error: { limit_type: "daily" } }, { status: 429, headers: { "x-credits-charged": "0" } }));
    await eventually(async () => pricingCooldown(), value => value?.kind === "CREDITS");
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal((await priceResearchSummary())?.completed, 1);
});

test("the total allowance applies after screening and still permits a cached page at exhaustion", async t => {
    offline(t);
    for (let i = 0; i < PRICE_RESEARCH_LIMIT - 1; i++) await (await reservePriceRequest(`/cards/prior-${i}?currency=usd`)).unresolved();
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return response({ data: [sold(1)] }, 3); });
    const source = createScreeningPriceSource();
    await source.fetchRawComps(92001, "Unlimited Holofoil");
    await assert.rejects(fetchComps(92001, { grader: "PSA", grade: "9" }), error => error instanceof PriceResearchBudgetError && error.reason === "LIMIT");
    assert.equal((await fetchRawComps(92001, "Unlimited Holofoil")).length, 1);
    assert.equal(calls, 1); assert.equal((await priceResearchSummary())?.used, PRICE_RESEARCH_LIMIT);
});

test("unscoped uncached normal and screening requests fail closed before transport", async t => {
    offline(t);
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("unscoped requests cannot dispatch"));
    await withAiUsageContext({ searchId: undefined }, async () => {
        await assert.rejects(fetchRawComps(93001, "Unlimited Holofoil"), error => error instanceof PriceResearchBudgetError && error.reason === "SCOPE");
        await assert.rejects(createScreeningPriceSource().fetchRawComps(93002, "Unlimited Holofoil"), error => error instanceof PriceResearchBudgetError && error.reason === "SCOPE");
    });
    assert.equal(fetch.mock.callCount(), 0); assert.equal((await priceResearchSummary())?.used, 0);
});

test("rate-limit retries count separately and provider credits are not inferred from returned rows", async t => {
    offline(t); let calls = 0;
    t.mock.method(globalThis, "fetch", async () => ++calls === 1
        ? Response.json({ error: { code: "RATE_LIMIT", limit_type: "per_minute", message: "Credit request rate exceeded" } }, { status: 429, headers: { "retry-after": "0.001", "x-credits-charged": "0" } })
        : Response.json({ data: [sold(1), sold(2)] }));
    await fetchRawComps(94001, "Unlimited Holofoil");
    const usage = await priceResearchSummary();
    assert.equal(calls, 2); assert.equal(usage?.used, 2); assert.equal(usage?.completed, 2);
    assert.equal(usage?.reportedCredits, 0); assert.equal(usage?.unreportedCreditAttempts, 1); assert.equal(usage?.returnedRows, 2);
});

test("a documented daily quota response stops normal retries even without credit wording", async t => {
    offline(t);
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "RATE_LIMIT_EXCEEDED", limit_type: "daily", message: "Daily limit reached" } }, { status: 429 }));
    await assert.rejects(fetchRawComps(94101, "Unlimited Holofoil"), error => (error as { kind?: string }).kind === "CREDITS");
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal((await priceResearchSummary())?.completed, 1);
});

test("preliminary screening recognizes documented daily quota separately from a per-minute throttle", async t => {
    offline(t);
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ error: { limit_type: "daily" } }, { status: 429 }));
    await assert.rejects(createScreeningPriceSource().fetchRawComps(94201, "Unlimited Holofoil"), error => (error as { kind?: string }).kind === "CREDITS");
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal((await priceResearchSummary())?.completed, 1);
});

test("a failed transport retains its unknown reservation and makes no automatic retry", async t => {
    offline(t);
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new TypeError("offline connection lost"); });
    await assert.rejects(fetchRawComps(95001, "Unlimited Holofoil"), /connection lost/);
    const usage = await priceResearchSummary();
    assert.equal(fetch.mock.callCount(), 1); assert.equal(usage?.used, 1); assert.equal(usage?.unresolved, 1);
    assert.equal(usage?.unreportedCreditAttempts, 1); assert.equal(usage?.returnedRows, 0);
});

test("Stop during retry backoff starts no later transport while the accepted response is accounted", async t => {
    offline(t); const stopped = new AbortController(), completionVisible = deferred<void>(), finishCompletion = deferred<void>(); let calls = 0;
    const rename = fs.rename.bind(fs);
    t.mock.method(fs, "rename", async (from: string, to: string) => {
        await rename(from, to);
        if (calls && String(to).includes("price-research-budgets")) {
            completionVisible.resolve();
            await finishCompletion.promise;
        }
    });
    t.mock.method(globalThis, "fetch", async () => { calls++; stopped.abort(); return Response.json({ error: { code: "RATE_LIMIT" } }, { status: 429, headers: { "retry-after": "5", "x-credits-charged": "0" } }); });
    await assert.rejects(withPriceResearchSignal(stopped.signal, () => fetchRawComps(96001, "Unlimited Holofoil")), { name: "AbortError" });
    await completionVisible.promise;
    const usage = await priceResearchSummary();
    assert.equal(usage?.completed, 1);
    assert.equal(pricingCooldown(), null, "durable accounting alone is not a barrier for the detached response's cooldown");
    assert.equal(calls, 1); assert.equal(usage?.used, 1);
    // The completed ledger can be read before its lock cleanup returns and
    // the detached accepted response records its provider cooldown. Keep this
    // test's clock installed until that response finishes its last state change;
    // otherwise it can apply the old 429 under the following test's clock.
    finishCompletion.resolve();
    await eventually(async () => pricingCooldown(), value => value?.kind === "RATE_LIMIT");
});

test("a normal accepted response saves and settles after its final consumer stops", async t => {
    offline(t); const stopped = new AbortController(), started = deferred<void>(), answer = deferred<Response>();
    t.mock.method(globalThis, "fetch", async () => { started.resolve(); return answer.promise; });
    const work = withPriceResearchSignal(stopped.signal, () => fetchRawComps(97001, "Unlimited Holofoil"));
    await started.promise; stopped.abort(); await assert.rejects(work, { name: "AbortError" });
    answer.resolve(response({ data: [sold(7)] }, 4));
    const cached = await eventually(() => readCache<{ data: unknown[] }>(`pkmnprices:${rawPath(97001)}`, 6), value => value?.data.length === 1);
    assert.equal(cached?.data.length, 1);
    const usage = await priceResearchSummary(); assert.equal(usage?.used, 1); assert.equal(usage?.completed, 1); assert.equal(usage?.reportedCredits, 4);
});

test("queued shared normal and screening requests charge the surviving search rather than their stopped leader", async t => {
    offline(t); let occupied = deferred<void>(), release = deferred<Response>(), holdingIds = new Set<string>();
    let holding = 0, targetRequests = 0;
    t.mock.method(globalThis, "fetch", async input => {
        const id = new URL(String(input)).pathname.split("/")[3];
        if (holdingIds.has(id)) { if (++holding === 2) occupied.resolve(); return (await release.promise).clone(); }
        targetRequests++; return response({ data: [sold(8)] }, 2);
    });
    const before = getAiUsageContext().searchId;
    for (const [index, [firstScreening, secondScreening]] of ([[false, false], [true, true], [false, true], [true, false]] as const).entries()) {
        occupied = deferred<void>(); release = deferred<Response>(); holding = 0;
        holdingIds = new Set([String(98001 + index * 10), String(98002 + index * 10)]);
        const holders = Promise.all([...holdingIds].map(id => fetchRawComps(Number(id), "Unlimited Holofoil")));
        await occupied.promise;
        const firstId = randomUUID(), secondId = randomUUID(), stopped = new AbortController();
        const run = (screening: boolean) => screening ? createScreeningPriceSource().fetchRawComps(98100 + index, "Unlimited Holofoil") : fetchRawComps(98100 + index, "Unlimited Holofoil");
        const first = withAiUsageContext({ searchId: firstId }, () => withPriceResearchSignal(stopped.signal, () => run(firstScreening)));
        const second = withAiUsageContext({ searchId: secondId }, () => run(secondScreening));
        await new Promise(resolve => setTimeout(resolve, 10));
        stopped.abort(); await assert.rejects(first, { name: "AbortError" });
        release.resolve(response({ data: [] }, 0));
        assert.equal((await second).length, 1);
        assert.equal((await priceResearchSummary(firstId))?.used, 0);
        assert.equal((await priceResearchSummary(secondId))?.used, 1);
        await holders;
    }
    assert.equal(targetRequests, 4); assert.equal(getAiUsageContext().searchId, before);
});

test("an accepted response remains cacheable when durable completion accounting fails", async t => {
    offline(t); let received = false;
    const rename = fs.rename.bind(fs);
    t.mock.method(fs, "rename", async (from: string, to: string) => {
        if (received && String(to).includes("price-research-budgets")) throw Object.assign(new Error("offline accounting disk failure"), { code: "EIO" });
        return rename(from, to);
    });
    t.mock.method(globalThis, "fetch", async () => { received = true; return response({ data: [sold(9)] }, 3); });
    await assert.rejects(fetchRawComps(99001, "Unlimited Holofoil"), error => error instanceof PriceResearchBudgetError && error.reason === "STORAGE");
    assert.equal((await readCache<{ data: unknown[] }>(`pkmnprices:${rawPath(99001)}`, 6))?.data.length, 1);
    const usage = await priceResearchSummary();
    assert.equal(usage?.used, 1); assert.equal(usage?.pending, 1); assert.equal(usage?.unreportedCreditAttempts, 1);
    assert.equal(pricingCooldown(), null, "accounting failures are not provider throttles or exhausted credits");
});

test("cancellation at the durable reservation boundary sends no transport", async t => {
    offline(t); const stopped = new AbortController();
    const rename = fs.rename.bind(fs);
    t.mock.method(fs, "rename", async (from: string, to: string) => {
        await rename(from, to);
        if (String(to).includes("price-research-budgets")) stopped.abort();
    });
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("a stopped reservation cannot dispatch"));
    await assert.rejects(withPriceResearchSignal(stopped.signal, () => fetchRawComps(99101, "Unlimited Holofoil")), { name: "AbortError" });
    assert.equal(fetch.mock.callCount(), 0);
});
