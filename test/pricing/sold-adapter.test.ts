import "../fixtures/isolated-data.ts";
import { test } from "../fixtures/search-context.ts";
import type { TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createScreeningPriceSource, fetchComps, fetchRawComps } from "../../server/pricing/pkmnprices.ts";
import { createSoldScreening } from "../../server/pricing/screening-sales.ts";
import { rawPricesWithSales } from "../../server/pricing/raw-comps.ts";
import { compsForGrade } from "../../server/pricing/graded-comps.ts";
import { withPriceResearchSignal } from "../../server/pricing/research-budget.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import type { CardRecord, Comp, PricedCard, SoldPageSelection } from "../../server/pricing/types.ts";
import type { ListingSummary, SearchIntent } from "../../shared/types.ts";

const now = Date.parse("2026-11-04T12:00:00Z");
const identity = cardEvaluation().identity!;
const variant = "Unlimited Holofoil";
function offlineKey(t: TestContext) {
    const original = process.env.PKMNPRICES_API_KEY;
    process.env.PKMNPRICES_API_KEY = "offline-test-key";
    t.after(() => { if (original === undefined) delete process.env.PKMNPRICES_API_KEY; else process.env.PKMNPRICES_API_KEY = original; });
}
const sale = (id: string, extra: Partial<Comp> = {}): Comp => ({ id, title: "Venusaur Base Set 15/102 Unlimited Holo LP", price: 200,
    sold_at: "2026-11-03T12:00:00Z", variant, currency: "USD", attribution: "exact", sale_type: "fixed_price",
    listing_url: null, grader: null, grade: null, grade_qualifier: null, ...extra });
const card = (id: string): CardRecord => ({ source: "pkmnprices", id, name: "Venusaur", setName: "Base Set", cardNumber: "15/102", tcgPlayerId: null,
    variants: [{ name: variant, finish: "HOLO", printing: "UNLIMITED", prices: [{ condition: "LIGHTLY_PLAYED", price: 30, updatedAt: null }] }] });
function pricedCard(id: string): PricedCard {
    const record = card(id);
    return { source: record.source, name: record.name, cardNumber: record.cardNumber, records: [record],
        variants: [{ ...record.variants[0], recordId: id, setName: record.setName }] };
}
const adapted = (kind: "graded" | "raw", id: string, selection: SoldPageSelection) => kind === "graded"
    ? fetchComps(id, { grader: "PSA", grade: 8, variant, ...selection }) : fetchRawComps(id, variant, selection);

test("sold adapters bound pages, request recent sales and exclude non-USD rows before money math", async (t) => {
    const original = process.env.PKMNPRICES_API_KEY;
    process.env.PKMNPRICES_API_KEY = "offline-test-key";
    const calls: URL[] = [];
    t.mock.method(globalThis, "fetch", async (value: string) => {
        const url = new URL(value); calls.push(url);
        return Response.json({ data: [{ id: 1, currency: "USD", price: 100 }, { id: 2, currency: "EUR", price: 10 }], pagination: { has_more: true, next_cursor: "next-page", total_pages: 1 } });
    });
    const id = `offline-${Date.now()}-${Math.random()}`;
    try {
        const graded = await fetchComps(id, { grader: "PSA", grade: 8, variant: "Unlimited Holofoil" });
        assert.equal(graded.length, 1, "duplicate rows across graded pages are counted once"); assert.equal(graded[0].currency, "USD");
        assert.equal(calls[0].searchParams.get("period"), "180d");
        const raw = await fetchRawComps(id, "Unlimited Holofoil");
        assert.equal(raw.length, 2, "only two bounded pages even if the provider has more");
        assert.equal(calls.length, 4);
        assert.equal(calls[1].searchParams.get("cursor"), "next-page");
        assert.equal(calls[2].searchParams.get("period"), "90d");
        assert.equal(calls[3].searchParams.get("cursor"), "next-page");
    } finally { if (original === undefined) delete process.env.PKMNPRICES_API_KEY; else process.env.PKMNPRICES_API_KEY = original; }
});

