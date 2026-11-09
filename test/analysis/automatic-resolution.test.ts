import { test } from "node:test";
import assert from "node:assert/strict";
import { autoAnalysisBlockReason, canAutoAnalyze, resultGroup } from "../../shared/analysis.ts";
import { withResolvedCriteria } from "../../shared/search-criteria.ts";
import { readSearchByRules } from "../../server/search/intent.ts";
import { compareAnalysisPriority } from "../../shared/analysis-priority.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import type { ListingSummary, ScreeningSoldEvidence } from "../../shared/types.ts";

test("resolvable identity/finish/label gaps queue analysis without overriding explicit exclusions or price failures", () => {
    const listing: ListingSummary = { id: "1", title: "Aquapolis PSA 7", url: "#", currentPrice: 10, shipping: 0, buyingOption: "FIXED_PRICE", images: ["photo"], bids: 0, endTime: null, seller: null, isGraded: true, match: "UNCONFIRMED_CRITERIA", screen: { status: "UNSCREENED", reason: "Finish missing", card: null, assumed: null, bestCase: null, needsAnalysis: "FINISH" } };
    assert.equal(canAutoAnalyze(listing), true);
    assert.equal(resultGroup(listing, null), "candidates");
    assert.equal(canAutoAnalyze({ ...listing, images: [] }), false);
    assert.equal(canAutoAnalyze({ ...listing, match: "OTHER_GRADE" }), false);
    assert.equal(autoAnalysisBlockReason({ ...listing, screen: { ...listing.screen!, pricingIssue: { kind: "CONFIG", retryAt: null } } }), "PRICING_CONFIG");
    const cheap: ListingSummary = { ...listing, match: undefined, screen: { ...listing.screen!, needsAnalysis: undefined, priceAnomaly: { referencePrice: 1000, photoChecked: false } } };
    assert.equal(canAutoAnalyze(cheap), true, "an unusually low price calls for immediate AI verification, not delayed discovery");
    assert.equal(resultGroup(cheap, null), "candidates");
    const e = cardEvaluation(); e.identity!.finish = "HOLO";
    e.photoCheck!.slab = { present: true, grader: "PSA", grade: "7", gradeQualifier: null, certNumber: "123", labelText: "PSA 7", caseCondition: "INTACT", authenticity: "NONE_SEEN", concerns: [] };
    const intent = readSearchByRules("Aquapolis PSA 7 holo");
    assert.equal(withResolvedCriteria(listing, e, intent).match, undefined);
    assert.equal(withResolvedCriteria({ ...listing, match: "OTHER_GRADE" }, e, intent).match, "OTHER_GRADE");
    e.photoCheck!.slab = null;
    assert.equal(withResolvedCriteria(listing, e, intent).match, "UNCONFIRMED_CRITERIA", "raw predicted grades cannot satisfy a slab request");
});

test("price-first rejection defers automatic work while temporary gaps and verified discoveries can be resolved", () => {
    const listing: ListingSummary = { id: "1", title: "Raw card seller calls damaged", url: "#", currentPrice: 100, shipping: 7, buyingOption: "FIXED_PRICE", images: ["photo"], bids: 0, endTime: null, seller: null, isGraded: false,
        screen: { status: "DROPPED", reason: "Seller's price estimate does not clear targets", card: null, assumed: "Damaged", bestCase: null,
            money: { shipping: 7, auction: false, usual: null, paths: [{ label: "Sell raw", expectedNet: 50, fixedCosts: 0 }] } } };
    assert.equal(canAutoAnalyze(listing), false);
    assert.equal(resultGroup(listing, null), null);
    assert.equal(canAutoAnalyze({ ...listing, mistakes: [{ kind: "FIRST_EDITION", detail: "Photo shows an unmentioned edition stamp" }] }), true);
    const promising = { ...listing, id: "2", screen: { ...listing.screen!, status: "CANDIDATE" as const } };
    assert.ok(compareAnalysisPriority(promising, listing) < 0, "stronger leads retain priority");
    const temporary = { ...listing, screen: { ...listing.screen!, status: "UNSCREENED" as const, money: undefined, pricingIssue: { kind: "TEMPORARY" as const, retryAt: null } } };
    assert.equal(canAutoAnalyze(temporary), true);
    assert.equal(canAutoAnalyze({ ...listing, match: "OTHER_GRADE" }), false);
    assert.equal(canAutoAnalyze({ ...listing, images: [] }), false);
    assert.equal(canAutoAnalyze({ ...listing, availability: "UNAVAILABLE" }), false);
    assert.equal(canAutoAnalyze({ ...promising, currentPrice: 223_200 }), false);
    assert.equal(autoAnalysisBlockReason({ ...temporary, screen: { ...temporary.screen, pricingIssue: { kind: "CREDITS", retryAt: null } } }), "PRICING_CREDITS");
    const assessed = cardEvaluation(); assessed.underwriting!.verdict = "PASS";
    assert.equal(resultGroup(listing, assessed), null, "AI eligibility cannot turn an analyzed rejection into a Deal");
});

