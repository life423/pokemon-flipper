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
        const result = await findDeals(query, { bounded: true, filters: { typeFilter: "FIXED_PRICE" } }, {
            readIntent: async () => assert.fail("no paid query reading"), readIntentWithoutAi: async () => readSearchLocally(query),
            readTitle: async () => assert.fail("no paid title reading"), readTitleWithoutAi: async title => readTitleByRules(title),
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
