import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSearchLocally, readSearchWithoutAi } from "../../server/search/intent.ts";
import { readTitleByRules } from "../../server/ai/title-reader.ts";
import { findDeals } from "../../server/deals/find-deals.ts";
import { writeCache } from "../../server/lib/cache.ts";
import { MODEL } from "../../server/ai/openai.ts";
import { describeSearchCriteria, evaluatedCriteriaMismatch, marketplaceQuery } from "../../shared/search-criteria.ts";
import { filterSearchResults, groupSearchResults, countSearchResults } from "../../client/src/search/results.ts";
import { describeIntent } from "../../client/src/search/presentation.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import type { Evaluation, ListingSummary } from "../../shared/types.ts";
import type { AnalysisState } from "../../client/src/analysis-state.ts";
import { resolveQueryCatalog } from "../../server/search/catalog.ts";
import { createScreeningPriceSource } from "../../server/pricing/pkmnprices.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import { PriceResearchBudgetError } from "../../server/pricing/research-budget.ts";
import type { CardRecord } from "../../server/pricing/types.ts";

const baseQuery = "dark blastoise team rocket";
const phrases = [
    [baseQuery, null, "Any finish"],
    [`${baseQuery} holo`, "HOLO", "Holo only"],
    [`${baseQuery} reverse holo`, "REVERSE_HOLO", "Reverse holo only"],
    [`${baseQuery} non-holo`, "NON_HOLO", "Non-holo only"],
] as const;

function listing(id: string, title: string): ListingSummary {
    return { id, title, currentPrice: 60, shipping: 0, buyingOption: "FIXED_PRICE", bids: 0, isGraded: false,
        images: [`https://i.ebayimg.com/images/g/offline-${id}/s-l1600.jpg`], url: "#", seller: null, endTime: null };
}
function photoAssessment(item: ListingSummary, finish: "HOLO" | "REVERSE_HOLO" | "NON_HOLO", cardNumber: string): Evaluation {
    const value = cardEvaluation();
    value.listing = { ...value.listing, id: item.id, title: item.title, buyingOption: "FIXED_PRICE", endTime: null,
        aspects: { Finish: "Holo" }, photos: item.images };
    value.identity = { ...value.identity!, status: "NEEDS_REVIEW", name: "Dark Blastoise", set: "Team Rocket", cardNumber,
        finish: "UNKNOWN", reasons: ["Seller details conflict with the visible card."] };
    value.photoCheck = { ...value.photoCheck!, cardCount: "ONE", cardIdentity: { name: "Dark Blastoise", set: "Team Rocket", cardNumber,
        language: "English", finish, confidence: "HIGH", evidence: ["The card number and the actual finish are established in this saved fixture."] } };
    value.underwriting = { verdict: "NEEDS_REVIEW", reasons: ["Seller details conflict."], assumptions: [], best: null, paths: [] };
    return value;
}
const filters = { typeFilter: "all", kindFilter: "all", minPrice: "", maxPrice: "", minGrade: 0 } as const;

test("finish is explicitly displayed and never invented for a query that did not request one", () => {
    for (const [query, expected, label] of phrases) {
        const intent = readSearchLocally(query);
        assert.equal(intent.finish, expected);
        assert.ok(describeSearchCriteria(intent).includes(label));
        assert.match(describeIntent(intent), new RegExp(label));
        const keywords = marketplaceQuery(query, intent);
        if (expected) assert.match(keywords, expected === "REVERSE_HOLO" ? /reverse holo/ : expected === "NON_HOLO" ? /non-holo/ : /holo/);
    }
});

test("saved intent cannot erase a typed holo constraint or add one to an unconstrained query", async t => {
    t.mock.method(globalThis, "fetch", async () => assert.fail("saved intent correction must not call providers"));
    for (const [query, expected] of phrases) {
        await writeCache(`search-intent:v2:${MODEL}:${query}`, { ...readSearchLocally(query), finish: expected === "HOLO" ? "NON_HOLO" : "HOLO" });
        assert.equal((await readSearchWithoutAi(query)).finish, expected);
    }
});

test("bounded admission excludes explicit wrong finishes before paid work and does not narrow any-finish searches", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("metadata finish screening cannot buy any provider work"));
    const rows = [listing("holo", "Dark Blastoise Team Rocket 3/82 Holo English"),
        listing("reverse", "Dark Blastoise Team Rocket Reverse Holo English"),
        listing("non-holo", "Dark Blastoise Team Rocket 20/82 Non-Holo English")];
    for (const [query, expected] of phrases) {
        let sources = 0;
        const result = await findDeals(query, { filters: { typeFilter: "FIXED_PRICE" } }, {
            readIntent: async () => readSearchLocally(query),
            readTitle: async title => readTitleByRules(title),
            screening: () => assert.fail("no paid preliminary screening"),
            search: async (_query, options) => { sources++; assert.equal(options?.maxResults, 200); return { listings: rows, total: rows.length, skipped: 0 }; },
        });
        assert.deepEqual(result.map(row => row.id), expected === "HOLO" ? ["holo"] : expected === "REVERSE_HOLO" ? ["reverse"] : expected === "NON_HOLO" ? ["non-holo"] : rows.map(row => row.id));
        assert.equal(sources, 1);
    }
    assert.equal(fetch.mock.callCount(), 0);
});

