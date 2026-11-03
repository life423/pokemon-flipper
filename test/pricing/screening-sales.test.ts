import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSoldScreening } from "../../server/pricing/screening-sales.ts";
import { ScreeningPriceBudgetError } from "../../server/pricing/pkmnprices.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import type { CardRecord, Comp } from "../../server/pricing/types.ts";
import type { ListingSummary, SearchIntent } from "../../shared/types.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z"), DAY = 86_400_000;
const intent: SearchIntent = { cardName: "Charizard", sets: ["Base Set"], cardNumber: "4/102", printing: null, graded: null, titleWords: ["charizard"], source: "rules" };
const variant = (name = "Unlimited Holofoil", printing: "UNLIMITED" | "FIRST_EDITION" | "SHADOWLESS" | "UNKNOWN" = "UNLIMITED", finish = "HOLO") => ({ name, printing, finish, prices: [] });
const card = (extra: Partial<CardRecord> = {}): CardRecord => ({ source: "pkmnprices", id: 1, name: "Charizard", setName: "Base Set", cardNumber: "4/102", tcgPlayerId: null, variants: [variant()], ...extra });
const listing = (extra: Partial<ListingSummary> = {}): ListingSummary => ({ id: "v1|listing|0", title: "Charizard Base Set 4/102 Unlimited Holo", currentPrice: 40, shipping: 5, bids: 0, isGraded: false, buyingOption: "FIXED_PRICE", endTime: null, images: [], url: "https://www.ebay.com/itm/123", seller: null, ...extra });
let saleId = 0;
const sale = (extra: Partial<Comp> = {}): Comp => ({ id: ++saleId, title: "Charizard Base Set 4/102 Unlimited Holo NM", price: 100, sold_at: new Date(NOW - DAY).toISOString(), variant: "Unlimited Holofoil", grader: null, grade: null, currency: "USD", sale_type: "fixed_price", grade_qualifier: null, attribution: "exact", listing_url: `https://www.ebay.com/itm/${saleId}`, ...extra });
const three = (extra: Partial<Comp> = {}) => [90, 100, 110].map(price => sale({ price, ...extra }));
function harness(options: { cards?: CardRecord[]; raw?: (record: number | string, label: string) => Promise<Comp[]>; graded?: (...args: any[]) => Promise<Comp[]>; lookup?: (...args: any[]) => Promise<CardRecord[]>; signal?: AbortSignal } = {}) {
    const calls = { lookup: 0, raw: [] as unknown[][], graded: [] as unknown[][] };
    const run = createSoldScreening({ now: () => NOW, signal: options.signal, source: {
        lookupCards: async query => { calls.lookup++; return options.lookup ? options.lookup(query) : options.cards ?? [card()]; },
        fetchRawComps: async (...args) => { calls.raw.push(args); return options.raw ? options.raw(...args) : three(); },
        fetchComps: async (...args) => { calls.graded.push(args); return options.graded ? options.graded(...args) : []; },
    } });
    return { run, calls };
}

test("raw sold references keep independent condition buckets and confirmed transaction amounts", async () => {
    const { run, calls } = harness({ raw: async () => [
        ...three(), ...[50, 55, 60].map(price => sale({ title: "Charizard Base Set 4/102 Unlimited Holo LP", price })),
        ...[10, 12].map(price => sale({ title: "Charizard Base Set 4/102 Unlimited Holo Damaged", price })),
        sale({ title: "Charizard Base Set 4/102 Unlimited Holo" }), sale({ sale_type: null }), sale({ attribution: "shared" }),
        sale({ currency: "EUR" }), sale({ price: Infinity }), sale({ sold_at: new Date(NOW + DAY).toISOString() }),
        sale({ sold_at: new Date(NOW - 91 * DAY).toISOString() }), sale({ variant: "Unlimited Reverse Holofoil" }),
        sale({ title: "Charmander Base Set 46/102 Unlimited Holo NM" }), sale({ title: "Charizard Base Set 4/102 Unlimited Holo NM lot of 2 cards" }),
    ] });
    const result = await run(listing(), intent);
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, true);
    assert.deepEqual(result.references.map(reference => [reference.condition, reference.summary.count, reference.summary.median]), [["NEAR_MINT", 3, 100], ["LIGHTLY_PLAYED", 3, 55], ["DAMAGED", 2, 11], [null, 1, 100]]);
    assert.ok(result.references.every(reference => reference.grader === null && reference.grade === null && reference.summary.windowDays === 90));
    assert.equal(calls.raw.length, 1); assert.equal(calls.graded.length, 0);
});