test("a third-page match admitted by screening remains available to final raw and slab pricing entirely from cache", async t => {
    offlineKey(t);
    const calls: URL[] = [];
    t.mock.method(globalThis, "fetch", async (value: string) => {
        const url = new URL(value); calls.push(url);
        const page = Number(url.searchParams.get("cursor") ?? "1"), graded = url.searchParams.get("graded") === "true";
        assert.ok(page <= 3, "a matched market must not request another page");
        return Response.json({ data: [sale(`${graded ? "slab" : "raw"}-${page}`, {
            title: `${page === 3 ? "Venusaur Base Set 15/102" : "Charizard Base Set 4/102"} Unlimited Holo ${graded ? "PSA 8" : "LP"}`,
            grader: graded ? "PSA" : null, grade: graded ? "8" : null,
        })], pagination: { has_more: true, next_cursor: String(page + 1) } });
    });
    for (const kind of ["graded", "raw"] as const) {
        const id = randomUUID(), source = createScreeningPriceSource();
        const screen = createSoldScreening({ now: () => now, source: { ...source, lookupCards: async () => [card(id)] } });
        const subject: ListingSummary = { id: `screen-${kind}`, title: `Venusaur Base Set 15/102 Unlimited Holo ${kind === "graded" ? "PSA 8" : "LP"}`,
            currentPrice: 100, shipping: 0, bids: 0, isGraded: kind === "graded", buyingOption: "FIXED_PRICE", endTime: null,
            images: [], url: "https://www.ebay.com/itm/123456789012", seller: null };
        const intent: SearchIntent = { cardName: "Venusaur", sets: ["Base Set"], cardNumber: "15/102", printing: "UNLIMITED",
            graded: kind === "graded", titleWords: ["venusaur"], source: "rules" };
        const screened = await screen(subject, intent);
        assert.equal(screened.status, "AVAILABLE"); assert.equal(screened.references[0].summary.median, 200);
        assert.equal(source.stats().requests, 3);
        const beforeFinal = calls.length;
        if (kind === "graded") {
            const final = await compsForGrade(pricedCard(id), identity, { fetchComps, grader: "PSA", grade: 8, now });
            assert.equal(final.status, "PRICED"); assert.equal(final.summary?.count, 1); assert.equal(final.summary?.median, 200);
        } else {
            const final = await rawPricesWithSales(pricedCard(id), identity, { fetchRawComps, requestedCondition: "LIGHTLY_PLAYED", now,
                assessCondition: async source => source.id === "raw-3" ? { condition: "LIGHTLY_PLAYED", evidence: ["Accepted visible corner wear."], photoCount: 2 } : null });
            const quote = final.prices?.find(value => value.condition === "LIGHTLY_PLAYED");
            assert.equal(quote?.basis, "EBAY_SOLD"); assert.equal(quote?.price, 200); assert.equal(quote?.comps?.count, 1);
        }
        assert.equal(calls.length, beforeFinal, "final valuation must reuse every screened cursor page without another transport");
    }
});

test("sparse final-price adapters stop at four pages even when every response promises more", async t => {
    offlineKey(t);
    const calls: URL[] = [];
    t.mock.method(globalThis, "fetch", async (value: string) => {
        const url = new URL(value); calls.push(url);
        const page = Number(url.searchParams.get("cursor") ?? "1");
        return Response.json({ data: [sale(`page-${page}`)], pagination: { has_more: true, next_cursor: String(page + 1) } });
    });
    for (const kind of ["graded", "raw"] as const) {
        const before = calls.length;
        const sales = await adapted(kind, randomUUID(), { stopWhen: () => false });
        assert.equal(calls.length - before, 4, kind);
        assert.deepEqual(sales.map(value => value.id), ["page-1", "page-2", "page-3", "page-4"]);
    }
});