test("saved physical finishes exclude wrong copies from All and attention, despite matching seller holo claims", () => {
    const rows = [listing("holo", "Dark Blastoise Team Rocket Holo"), listing("reverse", "Dark Blastoise Team Rocket Holo"), listing("non-holo", "Dark Blastoise Team Rocket Holo")];
    const finishes = ["HOLO", "REVERSE_HOLO", "NON_HOLO"] as const;
    const analyses: Record<string, AnalysisState> = Object.fromEntries(rows.map((row, index) => [row.id,
        { status: "done", evidenceKey: row.id, evaluation: photoAssessment(row, finishes[index], index === 2 ? "20/82" : "3/82") }]));
    for (const [query, finish] of phrases) {
        const intent = readSearchLocally(query);
        const visible = filterSearchResults({ listings: rows, analyses, intent, filters, page: "search", now: Date.now() });
        const expected = finish ? [rows[finishes.indexOf(finish)].id] : rows.map(row => row.id);
        assert.deepEqual(visible.map(row => row.id), expected);
        const groups = groupSearchResults(visible, analyses, false, new Set());
        assert.deepEqual(groups.all.map(row => row.id), expected);
        assert.deepEqual(groups.review.map(row => row.id), expected, "known wrong finish is excluded, not sent to attention");
        assert.equal(countSearchResults({ listings: rows, analyses, intent, page: "search", newMode: false, newIds: new Set() }).mismatched, finish ? 2 : 0);
    }
});

test("collector-number requests distinguish3/82from20/82 without inferring a finish from flat lighting", () => {
    const item = listing("non-holo", "Dark Blastoise Team Rocket");
    const confirmed = photoAssessment(item, "NON_HOLO", "20/82");
    const requested = readSearchLocally("dark blastoise 3/82");
    assert.equal(requested.finish, null, "a number constraint is not an invented finish claim");
    assert.equal(evaluatedCriteriaMismatch(confirmed, requested), true);
    const unknown = structuredClone(confirmed);
    unknown.identity = { ...unknown.identity!, cardNumber: null };
    unknown.photoCheck!.cardIdentity = { ...unknown.photoCheck!.cardIdentity!, cardNumber: null, finish: "UNKNOWN", confidence: "LOW", evidence: [] };
    assert.equal(evaluatedCriteriaMismatch(unknown, readSearchLocally(baseQuery)), false, "an unconstrained search cannot reject a card from absent reflections alone");
});

const catalogCard = (number: string, finish = "HOLO"): CardRecord => ({ source: "pkmnprices", id: number, name: "Dark Blastoise", setName: "Team Rocket",
    cardNumber: number, tcgPlayerId: null, variants: ["FIRST_EDITION", "UNLIMITED"].map(printing => ({ name: `${printing} ${finish}`, printing, finish, prices: [] })) });

test("the exact conversational holo request resolves through catalog before one eBay page and excludes the other numbered card", async t => {
    const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("query and listing sources are supplied offline"));
    const query = "find me a good deal on a holographic dark blastoise team rocket";
    const cards = [catalogCard("3/82"), catalogCard("20/82", "NON_HOLO")];
    const events: string[] = []; let factories = 0, summary;
    const source = { ...createScreeningPriceSource({ maxRequests: 0 }),
        lookupQueryCards: async value => { events.push("catalog"); assert.deepEqual(value, { name: "dark blastoise", set: "Team Rocket" }); return { cards, complete: true }; },
        lookupCards: async value => { events.push("listing-catalog"); assert.equal(value.cardNumber, "3/82"); return cards; },
        fetchRawComps: async () => [], fetchComps: async () => [], fetchSoldPage: async () => ({ sales: [], nextCursor: null }) };
    const rows = [listing("holo", "Dark Blastoise Team Rocket 3/82 Holo English"), listing("no-number", "Dark Blastoise Team Rocket Holo English"),
        listing("wrong-number", "Dark Blastoise Team Rocket 20/82 Holo English"), listing("non-holo", "Dark Blastoise Team Rocket 20/82 Non-Holo English"),
        listing("reverse", "Dark Blastoise Team Rocket 3/82 Reverse Holo English")];
    const result = await findDeals(query, { filters: { typeFilter: "FIXED_PRICE", kindFilter: "raw" }, onStart: value => { summary = value; } }, {
        readIntent: async value => readSearchLocally(value), readTitle: async value => readTitleByRules(value),
        priceSource: () => { factories++; return source; },
        search: async (keywords, options) => { events.push("ebay"); assert.equal(keywords, "holo dark blastoise team rocket");
            assert.ok(!keywords.includes("3/82"), "derived numbers must not exclude numberless eBay titles");
            assert.deepEqual(options.filters, { typeFilter: "FIXED_PRICE", kindFilter: "raw" }); assert.equal(options.maxResults, 200);
            return { listings: rows, total: rows.length, skipped: 0 }; },
    });
    assert.deepEqual(events.slice(0, 2), ["catalog", "ebay"]); assert.equal(factories, 1);
    assert.deepEqual(result.map(row => row.id), ["holo", "no-number"]);
    assert.equal(summary.intent.cardNumber, "3/82"); assert.equal(summary.intent.printing, null); assert.equal(summary.intent.graded, null);
    assert.equal(fetch.mock.callCount(), 0);
});

