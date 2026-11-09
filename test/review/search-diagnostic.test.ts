import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeSearchDiagnostic } from "../../scripts/review-search-diagnostic.ts";

test("search review uses aggregate evidence under the original search account and discards source text", () => {
    const searchId = "6b53a431-09db-4d0c-aef5-8bb5a3c0fe43";
    const marker = "private listing text https://example.com/seller";
    const report = {
        searchId, query: marker, search: { found: 5, pricePass: { newListings: 4, candidates: 1 } },
        rows: [{ id: marker, title: marker, soldStatus: "UNAVAILABLE", soldNote: `No usable recent matched sale. ${marker}` }],
        assessments: { [marker]: { photoCheck: true, verdict: "NEEDS_REVIEW" }, second: { photoCheck: true, verdict: "NEEDS_REVIEW" } },
        usage: { budget: { searchId, capUsd: 0.1, attempts: 1 } },
        reasons: [marker], deals: [],
    };
    const evidence = summarizeSearchDiagnostic(report, searchId, [
        { reason: "SELLER_NAME_CONFLICT", count: 1, resolvedAfterRecheck: 1, losingAfterRecheck: 1, note: marker },
        { reason: "GRADER_UNREADABLE", count: 1, resolvedAfterRecheck: 0, losingAfterRecheck: 0 },
    ]);
    assert.equal(evidence.discovery.retained, 1);
    assert.equal(evidence.discovery.lowerPricePassNewSourceRows, 4);
    assert.equal(evidence.discovery.lowerPricePassAddedAssessmentCandidates, 1);
    assert.equal(evidence.screening.noUsableRecentSale, 1);
    assert.equal(evidence.assessment.holds, 2);
    assert.equal(evidence.providerUsage.originalSearchAiCapUsd, 0.1);
    assert.deepEqual(evidence.reviewHolds, [
        { reason: "SELLER_NAME_CONFLICT", count: 1, resolvedAfterRecheck: 1, losingAfterRecheck: 1, stillUnresolved: 0 },
        { reason: "GRADER_UNREADABLE", count: 1, resolvedAfterRecheck: 0, losingAfterRecheck: 0, stillUnresolved: 1 },
    ]);
    assert.ok(!JSON.stringify(evidence).includes(marker));
    assert.ok(!JSON.stringify(evidence).includes(searchId));
    assert.throws(() => summarizeSearchDiagnostic(report, "e8ec1f96-7a70-4ca8-a25e-1f9be8d17199"), /matching original search UUID/);
    assert.throws(() => summarizeSearchDiagnostic(report, searchId, [
        { reason: marker, count: 1, resolvedAfterRecheck: 1, losingAfterRecheck: 1 },
    ]), /recognized reason/);
    assert.throws(() => summarizeSearchDiagnostic(report, searchId, [
        { reason: "GRADER_UNREADABLE", count: 1, resolvedAfterRecheck: 0, losingAfterRecheck: 1 },
    ]), /losses do not exceed resolved rechecks/);
});