test("repeated sold cursors finish without fetching or counting the same page again", async t => {
    offlineKey(t);
    const cursors: (string | null)[] = [];
    t.mock.method(globalThis, "fetch", async (value: string) => {
        const cursor = new URL(value).searchParams.get("cursor"); cursors.push(cursor);
        return Response.json({ data: [sale(cursor ?? "first")],
            pagination: { has_more: true, next_cursor: cursor === "second" ? "third" : "second" } });
    });
    for (const kind of ["graded", "raw"] as const) {
        const before = cursors.length;
        const sales = await adapted(kind, randomUUID(), { stopWhen: () => false });
        assert.deepEqual(cursors.slice(before), [null, "second", "third"], kind);
        assert.deepEqual(sales.map(value => value.id), ["first", "second", "third"]);
    }
});

test("Stop during asynchronous sold-page selection rejects final pricing without dispatching another page", async t => {
    offlineKey(t);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
        requests++;
        return Response.json({ data: [sale(String(requests))], pagination: { has_more: true, next_cursor: String(requests + 1) } });
    });
    for (const kind of ["graded", "raw"] as const) {
        const before = requests, controller = new AbortController(), stop = new Error("Stopped during sold selection");
        await assert.rejects(withPriceResearchSignal(controller.signal, () => adapted(kind, randomUUID(), { stopWhen: async () => {
            await Promise.resolve(); controller.abort(stop); return true;
        } })), error => error === stop);
        assert.equal(requests - before, kind === "graded" ? 1 : 2, "Stop must prevent any page after the current candidate window");
    }
});

test("a usable slab sale stops immediately while raw research retains its two-page candidate window", async t => {
    offlineKey(t);
    const calls: URL[] = [];
    t.mock.method(globalThis, "fetch", async (value: string) => {
        const url = new URL(value); calls.push(url);
        const page = Number(url.searchParams.get("cursor") ?? "1"), graded = url.searchParams.get("graded") === "true";
        if (graded) assert.equal(page, 1, "a usable exact-grade sale needs no later page");
        else assert.ok(page <= 2, "raw candidates retain two pages without scanning farther after an exact sale");
        return Response.json({ data: [sale(`${graded ? "slab" : "raw"}-${page}`, { price: graded || page === 2 ? 200 : 70,
            title: `Venusaur Base Set 15/102 Unlimited Holo ${graded ? "PSA 8" : page === 1 ? "LP" : ""}`.trim(),
            grader: graded ? "PSA" : null, grade: graded ? "8" : null })], pagination: { has_more: true, next_cursor: String(page + 1) } });
    });
    const slab = await compsForGrade(pricedCard(randomUUID()), identity, { fetchComps, grader: "PSA", grade: 8, now });
    assert.equal(slab.summary?.median, 200); assert.equal(calls.length, 1);
    const read: (number | string | undefined)[] = [];
    let acquisitions = 0;
    const raw = await rawPricesWithSales(pricedCard(randomUUID()), identity, { fetchRawComps, now, requestedCondition: "LIGHTLY_PLAYED",
        assessCondition: async source => { read.push(source.id); return null; },
        acquireCondition: async offered => {
            acquisitions++;
            assert.deepEqual(read, ["raw-1", "raw-2"], "both candidate pages reach saved evidence reads before acquisition");
            assert.deepEqual(offered.map(source => source.price), [70, 200]);
            return { sale: offered[1], evidence: { condition: "LIGHTLY_PLAYED", evidence: ["Accepted physical wear evidence."], photoCount: 2 } };
        },
    });
    assert.equal(calls.length, 3); assert.equal(acquisitions, 1);
    const quote = raw.prices?.find(value => value.condition === "LIGHTLY_PLAYED");
    assert.equal(quote?.price, 200); assert.equal(quote?.basis, "EBAY_SOLD");
});
