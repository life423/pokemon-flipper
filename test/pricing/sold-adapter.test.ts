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
import { cachedCompChecks } from "../../server/ai/comp-checker.ts";
import { MODEL } from "../../server/ai/openai.ts";
import { printingLabel } from "../../server/identity/card-identity.ts";
import { readCache, writeCache } from "../../server/lib/cache.ts";
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
const card = (id: string): CardRecord => ({ source: "pkmnprices", id, name: "Venusaur", setName: "Base Set", cardNumber: "15/102",
    variants: [{ name: variant, finish: "HOLO", printing: "UNLIMITED" }] });
function pricedCard(id: string): PricedCard {
    const record = card(id);
    return { source: record.source, name: record.name, cardNumber: record.cardNumber, records: [record],
        variants: [{ ...record.variants[0], recordId: id, setName: record.setName }] };
}
const adapted = (kind: "graded" | "raw", id: string, selection: SoldPageSelection) => kind === "graded"
    ? fetchComps(id, { grader: "PSA", grade: 8, variant, ...selection }) : fetchRawComps(id, variant, selection);
const confirmedTypes = "auction,fixed_price,best_offer_accepted";
function soldPath(kind: "graded" | "raw", id: string, confirmed = false, cursor?: string) {
    const params = kind === "graded"
        ? new URLSearchParams({ graded: "true", grader: "PSA", grade: "8", limit: "20", sort: "date_desc", period: "180d", variant })
        : new URLSearchParams({ graded: "false", period: "90d", sort: "date_desc", limit: "20", variant });
    if (confirmed) params.set("sale_type", confirmedTypes);
    if (cursor) params.set("cursor", cursor);
    return `/cards/${id}/listings/ebay?${params}`;
}
const target = (kind: "graded" | "raw") => ({ grader: kind === "graded" ? "PSA" : null, grade: kind === "graded" ? "8" : null, variant });
const scopedSale = (kind: "graded" | "raw", id: string, extra: Partial<Comp> = {}) => sale(id, {
    ...target(kind), title: `Venusaur Base Set 15/102 Unlimited Holo ${kind === "graded" ? "PSA 8" : "LP"}`, ...extra,
});
function screening(kind: "graded" | "raw", id: string, maxRequests = 0) {
    const source = createScreeningPriceSource({ maxRequests });
    const run = createSoldScreening({ now: () => now, source: { ...source, lookupCards: async () => [card(id)] } });
    const listing: ListingSummary = { id: `screen-${kind}`, title: scopedSale(kind, "title").title, currentPrice: 100, shipping: 0, bids: 0,
        isGraded: kind === "graded", buyingOption: "FIXED_PRICE", endTime: null, images: [], url: "https://www.ebay.com/itm/123456789012", seller: null };
    const intent: SearchIntent = { cardName: "Venusaur", sets: ["Base Set"], cardNumber: "15/102", printing: "UNLIMITED",
        graded: kind === "graded", titleWords: ["venusaur"], source: "rules" };
    return { source, run: () => run(listing, intent) };
}

