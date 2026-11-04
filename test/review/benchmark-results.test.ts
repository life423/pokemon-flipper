import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateAdmission, summarizeBenchmark, compareAnalysisPriority } from "../../scripts/review/benchmark-results.ts";
import { canAutoAnalyze } from "../../shared/analysis.ts";
import { englishListingEligible } from "../../shared/card-language.ts";
import { matchesListingFilters } from "../../shared/listing-filters.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import type { Evaluation, ListingSummary, ScreeningSoldEvidence, SearchIntent } from "../../shared/types.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const targets = { minProfit: 0, minRoi: 0 };
const intent: SearchIntent = { cardName: "Venusaur", sets: ["Base Set"], cardNumber: "15/102", printing: null, finish: "HOLO", graded: null, titleWords: ["venusaur"], source: "rules" };
const sold = (status: ScreeningSoldEvidence["status"] = "AVAILABLE"): ScreeningSoldEvidence => ({ status, exactScope: false, references: [], note: "Offline screening status; no sold price is asserted." });
const listing = (id: string, change: Partial<ListingSummary> = {}): ListingSummary => ({ id, title: "Venusaur Base Set 15/102 Holo English", currentPrice: 100, shipping: 0, bids: 0, isGraded: false,
    buyingOption: "FIXED_PRICE", endTime: null, availability: "ACTIVE", images: ["https://example.invalid/front.jpg"], url: "https://example.invalid/listing", seller: null,
    screen: { status: "UNSCREENED", reason: "Raw identity still needs assessment.", card: null, bestCase: null, assumed: null, needsAnalysis: "IDENTITY", soldEvidence: sold() }, ...change });
function evaluation(item: ListingSummary, actualPrice: number, resale = 150): Evaluation {
    const value = structuredClone(cardEvaluation(targets));
    value.listing = { ...value.listing, id: item.id, title: item.title, url: item.url, price: actualPrice, shipping: item.shipping, buyingOption: item.buyingOption, bids: item.bids,
        endTime: item.endTime, availability: item.availability, photos: item.images, photosInListing: item.images.length, photosAnalyzed: item.images.length,
        termsCheckedAt: new Date(NOW).toISOString(), aspects: { Language: "English" } };
    value.photoCheck!.cardCount = "ONE";
    value.condition!.gradeRange = null;
    value.rawPricing = { status: "PRICED", prices: [{ condition: "LIGHTLY_PLAYED", price: resale, updatedAt: new Date(NOW).toISOString() }] };
    value.gradedPricing = null;
    value.usage = []; value.reusedSteps = [];
    return value;
}

test("admission diagnostics use the canonical eligibility result and preserve the actual screen explanation", t => {
    t.mock.method(Date, "now", () => NOW);
    const filters = { typeFilter: "FIXED_PRICE" as const, kindFilter: "all" as const, maxPrice: 1000, minPrice: 0 };
    const valid = listing("eligible");
    const rows = [valid, listing("no-photo", { images: [] }), listing("foreign", { title: "Venusaur Japanese" }),
        listing("over-ceiling", { currentPrice: 200001 }), listing("filtered", { currentPrice: 1500 }),
        listing("late", { buyingOption: "AUCTION", endTime: new Date(NOW + 13 * 3600000).toISOString() }),
        listing("invalid-end", { buyingOption: "AUCTION", endTime: null }),
        listing("expired", { buyingOption: "AUCTION", endTime: new Date(NOW - 1).toISOString() })];
    for (const row of rows) {
        const result = candidateAdmission(row, filters, NOW, targets);
        assert.equal(result.eligible, canAutoAnalyze(row) && englishListingEligible(row) && matchesListingFilters(row, filters));
        assert.equal(result.screenReason, row.screen?.reason);
    }
    assert.equal(candidateAdmission(valid, filters, NOW, targets).eligible, true);
    assert.ok(candidateAdmission(rows[1], filters, NOW).reasons.includes("NO_PHOTOS"));
    assert.ok(candidateAdmission(rows[2], filters, NOW).reasons.includes("OTHER_LANGUAGE"));
    assert.ok(candidateAdmission(rows[3], filters, NOW).reasons.includes("AUTOMATIC_PRICE_CEILING"));
    assert.ok(candidateAdmission(rows[4], filters, NOW).reasons.includes("FILTER_MISMATCH"));
    assert.ok(candidateAdmission(rows[5], filters, NOW).reasons.includes("OUTSIDE_AUCTION_WINDOW"));
    assert.ok(candidateAdmission(rows[6], filters, NOW).reasons.includes("INVALID_AUCTION_END"));
    assert.ok(candidateAdmission(rows[7], filters, NOW).reasons.includes("ENDED_AUCTION"));
});

test("deferred sold data and exceptions are diagnosed without inventing an extra admission restriction", t => {
    t.mock.method(Date, "now", () => NOW);
    const deferred = listing("deferred"); deferred.screen!.soldEvidence = sold("DEFERRED");
    const exception = structuredClone(deferred); exception.id = "exception"; exception.screen!.focusedReview = "CHEAP_FIRST_EDITION_BASE_SET";
    const dropped = listing("drop"); dropped.screen!.status = "DROPPED";
    assert.equal(candidateAdmission(deferred).eligible, false);
    assert.ok(candidateAdmission(deferred).reasons.includes("SOLD_DEFERRED"));
    assert.equal(candidateAdmission(exception).eligible, true);
    assert.ok(candidateAdmission(exception).reasons.includes("FOCUSED_FIRST_EDITION_EXCEPTION"));
    assert.equal(candidateAdmission(dropped).eligible, false);
    assert.ok(candidateAdmission(dropped).reasons.includes("SOLD_DROPPED"));
});