test("new sold-price screening keeps missing or deferred evidence in Sorting without paid follow-up", () => {
    const listing: ListingSummary = { id: "market-pending", title: "Charizard Base Set 4/102 English", url: "#", currentPrice: 10, shipping: 0,
        buyingOption: "FIXED_PRICE", images: ["photo"], bids: 0, endTime: null, seller: null, isGraded: false,
        mistakes: [{ kind: "FIRST_EDITION", detail: "A possible seller omission" }],
        screen: { status: "UNSCREENED", reason: "Matching recent sold evidence is unavailable.", card: null, assumed: null, bestCase: null,
            needsAnalysis: "IDENTITY", priceAnomaly: { referencePrice: 100, photoChecked: false }, pricingIssue: { kind: "TEMPORARY", retryAt: null } } };
    for (const status of ["UNAVAILABLE", "DEFERRED"] as const) {
        listing.screen!.soldEvidence = { status, exactScope: false, references: [], note: "Awaiting matching market data." };
        assert.equal(canAutoAnalyze(listing), false, "identity gaps, seller mistakes, unusual prices and temporary retries cannot bypass the sold-data gate");
        assert.equal(autoAnalysisBlockReason(listing), status === "DEFERRED" ? "SOLD_EVIDENCE_DEFERRED" : "SOLD_EVIDENCE_MISSING");
        assert.equal(resultGroup(listing, null), "candidates");
        assert.equal(resultGroup(listing, null, false, true), "review", "an explicit failed assessment remains distinct from unavailable prices");
        const exception = { ...listing, screen: { ...listing.screen!, focusedReview: "CHEAP_FIRST_EDITION_BASE_SET" as const } };
        assert.equal(autoAnalysisBlockReason(exception), null, "the explicit cheap first-edition research exception remains available");
        assert.equal(canAutoAnalyze({ ...exception, images: [] }), false);
        assert.equal(canAutoAnalyze({ ...exception, match: "OTHER_CARD" }), false);
        const completed = cardEvaluation(); completed.underwriting!.verdict = "BUY_RAW";
        assert.equal(resultGroup(listing, completed), "deals", "a completed assessment retains its own verdict");
    }
    assert.equal(canAutoAnalyze({ ...listing, screen: { ...listing.screen!, soldEvidence: undefined } }), true, "legacy screens retain their existing behavior");
});

test("a new sold-price rejection cannot be requeued by discovery, focused-review or pricing retry flags", () => {
    const evidence: ScreeningSoldEvidence = { status: "AVAILABLE", exactScope: true, references: [], note: "Matching sold prices were screened." };
    const listing: ListingSummary = { id: "market-rejected", title: "Charizard Base Set PSA 8 English", url: "#", currentPrice: 900, shipping: 0,
        buyingOption: "FIXED_PRICE", images: ["photo"], bids: 0, endTime: null, seller: null, isGraded: true,
        mistakes: [{ kind: "GENERIC_TITLE", detail: "Seller omitted some details" }],
        screen: { status: "DROPPED", reason: "Above the supported recent sold range.", card: null, assumed: null, bestCase: null,
            soldEvidence: evidence, focusedReview: "CHEAP_FIRST_EDITION_BASE_SET", needsAnalysis: "IDENTITY",
            pricingIssue: { kind: "TEMPORARY", retryAt: null } } };
    assert.equal(canAutoAnalyze(listing), false);
    assert.equal(resultGroup(listing, null), null, "a completed price screen is not a new manual task");
    const candidate = { ...listing, screen: { ...listing.screen!, status: "CANDIDATE" as const, focusedReview: undefined, pricingIssue: undefined } };
    assert.equal(canAutoAnalyze(candidate), true);
    const raw = { ...candidate, isGraded: false, screen: { ...candidate.screen, status: "UNSCREENED" as const } };
    assert.equal(canAutoAnalyze(raw), true, "available raw sold evidence still allows photo work for condition and grading potential");
});