test("catalog resolution preserves edition and holder controls and refuses incomplete or ambiguous identity evidence", async () => {
    const intent = readSearchLocally("Dark Blastoise Team Rocket holo"), cards = [catalogCard("3/82"), catalogCard("20/82", "NON_HOLO")];
    const before = structuredClone(intent);
    const resolved = await resolveQueryCatalog(intent, async () => ({ cards, complete: true }));
    assert.equal(resolved.cardNumber, "3/82"); assert.equal(resolved.keywords, intent.keywords); assert.deepEqual(intent, before);
    const graded = readSearchLocally("Dark Blastoise Team Rocket first edition holo PSA 8");
    assert.deepEqual(await resolveQueryCatalog(graded, async () => ({ cards, complete: true })), { ...graded, cardNumber: "3/82" });
    for (const result of [
        { cards, complete: false }, { cards: [catalogCard("3")], complete: true },
        { cards: [cards[0], catalogCard("4/82")], complete: true },
        { cards: [cards[0], { ...cards[1], variants: [] }], complete: true },
        { cards: [{ ...cards[0], variants: [{ ...cards[0].variants[0], printing: "UNKNOWN" }] }], complete: true },
        { cards: [{ ...cards[0], variants: [{ ...cards[0].variants[0], finish: "UNKNOWN" }] }], complete: true },
        { cards: [{ ...cards[0], name: "Blaine's Blastoise" }], complete: true },
        { cards: [{ ...cards[0], setName: "Base Set" }], complete: true },
    ]) assert.equal(await resolveQueryCatalog(intent, async () => result), intent);
    const explicit = readSearchLocally("Dark Blastoise Team Rocket 20/82 holo");
    assert.equal(await resolveQueryCatalog(explicit, async () => assert.fail("an explicit number cannot be replaced")), explicit);
    const anyFinish = readSearchLocally(baseQuery);
    assert.equal(await resolveQueryCatalog(anyFinish, async () => assert.fail("an unspecified finish must remain open")), anyFinish);
    const lettered = readSearchLocally("Espeon Aquapolis holo");
    const letteredCard = { ...cards[0], name: "Espeon", setName: "Aquapolis", cardNumber: "H9/H32", variants: [cards[0].variants[1]] };
    assert.equal((await resolveQueryCatalog(lettered, async () => ({ cards: [letteredCard], complete: true }))).cardNumber, "H9/H32");
});

test("query catalog outages preserve the original intent while cancellation, storage and invalid accounting fail closed", async () => {
    const intent = readSearchLocally("Dark Blastoise Team Rocket holo");
    for (const error of [new Error("Provider unavailable"), new PriceResearchBudgetError("Allowance exhausted", "LIMIT")]) {
        assert.equal(await resolveQueryCatalog(intent, async () => { throw error; }), intent);
    }
    for (const error of [new StorageUnavailableError(), new PriceResearchBudgetError("Invalid ledger", "STATE")]) {
        await assert.rejects(resolveQueryCatalog(intent, async () => { throw error; }), value => value === error);
    }
    const stopped = new AbortController();
    await assert.rejects(resolveQueryCatalog(intent, async () => { stopped.abort(new Error("Stopped")); return { cards: [catalogCard("3/82")], complete: true }; }, stopped.signal), /Stopped/);
    const cancelled = new AbortController();
    const source = { ...createScreeningPriceSource({ maxRequests: 0 }), lookupQueryCards: async () => {
        cancelled.abort(new Error("Stopped before marketplace search")); return { cards: [catalogCard("3/82")], complete: true };
    } };
    assert.deepEqual(await findDeals(`${baseQuery} holo`, { signal: cancelled.signal }, {
        readIntent: async () => intent, readTitle: async value => readTitleByRules(value), priceSource: () => source,
        search: async () => assert.fail("cancelled catalog resolution cannot start an eBay request"),
    }), []);
});