test("sold adapters bound pages, request recent sales and exclude non-USD rows before money math", async (t) => {
    const original = process.env.PKMNPRICES_API_KEY;
    process.env.PKMNPRICES_API_KEY = "offline-test-key";
    const calls: URL[] = [];
    t.mock.method(globalThis, "fetch", async (value: string) => {
        const url = new URL(value); calls.push(url);
        assert.equal(url.searchParams.get("sale_type"), confirmedTypes, "cold sold requests ask for all three confirmed sale methods");
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

test("useful third-page legacy sales retain original cache chains for screening and final prices without new requests", async t => {
    offlineKey(t);
    t.mock.method(globalThis, "fetch", () => assert.fail("legacy sold evidence must remain available with no provider allowance"));
    for (const kind of ["graded", "raw"] as const) {
        const id = randomUUID();
        for (let page = 1; page <= 3; page++) await writeCache(`pkmnprices:${soldPath(kind, id, false, page === 1 ? undefined : `old-${page}`)}`, {
            data: [scopedSale(kind, `${kind}-${page}`, page < 3 ? { title: `Charizard Base Set 4/102 Unlimited Holo ${kind === "graded" ? "PSA 8" : "LP"}` } : {})],
            pagination: { has_more: page < 3, next_cursor: page < 3 ? `old-${page + 1}` : null },
        });
        const market = screening(kind, id);
        const screened = await market.run();
        assert.equal(screened.status, "AVAILABLE"); assert.equal(screened.references[0].summary.count, 1);
        assert.equal(screened.references[0].summary.median, 200); assert.equal(screened.references[0].summary.confidence, "LOW");
        if (kind === "graded") {
            const final = await compsForGrade(pricedCard(id), identity, { fetchComps, grader: "PSA", grade: 8, now });
            assert.equal(final.summary?.median, 200); assert.equal(final.summary?.count, 1);
        } else {
            const final = await rawPricesWithSales(pricedCard(id), identity, { fetchRawComps, requestedCondition: "LIGHTLY_PLAYED", now,
                assessCondition: async source => source.id === "raw-3" ? { condition: "LIGHTLY_PLAYED", evidence: ["Accepted physical corner wear."], photoCount: 2 } : null });
            assert.equal(final.prices?.find(quote => quote.condition === "LIGHTLY_PLAYED")?.price, 200);
            assert.equal(final.prices?.find(quote => quote.condition === "LIGHTLY_PLAYED")?.basis, "EBAY_SOLD");
        }
        assert.deepEqual(market.source.stats(), { requests: 0, limit: 0 });
        assert.equal(await readCache(`pkmnprices:${soldPath(kind, id, true)}`, 6), null, "legacy pages must not be relabeled as a filtered pagination stream");
    }
});

test("legacy selection stays printing-specific while shared native pages are fetched only once", async t => {
    offlineKey(t);
    const id = randomUUID(), record = card(id);
    record.setName = "Base Set Shadowless";
    record.variants = [{ ...record.variants[0], printing: "FIRST_EDITION" }, { ...record.variants[0], printing: "SHADOWLESS" }];
    await writeCache(`pkmnprices:${soldPath("graded", id)}`, { data: [scopedSale("graded", "first-edition", {
        title: "Venusaur Base Set 15/102 1st Edition Shadowless Holo PSA 8", price: 1000,
    })] });
    let requests = 0;
    t.mock.method(globalThis, "fetch", async (value: string) => {
        requests++;
        assert.equal(new URL(value).searchParams.get("sale_type"), confirmedTypes);
        return Response.json({ data: [scopedSale("graded", "shadowless", {
            title: "Venusaur Base Set 15/102 Shadowless no 1st Edition Holo PSA 8", price: 200,
        })] });
    });
    const source = createScreeningPriceSource({ maxRequests: 1 });
    const run = createSoldScreening({ now: () => now, source: { ...source, lookupCards: async () => [record] } });
    const subject: ListingSummary = { id: "separate-printings", title: "Venusaur Base Set 15/102 Holo PSA 8", currentPrice: 100,
        shipping: 0, bids: 0, isGraded: true, buyingOption: "FIXED_PRICE", endTime: null, images: [], seller: null,
        url: "https://www.ebay.com/itm/123456789012" };
    const intent: SearchIntent = { cardName: "Venusaur", sets: ["Base Set"], cardNumber: "15/102", printing: null,
        graded: true, titleWords: ["venusaur"], source: "rules" };
    const result = await run(subject, intent);
    assert.deepEqual(result.references.map(reference => [reference.printing, reference.summary.median]), [["FIRST_EDITION", 1000], ["SHADOWLESS", 200]]);
    assert.equal(requests, 1); assert.equal(source.stats().requests, 1);
});

test("all-null legacy pages recover a confirmed root and follow only that stream's new cursor", async t => {
    offlineKey(t);
    const calls: URL[] = [];
    t.mock.method(globalThis, "fetch", async (value: string) => {
        const url = new URL(value); calls.push(url);
        assert.equal(url.searchParams.get("sale_type"), confirmedTypes);
        assert.ok(!url.searchParams.get("cursor") || url.searchParams.get("cursor") === "confirmed-next", "an old cursor must never be sent with a confirmed filter");
        const kind = url.searchParams.get("graded") === "true" ? "graded" : "raw";
        return Response.json({ data: [scopedSale(kind, "corrected", { price: 175, sale_type: "best_offer_accepted" })],
            pagination: { has_more: !url.searchParams.has("cursor"), next_cursor: "confirmed-next" } });
    });
    for (const kind of ["graded", "raw"] as const) {
        const id = randomUUID(), before = calls.length;
        for (let page = 1; page <= 4; page++) await writeCache(`pkmnprices:${soldPath(kind, id, false, page === 1 ? undefined : `legacy-${page}`)}`, {
            data: [scopedSale(kind, "corrected", { price: 9999, sale_type: null })], pagination: { has_more: true, next_cursor: `legacy-${page + 1}` },
        });
        const source = createScreeningPriceSource({ maxRequests: 2 });
        const first = await source.fetchSoldPage(id, target(kind));
        assert.equal(first.stream, "CONFIRMED"); assert.equal(first.nextCursor, "confirmed-next"); assert.equal(first.sales[0].price, 175);
        const next = await source.fetchSoldPage(id, { ...target(kind), cursor: first.nextCursor!, stream: first.stream });
        assert.equal(next.stream, "CONFIRMED"); assert.equal(next.nextCursor, null);
        assert.deepEqual(calls.slice(before).map(url => url.searchParams.get("cursor")), [null, "confirmed-next"]);
        assert.equal(source.stats().requests, 2);
        const final = await adapted(kind, id, { stopWhen: () => false });
        assert.deepEqual([...new Map(final.map(source => [source.id, source.price]))], [["corrected", 175]]);
        assert.equal(calls.length, before + 2, "final adapters reuse the recovered filtered pages");
    }
});

test("a missing legacy continuation restarts the confirmed root and its corrected transaction amount replaces the old row", async t => {
    offlineKey(t);
    const id = randomUUID(), old = [sale("corrected", { price: 9999, sale_type: null }), sale("legacy-match", { price: 70 })];
    await writeCache(`pkmnprices:${soldPath("raw", id)}`, { data: old, pagination: { has_more: true, next_cursor: "missing-old-page" } });
    const calls: URL[] = [];
    t.mock.method(globalThis, "fetch", async (value: string) => {
        const url = new URL(value); calls.push(url);
        assert.equal(url.searchParams.get("sale_type"), confirmedTypes);
        assert.equal(url.searchParams.get("cursor"), null, "missing legacy continuation must restart filtered acquisition at page one");
        return Response.json({ data: [sale("corrected", { price: 175, sale_type: "auction" })] });
    });
    const source = createScreeningPriceSource({ maxRequests: 1 });
    const first = await source.fetchSoldPage(id, target("raw"));
    assert.equal(first.stream, "LEGACY"); assert.equal(first.nextCursor, "missing-old-page");
    const raw = await rawPricesWithSales(pricedCard(id), identity, { fetchRawComps, now, requestedCondition: "LIGHTLY_PLAYED",
        assessCondition: async source => source.id === "corrected" ? { condition: "LIGHTLY_PLAYED", evidence: ["Accepted physical edge wear."], photoCount: 2 } : null });
    const quote = raw.prices?.find(value => value.condition === "LIGHTLY_PLAYED");
    assert.equal(quote?.price, 175); assert.equal(quote?.basis, "EBAY_SOLD"); assert.equal(quote?.comps?.count, 1);
    const resumed = await source.fetchSoldPage(id, { ...target("raw"), cursor: first.nextCursor!, stream: first.stream });
    assert.equal(resumed.stream, "CONFIRMED"); assert.deepEqual(resumed.sales.map(value => [value.id, value.price]), [["corrected", 175]]);
    assert.equal(calls.length, 1, "the recovered root is shared with later legacy consumers");
    assert.deepEqual(await readCache(`pkmnprices:${soldPath("raw", id)}`, 6), { data: old, pagination: { has_more: true, next_cursor: "missing-old-page" } });
});

test("a fresh empty filtered cache takes precedence over positive legacy pages while original empty roots remain reusable", async t => {
    offlineKey(t);
    t.mock.method(globalThis, "fetch", () => assert.fail("fresh empty sold responses must not trigger replacement provider work"));
    for (const kind of ["graded", "raw"] as const) {
        const id = randomUUID(), legacy = { data: [scopedSale(kind, "legacy-positive")] };
        await writeCache(`pkmnprices:${soldPath(kind, id)}`, legacy);
        await writeCache(`pkmnprices:${soldPath(kind, id, true)}`, { data: [] });
        const source = createScreeningPriceSource({ maxRequests: 0 });
        const page = await source.fetchSoldPage(id, target(kind));
        assert.equal(page.stream, "CONFIRMED"); assert.deepEqual(page.sales, []); assert.equal(page.nextCursor, null);
        assert.deepEqual(await adapted(kind, id, {}), []);
        assert.deepEqual(await readCache(`pkmnprices:${soldPath(kind, id)}`, 6), legacy, "filter preference preserves the original legacy record");
        const emptyId = randomUUID();
        await writeCache(`pkmnprices:${soldPath(kind, emptyId)}`, { data: [] });
        assert.deepEqual((await source.fetchSoldPage(emptyId, target(kind))).sales, []);
        assert.deepEqual(source.stats(), { requests: 0, limit: 0 });
    }
});

test("filtered pages still require a confirmed exact card and grade before screening or final pricing", async t => {
    offlineKey(t);
    const calls: URL[] = [];
    t.mock.method(globalThis, "fetch", async (value: string) => {
        const url = new URL(value); calls.push(url);
        assert.equal(url.searchParams.get("sale_type"), confirmedTypes);
        const kind = url.searchParams.get("graded") === "true" ? "graded" : "raw", cursor = url.searchParams.get("cursor");
        assert.ok(cursor === null || cursor === "valid-page");
        return Response.json(cursor ? { data: [scopedSale(kind, "accepted", { sale_type: "best_offer_accepted" })] }
            : { data: [scopedSale(kind, "unconfirmed", { price: 9999, sale_type: null }),
                scopedSale(kind, "wrong-card", { price: 9999, title: `Charizard Base Set 4/102 Unlimited Holo ${kind === "graded" ? "PSA 8" : "LP"}` }),
                scopedSale(kind, "wrong-grade", { price: 9999, grader: "PSA", grade: "9", title: "Venusaur Base Set 15/102 Unlimited Holo PSA 9" })],
                pagination: { has_more: true, next_cursor: "valid-page" } });
    });
    for (const kind of ["graded", "raw"] as const) {
        const id = randomUUID(), before = calls.length, market = screening(kind, id, 2);
        const screened = await market.run();
        assert.equal(screened.status, "AVAILABLE"); assert.equal(screened.references[0].summary.count, 1);
        assert.equal(screened.references[0].summary.median, 200); assert.equal(screened.references[0].summary.confidence, "LOW");
        if (kind === "graded") {
            const final = await compsForGrade(pricedCard(id), identity, { fetchComps, grader: "PSA", grade: 8, now });
            assert.equal(final.summary?.count, 1); assert.equal(final.summary?.median, 200); assert.equal(final.summary?.windowDays, 90);
        } else {
            const final = await rawPricesWithSales(pricedCard(id), identity, { fetchRawComps, now, requestedCondition: "LIGHTLY_PLAYED",
                assessCondition: async source => source.id === "accepted" ? { condition: "LIGHTLY_PLAYED", evidence: ["Accepted physical corner wear."], photoCount: 2 } : null });
            const quote = final.prices?.find(value => value.condition === "LIGHTLY_PLAYED");
            assert.equal(quote?.price, 200); assert.equal(quote?.comps?.count, 1); assert.equal(quote?.comps?.windowDays, 90);
        }
        assert.equal(calls.length, before + 2, "invalid first-page rows cannot stop recovery or require another final-price purchase");
    }
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

test("saved slab vetoes cannot stop pagination before an eligible sale", async t => {
    offlineKey(t);
    t.mock.method(globalThis, "fetch", () => assert.fail("both sold pages and the existing veto are cached"));
    const id = randomUUID(), vetoed = scopedSale("graded", `vetoed-${id}`, { price: 300 }), accepted = scopedSale("graded", `accepted-${id}`);
    await writeCache(`pkmnprices:${soldPath("graded", id, true)}`, {
        data: [vetoed], pagination: { has_more: true, next_cursor: "second" },
    });
    await writeCache(`pkmnprices:${soldPath("graded", id, true, "second")}`, {
        data: [accepted], pagination: { has_more: true, next_cursor: "unused" },
    });
    const scope = [identity.name, identity.set, identity.cardNumber, printingLabel(identity.printing, identity.set), "PSA", "8", "HOLO", ""].join("|").toLowerCase();
    const saleMetadata = JSON.stringify([vetoed.title, vetoed.variant, vetoed.grader, vetoed.grade, vetoed.grade_qualifier, vetoed.attribution]);
    await writeCache(`comp-check:v2:${MODEL}:${scope}:${vetoed.id}:${saleMetadata}`, { keep: false, reason: "SIGNED_OR_ALTERED", note: "Saved veto." });

    const options = { fetchComps, grader: "PSA", grade: 8, now, cachedChecks: cachedCompChecks };
    const final = await compsForGrade(pricedCard(id), identity, options);
    assert.equal(final.status, "PRICED");
    assert.equal(final.summary?.count, 1);
    assert.equal(final.summary?.median, 200);
    assert.deepEqual(final.summary?.dropped, { "AI: signed or altered": 1 });

    let finalChecks = 0;
    const retried = await compsForGrade(pricedCard(id), identity, { ...options, checkComps: async (sales, target) => {
        finalChecks++;
        assert.deepEqual(sales.map(sale => sale.id), [vetoed.id, accepted.id]);
        return cachedCompChecks(sales, target);
    } });
    assert.equal(finalChecks, 1, "optional final checker sees the whole result only after pagination");
    assert.deepEqual(retried.summary, final.summary);
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
