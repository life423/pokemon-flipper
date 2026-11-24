import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_REVIEW_OUTPUT_TOKENS, diagnosticReviewRequest, savedLegacyCliReview } from "../../server/analysis/search-diagnostic-review.ts";
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

test("new app reviews have more output room while existing saved requests keep their dispatch inputs", () => {
    const evidence = { assessment: { priced: 10, deals: 0 } };
    const original = diagnosticReviewRequest(evidence, 2);
    const current = diagnosticReviewRequest(evidence, 2, APP_REVIEW_OUTPUT_TOKENS);
    assert.equal(original.maxOutputTokens, 1000);
    assert.equal(current.maxOutputTokens, 1800);
    assert.match(current.instructions, /two sentences/);
    assert.doesNotMatch(original.instructions, /two sentences/);
    assert.deepEqual(current.schema, original.schema);
    assert.deepEqual(current.photos, []);
    assert.deepEqual(diagnosticReviewRequest(evidence, undefined, 1800), diagnosticReviewRequest(evidence));
});

test("the exact historical CLI request reopens its paid answer; new reviews use the report's own allowance", async () => {
    const sourceKey = "search-diagnostic-review:v1:6b53a431-09db-4d0c-aef5-8bb5a3c0fe43";
    const key = "analysis-experiment:v1:9dce40d2ab7c74614783fee96bccd70b1ffacf952b667edcb3e7d201859f0bb3";
    const current = diagnosticReviewRequest({ providerUsage: { originalSearchAiCapUsd: 0.1 }, assessment: { priced: 10 } });
    const record = { version: 1, key, model: "gpt-6-luna", answeredAt: "2026-01-01T00:00:00.000Z",
        result: { summary: "Historical diagnostic answer", proposedTasks: [] }, usage: { inputTokens: 110, outputTokens: 21 } };
    const replay = await savedLegacyCliReview(sourceKey, current, undefined, async (requested, age) => {
        assert.equal(requested, key);
        assert.equal(age, Infinity);
        return record;
    });
    assert.equal(replay?.reused, true);
    assert.deepEqual(replay?.result, record.result);
    assert.deepEqual(replay?.usage, record.usage);
    assert.equal(await savedLegacyCliReview(sourceKey, current, undefined, async () => null), null);
    assert.match(current.instructions, /reported AI allowance/);
    assert.doesNotMatch(current.instructions, /25-cent/);
    await assert.rejects(savedLegacyCliReview(sourceKey, current, undefined, async () => ({ ...record, key: "wrong" })), /invalid/);
});