test("Any/Any priority and exported comparison follow the real client ranking", () => {
    const item = listing("comparison");
    item.screen!.money = { shipping: 0, paths: [{ path: "RAW", label: "Offline resale comparison", expectedNet: 150, fixedCosts: 0, compCount: 3, compConfidence: "MEDIUM" }], auction: false, usual: null };
    const easy = candidateAdmission(item, {}, NOW, targets);
    const strict = candidateAdmission(item, {}, NOW, { minProfit: 100, minRoi: 0 });
    assert.equal(easy.priority.band, 2); assert.equal(strict.priority.band, 0);
    assert.equal(compareAnalysisPriority(item, item, targets), 0);
    const newer = listing("z-newest"), older = listing("a-older");
    assert.deepEqual([newer, older].sort((a, b) => compareAnalysisPriority(a, b, targets)).map(row => row.id),
        ["z-newest", "a-older"], "benchmark and browser queue retain the supplied newest/source order on equal priorities");
});

test("summary uses current server terms, recalculates verdicts and separates all loaded work from matching views", t => {
    t.mock.method(Date, "now", () => NOW);
    t.mock.method(globalThis, "fetch", () => { throw new Error("Pure benchmark reporting cannot fetch anything"); });
    const win = listing("win", { currentPrice: 999 });
    const pass = listing("pass", { currentPrice: 10 });
    const hidden = listing("foreign-evaluation");
    const pending = listing("pending"); pending.screen!.soldEvidence = sold("DEFERRED");
    const failed = listing("failed");
    const winning = evaluation(win, 10); winning.usage = [{ step: "boundedPhotoAssessment", inputTokens: 100, outputTokens: 50 }];
    const passing = evaluation(pass, 500); passing.reusedSteps = ["savedEvaluation"];
    const foreign = evaluation(hidden, 10); foreign.listing.aspects.Language = "Japanese";
    foreign.usage = [{ step: "boundedPhotoAssessment", inputTokens: null, outputTokens: 200 }];
    const metadata = [win, pass, hidden, pending, failed];
    const evaluations = { win: winning, pass: passing, [hidden.id]: foreign };
    const before = JSON.stringify({ metadata, evaluations });
    const result = summarizeBenchmark(metadata, evaluations, { failed: "Offline provider error" }, intent, targets, { now: NOW });
    assert.deepEqual(result.groups.all, ["win", "pass", "pending", "failed"]);
    assert.deepEqual(result.groups.deals, ["win"]); assert.deepEqual(result.groups.candidates, ["pending"]); assert.deepEqual(result.groups.review, ["failed"]);
    assert.equal(result.analyses.pass.status, "done");
    if (result.analyses.pass.status === "done") assert.equal(result.analyses.pass.evaluation.underwriting?.verdict, "PASS");
    assert.equal(result.listings.find(item => item.id === "win")?.currentPrice, 10);
    assert.deepEqual(result.counts, { metadataLoaded: 5, evaluationsReturned: 3, photoAssessed: 3, resultsWithGenerationUsage: 2, resultsWithReusedEvidence: 1,
        errors: 1, unassessed: 2, visibleMatching: 4, excludedFromMatching: 1, deals: 1, offers: 0, sorting: 1, needsAttention: 1 });
    assert.deepEqual(result.usage.stages, [{ step: "boundedPhotoAssessment", returnedStages: 2, reportedInputTokens: 100, reportedOutputTokens: 250, unreportedStages: 1 }]);
    assert.match(result.usage.source, /search usage ledger/);
    assert.equal(JSON.stringify({ metadata, evaluations }), before, "reporting cannot rewrite saved paid evidence or metadata");
});

test("new targets and listing expiry use final UI rules without reducing the measured assessment count", t => {
    t.mock.method(Date, "now", () => NOW);
    const open = listing("open"), ended = listing("ended");
    const endedEvaluation = evaluation(ended, 10); endedEvaluation.listing.availability = "UNAVAILABLE";
    const result = summarizeBenchmark([open, ended], { open: evaluation(open, 10), ended: endedEvaluation }, {}, intent, { minProfit: 1000, minRoi: 0 }, { now: NOW });
    assert.equal(result.counts.evaluationsReturned, 2); assert.equal(result.counts.photoAssessed, 2);
    assert.deepEqual(result.groups.all, ["open"]); assert.deepEqual(result.groups.deals, []); assert.deepEqual(result.groups.review, []);
});

test("latest metadata replaces duplicate rows and unrelated stored results do not inflate the benchmark", t => {
    t.mock.method(Date, "now", () => NOW);
    const first = listing("same", { currentPrice: 50 }), latest = listing("same", { currentPrice: 100 });
    const unrelated = evaluation(listing("unrelated"), 10);
    const result = summarizeBenchmark([first, latest], { unrelated }, { unrelated: "Not part of this search" }, intent, targets, { now: NOW });
    assert.equal(result.counts.metadataLoaded, 1); assert.equal(result.counts.evaluationsReturned, 0); assert.equal(result.counts.errors, 0);
    assert.equal(result.listings[0].currentPrice, 100); assert.deepEqual(result.groups.all, ["same"]);
});