test("slabs research one exact grader and half grade without raw or speculative grading work", async () => {
    const { run, calls } = harness({ graded: async () => [
        ...three({ title: "Charizard Base Set 4/102 Unlimited Holo CGC 8.5", grader: "CGC", grade: "8.5" }),
        sale({ title: "Charizard Base Set 4/102 Unlimited Holo CGC 8", grader: "CGC", grade: "8", price: 5 }),
        sale({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8.5", grader: "PSA", grade: "8.5", price: 5 }),
        sale({ title: "Charizard Base Set 4/102 Unlimited Holo CGC 8.5", grader: "CGC", grade: "8.5", grade_qualifier: "Pristine", price: 5000 }),
        sale({ title: "Charizard Base Set 4/102 Unlimited Holo CGC Pristine 8.5", grader: "CGC", grade: "8.5", grade_qualifier: null, price: 5000 }),
    ] });
    const result = await run(listing({ title: "Charizard Base Set 4/102 Unlimited Holo CGC 8.5", isGraded: true }), intent);
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.references.length, 1);
    assert.deepEqual([result.references[0].grader, result.references[0].grade, result.references[0].condition, result.references[0].summary.count], ["CGC", "8.5", null, 3]);
    assert.deepEqual(calls.graded, [[1, { grader: "CGC", grade: "8.5", variant: "Unlimited Holofoil" }]]);
    assert.equal(calls.raw.length, 0);
});

test("sold-title grade and grader contradictions cannot override the exact target through provider fields", async () => {
    const { run } = harness({ graded: async () => [
        ...three({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", grader: "PSA", grade: "8" }),
        ...three({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 5", grader: "PSA", grade: "8", price: 5 }),
        ...three({ title: "Charizard Base Set 4/102 Unlimited Holo CGC 8", grader: "PSA", grade: "8", price: 5 }),
    ] });
    const result = await run(listing({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", isGraded: true }), intent);
    assert.equal(result.status, "AVAILABLE");
    assert.equal(result.references[0].summary.count, 3); assert.equal(result.references[0].summary.median, 100);
});

test("known foreign sold titles never price an English target even when other provider fields claim an exact match", async () => {
    for (const graded of [false, true]) {
        const rows = three({ title: `リザードン Charizard Base Set 4/102 Japanese Unlimited Holo${graded ? " PSA 8" : ""}`,
            grader: graded ? "PSA" : null, grade: graded ? "8" : null });
        const { run } = harness({ raw: async () => rows, graded: async () => rows });
        const result = await run(listing({ title: `Charizard Base Set 4/102 Unlimited Holo${graded ? " PSA 8" : ""}`, isGraded: graded }), intent);
        assert.equal(result.status, "UNAVAILABLE"); assert.equal(result.references.length, 0);
    }
});

test("missing or conflicting certified grades and special labels do not borrow requested grades", async () => {
    for (const subject of [
        listing({ isGraded: true }),
        listing({ isGraded: true, title: "Charizard Base Set 4/102 Unlimited Holo CGC Pristine 10" }),
        listing({ isGraded: true, title: "Charizard Base Set 4/102 Unlimited Holo PSA 8 (OC)" }),
        listing({ isGraded: true, title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", listedAttributes: { grader: "PSA", grade: 9, finish: "HOLO" } }),
    ]) {
        const { run, calls } = harness();
        assert.equal((await run(subject, { ...intent, grader: "PSA", minGrade: 10, maxGrade: 10 })).status, "UNAVAILABLE");
        assert.equal(calls.lookup + calls.raw.length + calls.graded.length, 0);
    }
});

test("unstated editions retain all plausible catalog printings rather than defaulting to Unlimited", async () => {
    const { run, calls } = harness({ cards: [card({ variants: [variant(), variant("1st Edition Holofoil", "FIRST_EDITION")] })],
        raw: async (_id, label) => three({ title: `Charizard Base Set 4/102 ${label.startsWith("1st") ? "1st Edition" : "Unlimited"} Holo NM`, variant: label, price: label.startsWith("1st") ? 1000 : 100 }) });
    const result = await run(listing({ title: "Charizard Base Set 4/102 Holo" }), { ...intent, printing: "FIRST_EDITION" });
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, false);
    assert.deepEqual(result.references.map(reference => [reference.printing, reference.summary.median]), [["UNLIMITED", 100], ["FIRST_EDITION", 1000]]);
    assert.equal(calls.raw.length, 2);
});

test("holo and reverse holo stay separate and an unstated finish cannot silently select either", async () => {
    const options = { cards: [card({ variants: [variant(), variant("Unlimited Reverse Holofoil", "UNLIMITED", "REVERSE_HOLO")] })],
        raw: async (_id: number | string, label: string) => three({ title: `Charizard Base Set 4/102 Unlimited ${label.includes("Reverse") ? "Reverse Holo" : "Holo"} NM`, variant: label }) };
    const unknown = harness(options);
    const result = await unknown.run(listing({ title: "Charizard Base Set 4/102 Unlimited" }), { ...intent, finish: "HOLO" });
    assert.equal(result.exactScope, false); assert.deepEqual(result.references.map(reference => reference.finish), ["HOLO", "REVERSE_HOLO"]);
    const holo = harness(options);
    const exact = await holo.run(listing(), intent);
    assert.equal(exact.exactScope, true); assert.equal(exact.references.length, 1); assert.equal(holo.calls.raw.length, 1);
});

test("split Shadowless catalog labels share source pages while sale titles settle separate printing summaries", async () => {
    const { run, calls } = harness({ cards: [card({ setName: "Base Set Shadowless", variants: [variant("1st Edition Holofoil", "FIRST_EDITION"), variant("Unlimited Holofoil", "SHADOWLESS")] })],
        raw: async (_id, label) => label.startsWith("1st") ? [
            ...three({ title: "Charizard Base Set 4/102 1st Edition Shadowless Holo NM", variant: label, price: 1000 }),
            ...three({ title: "Charizard Base Set 4/102 Shadowless no 1st Edition Holo NM", variant: label, price: 200 }),
        ] : [] });
    const result = await run(listing({ title: "Charizard Base Set 4/102 Holo" }), intent);
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, false);
    assert.deepEqual(result.references.map(reference => [reference.printing, reference.summary.count, reference.summary.median]), [["FIRST_EDITION", 3, 1000], ["SHADOWLESS", 3, 200]]);
    assert.equal(calls.raw.length, 2, "the two source labels must not be fetched again for the second printing");
});

test("a completed Shadowless source page survives another label's deferral as incomplete market context", async () => {
    for (const graded of [false, true]) {
        const firstPage = three({ title: `Charizard Base Set 4/102 1st Edition Shadowless Holo${graded ? " PSA 8" : " NM"}`,
            variant: "1st Edition Holofoil", grader: graded ? "PSA" : null, grade: graded ? "8" : null });
        const fetched = async (_id: number | string, label: string) => {
            if (label === "Unlimited Holofoil") throw new ScreeningPriceBudgetError();
            return firstPage;
        };
        const { run, calls } = harness({ cards: [card({ setName: "Base Set Shadowless", variants: [variant("1st Edition Holofoil", "FIRST_EDITION"), variant("Unlimited Holofoil", "SHADOWLESS")] })],
            raw: fetched, graded: async (id, target) => fetched(id, target.variant) });
        const subject = listing({ title: `Charizard Base Set 4/102 1st Edition Shadowless Holo${graded ? " PSA 8" : ""}`, isGraded: graded });
        const result = await run(subject, intent);
        assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, false);
        assert.equal(result.references.length, 1); assert.equal(result.references[0].summary.count, 3);
        assert.match(result.note, /partial market context/); assert.match(result.note, /Remaining source pages/);
        await run(subject, intent);
        assert.equal(calls.raw.length + calls.graded.length, 2, "a memoized partial market must not request either source page again");
    }
});

test("a sole known catalog choice can establish research scope while intent-only identities remain preliminary", async () => {
    const { run } = harness();
    assert.equal((await run(listing({ title: "Charizard Base Set 4/102" }), intent)).exactScope, true);
    const fallback = await run(listing({ title: "Pokemon card" }), intent);
    assert.equal(fallback.status, "AVAILABLE"); assert.equal(fallback.exactScope, false);
    assert.ok(!("currentPrice" in fallback.references[0]));
});

test("raw sales without condition wording provide separate market context without inventing a condition or grade", async () => {
    const { run, calls } = harness({ raw: async () => [
        ...three({ title: "Charizard Base Set 4/102 Unlimited Holo" }),
        ...three({ title: "Charizard Base Set 4/102 Unlimited Holo LP", price: 50 }),
    ] });
    const result = await run(listing(), intent);
    assert.equal(result.status, "AVAILABLE");
    assert.deepEqual(result.references.map(reference => [reference.condition, reference.summary.grade, reference.summary.median]), [["LIGHTLY_PLAYED", "LIGHTLY_PLAYED", 50], [null, "UNSPECIFIED", 100]]);
    const context = result.references[1];
    assert.equal(context.grader, null); assert.equal(context.grade, null); assert.equal(context.summary.grader, "RAW");
    assert.match(result.note, /market context only/); assert.equal(calls.graded.length, 0);
});

test("name-and-set searches without numbers preserve one or several canonical cards without guessing a number", async () => {
    const noNumber = { ...intent, cardNumber: null };
    const subject = listing({ title: "Charizard Base Set Unlimited Holo" });
    const one = harness({ lookup: async query => { assert.equal(query.cardNumber, ""); return [card()]; } });
    const first = await one.run(subject, noNumber);
    assert.equal(first.status, "AVAILABLE"); assert.equal(first.exactScope, false); assert.equal(first.references[0].cardNumber, "4/102");
    const several = harness({ cards: [card(), card({ id: 2, cardNumber: "5/102" })], raw: async id => three({ title: `Charizard Base Set ${id === 1 ? "4/102" : "5/102"} Unlimited Holo NM`, price: Number(id) * 100 }) });
    const multiple = await several.run(subject, noNumber);
    assert.equal(multiple.status, "AVAILABLE"); assert.equal(multiple.exactScope, false);
    assert.deepEqual(multiple.references.map(reference => [reference.cardNumber, reference.summary.median]), [["4/102", 100], ["5/102", 200]]);
    assert.equal(several.calls.lookup, 1); assert.equal(several.calls.raw.length, 2);
});

test("wrong and ambiguous catalog identities do not trigger sold-price research", async () => {
    for (const cards of [[card({ name: "Charmander" })], [card({ setName: "Base Set 2" })], [card({ cardNumber: "4/130" })], [card(), card({ id: 2 })]]) {
        const { run, calls } = harness({ cards });
        assert.equal((await run(listing(), intent)).status, "UNAVAILABLE");
        assert.equal(calls.raw.length + calls.graded.length, 0);
    }
});

test("fifty listings share canonical catalog and market work without sharing mutable answers or asking prices", async () => {
    const { run, calls } = harness();
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => run(listing({ id: String(index), currentPrice: index * 100, shipping: index }), intent)));
    assert.equal(calls.lookup, 1); assert.equal(calls.raw.length, 1);
    assert.ok(results.every(result => result.status === "AVAILABLE"));
    results[0].references[0].summary.median = 99_999;
    assert.equal(results[1].references[0].summary.median, 100);
    assert.equal((await run(listing(), intent)).references[0].summary.median, 100);
});

test("bounded price exhaustion defers missing markets while retaining accepted sparse or complete facts", async () => {
    const { run, calls } = harness({ cards: [card({ variants: [variant(), variant("1st Edition Holofoil", "FIRST_EDITION")] })], raw: async (_id, label) => {
        if (label.startsWith("1st")) throw new ScreeningPriceBudgetError();
        return three();
    } });
    const subject = listing({ title: "Charizard Base Set 4/102 Holo" });
    const result = await run(subject, intent);
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, false); assert.equal(result.references.length, 1);
    assert.equal(result.references[0].summary.count, 3);
    assert.match(result.note, /partial market context/);
    await run(subject, intent);
    assert.equal(calls.lookup, 1); assert.equal(calls.raw.length, 2, "a later row cannot repurchase a failed market within this search");
});

test("partial slab references survive budget or provider deferral without becoming an exact exclusion scope", async () => {
    for (const failure of [new ScreeningPriceBudgetError(), new Error("Price service unavailable")]) {
        const { run, calls } = harness({ cards: [card({ variants: [variant(), variant("1st Edition Holofoil", "FIRST_EDITION")] })], graded: async (_id, target) => {
            if (target.variant.startsWith("1st")) throw failure;
            return three({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", grader: "PSA", grade: "8" });
        } });
        const subject = listing({ title: "Charizard Base Set 4/102 Holo PSA 8", isGraded: true });
        const result = await run(subject, intent);
        assert.equal(result.status, "AVAILABLE"); assert.equal(result.exactScope, false);
        assert.equal(result.references.length, 1); assert.equal(result.references[0].summary.count, 3);
        await run(subject, intent); assert.equal(calls.graded.length, 2);
    }
});

test("a wholly missing or sparse failed market remains deferred or unavailable rather than priced context", async () => {
    const absent = harness({ lookup: async () => { throw new ScreeningPriceBudgetError(); } });
    assert.equal((await absent.run(listing(), intent)).status, "DEFERRED");
    const failed = harness({ raw: async () => { throw new Error("Provider unavailable"); } });
    assert.equal((await failed.run(listing(), intent)).status, "UNAVAILABLE");
    const sparse = harness({ cards: [card({ variants: [variant(), variant("1st Edition Holofoil", "FIRST_EDITION")] })], raw: async (_id, label) => {
        if (label.startsWith("1st")) throw new ScreeningPriceBudgetError();
        return [sale()];
    } });
    const result = await sparse.run(listing({ title: "Charizard Base Set 4/102 Holo" }), intent);
    assert.equal(result.status, "DEFERRED"); assert.equal(result.references[0].summary.count, 1);
});

test("sparse sales remain observations and graded evidence uses an explicit older fallback window", async () => {
    const sparse = harness({ raw: async () => [sale({ price: 80 }), sale({ price: 100 })] });
    const raw = await sparse.run(listing(), intent);
    assert.equal(raw.status, "UNAVAILABLE"); assert.equal(raw.references[0].summary.count, 2); assert.equal(raw.references[0].summary.median, 90);
    const slab = harness({ graded: async () => three({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", grader: "PSA", grade: "8", sold_at: new Date(NOW - 100 * DAY).toISOString() }) });
    const old = await slab.run(listing({ title: "Charizard Base Set 4/102 Unlimited Holo PSA 8", isGraded: true }), intent);
    assert.equal(old.status, "AVAILABLE"); assert.equal(old.references[0].summary.windowDays, 180);
});

test("storage failures propagate rather than authorizing replacement research", async () => {
    for (const point of ["lookup", "raw"]) {
        const fail = async () => { throw new StorageUnavailableError("Saved evidence cannot be read"); };
        const { run, calls } = harness(point === "lookup" ? { lookup: fail } : { raw: fail });
        await assert.rejects(run(listing(), intent), StorageUnavailableError);
        assert.equal(calls.graded.length, 0);
    }
});

test("cancellation propagates and prevents a later market from starting", async () => {
    const controller = new AbortController();
    let release!: (sales: Comp[]) => void, started!: () => void;
    const gate = new Promise<Comp[]>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const { run, calls } = harness({ signal: controller.signal, cards: [card({ variants: [variant(), variant("1st Edition Holofoil", "FIRST_EDITION")] })], raw: async () => { started(); return gate; } });
    const pending = run(listing({ title: "Charizard Base Set 4/102 Holo" }), intent);
    await entered; controller.abort(new Error("stop sold screening")); release(three());
    await assert.rejects(pending, /stop sold screening/); assert.equal(calls.raw.length, 1);
});

test("unknown catalog variants and conflicting listing metadata cannot establish exact scope", async () => {
    const unknown = harness({ cards: [card({ variants: [variant(), variant("Unspecified Holofoil", "UNKNOWN")] })] });
    assert.equal((await unknown.run(listing({ title: "Charizard Base Set 4/102 Holo" }), intent)).exactScope, false);
    const conflicting = harness();
    const subject = listing({ screen: { status: "UNSCREENED", reason: null, bestCase: null, assumed: null, card: { name: "Charmander", set: "Base Set", cardNumber: "46/102", printing: "UNLIMITED", printingLabel: null } } });
    assert.equal((await conflicting.run(subject, intent)).status, "UNAVAILABLE"); assert.equal(conflicting.calls.lookup, 0);
});
