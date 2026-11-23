import "../fixtures/isolated-data.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluationContextKey } from "../../server/analysis/private-evaluation.ts";
import { findBinCompetition } from "../../server/deals/bin-competition.ts";
import { EbayError } from "../../server/ebay/api.ts";
import type { ListingDetails } from "../../server/ebay/listings.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { maxBid } from "../../shared/money/underwriting.ts";
import type { ListingSummary, ScreeningSoldReference } from "../../shared/types.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";

const now = Date.now();
const title = "PSA 9 Giratina V 186/196 Alt Alternate Art Pokemon Lost Origin MINT 138177850";
const reference: ScreeningSoldReference = { name: "Giratina V (Alternate Full Art) (Secret)", set: "Lost Origin", cardNumber: "186/196",
    recordId: 1, grader: "PSA", grade: "9", printing: "UNLIMITED", finish: "HOLO", condition: null, summary: salesSummary("PSA", 9) };
const targets = { minProfit: 10, minRoi: 0.1 };
const expectedNet = 760;
const row = (index: number, price: number, suffix = ""): ListingSummary => ({
    id: `v1|12345678900${index}|0`, title: title + suffix, currentPrice: price,
    shipping: 0, images: [], seller: null, url: "https://example.com/", isGraded: true, buyingOption: "FIXED_PRICE", bids: 0, endTime: null,
});
const detail = (row: ListingSummary, shipping: number | null): ListingDetails => ({
    ...row, retrievedAt: new Date(now).toISOString(), availability: "ACTIVE", price: row.currentPrice, shipping, condition: "Graded",
    cardCondition: null, conditionNotes: [], aspects: { "Card Name": "Giratina V", Set: "Pokemon Lost Origin", "Card Number": "186", Language: "English",
        Finish: "Full Art", "Professional Grader": "Professional Sports Authenticator (PSA)", Grade: "9" },
});

test("compares delivered terms for the cheapest exact matches from one bounded page", async () => {
    const wrongFinish = row(0, 10, " reverse holo"), badGrade = row(1, 20, " PSA 9 OC"), gone = row(2, 100),
        lowerItem = row(3, 740), lowerDelivered = row(4, 750), unvisited = row(5, 765);
    const checked: string[] = [];
    const signal = new AbortController().signal;
    const result = await findBinCompetition("Giratina V Lost Origin 186 PSA 9", reference, expectedNet, targets, undefined, signal, {
        now: () => now,
        search: async (_query, options) => {
            assert.deepEqual(options, { maxResults: 200, sort: "price", keepReserve: true, signal,
                filters: { typeFilter: "FIXED_PRICE", kindFilter: "graded" } });
            return { listings: [wrongFinish, badGrade, lowerDelivered, unvisited, gone, lowerItem], total: 6, skipped: 0 };
        },
        details: async (id, options) => {
            assert.equal(options?.signal, signal);
            assert.equal(options?.keepReserve, true);
            checked.push(id);
            if (id === gone.id) throw new EbayError("Gone", 410);
            if (id === lowerItem.id) return detail(lowerItem, 30);
            if (id === lowerDelivered.id) return detail(lowerDelivered, 0);
            return assert.fail("Unexpected detail lookup");
        },
        loadEvaluation: async () => null,
    });
    assert.deepEqual(checked, [gone.id, lowerItem.id, lowerDelivered.id]);
    assert.deepEqual(result, { title, url: "https://www.ebay.com/itm/123456789004", price: 750, shipping: 0,
        ceiling: maxBid({ expectedNet, fixedCosts: 0, shipping: 0 }, { ...MONEY_CONFIG, targets }), identity: "LISTING" });
});

test("requires fresh active terms with a destination quote and does not override a saved assessment", async () => {
    const unquoted = row(0, 700), stale = row(1, 705), conflict = row(2, 709);
    const details = new Map([
        [unquoted.id, detail(unquoted, null)],
        [stale.id, { ...detail(stale, 0), retrievedAt: new Date(now - 120_001).toISOString() }],
        [conflict.id, detail(conflict, 0)],
    ]);
    const checked: string[] = [];
    const result = await findBinCompetition("Giratina V", reference, expectedNet, targets, undefined, undefined, {
        now: () => now,
        search: async () => ({ listings: [unquoted, stale, conflict], total: 3, skipped: 0 }),
        details: async id => details.get(id)!,
        loadEvaluation: async id => {
            checked.push(id);
            return { version: 1, contextKey: evaluationContextKey(details.get(id)!), evidenceKey: "unused", evaluation: cardEvaluation() };
        },
    });
    assert.deepEqual(checked, [conflict.id]);
    assert.equal(result, undefined);
});

test("uses matching saved label evidence over incomplete eBay specifics", async () => {
    const candidate = row(0, 780);
    const listing = { ...detail(candidate, 9), aspects: {} };
    const evaluation = cardEvaluation();
    evaluation.identity = { ...evaluation.identity!, name: "Giratina V", set: "Lost Origin", cardNumber: "186/196" };
    evaluation.photoCheck = { ...evaluation.photoCheck!, cardCount: "ONE", holder: "GRADED_SLAB", slab: {
        present: true, grader: "PSA", grade: "9", gradeQualifier: null, certNumber: null, labelText: "LOST ORIGIN GIRATINA V #186 MINT 9",
        caseCondition: "INTACT", authenticity: "NONE_SEEN", authenticityEvidence: [], concerns: [],
    } };
    evaluation.slab = { status: "OK", grader: "PSA", grade: "9", gradeQualifier: null, certNumber: null, certUrl: null, labelText: null,
        caseCondition: "INTACT", reasons: [], concerns: [] };
    const result = await findBinCompetition("Giratina V", reference, expectedNet, targets, 600, undefined, {
        now: () => now,
        search: async () => ({ listings: [candidate], total: 1, skipped: 0 }),
        details: async () => listing,
        loadEvaluation: async () => ({ version: 1, contextKey: evaluationContextKey(listing), evidenceKey: "unused", evaluation }),
    });
    assert.equal(result?.identity, "PHOTO");
    assert.equal(result?.shipping, 9);
    assert.equal(result?.ceiling, 600);
});
