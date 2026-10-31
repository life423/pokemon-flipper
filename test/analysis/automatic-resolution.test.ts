import { test } from "node:test";
import assert from "node:assert/strict";
import { canAutoAnalyze, resultGroup } from "../../shared/analysis.ts";
import { withResolvedCriteria } from "../../shared/search-criteria.ts";
import { readSearchByRules } from "../../server/search/intent.ts";
import { compareAnalysisPriority } from "../../shared/analysis-priority.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import type { ListingSummary } from "../../shared/types.ts";

test("resolvable identity/finish/label gaps queue analysis without overriding explicit exclusions or price failures", () => {
    const listing: ListingSummary = { id: "1", title: "Aquapolis PSA 7", url: "#", currentPrice: 10, shipping: 0, buyingOption: "FIXED_PRICE", images: ["photo"], bids: 0, endTime: null, seller: null, isGraded: true, match: "UNCONFIRMED_CRITERIA", screen: { status: "UNSCREENED", reason: "Finish missing", card: null, assumed: null, bestCase: null, needsAnalysis: "FINISH" } };
    assert.equal(canAutoAnalyze(listing), true);
    assert.equal(resultGroup(listing, null), "candidates");
    assert.equal(canAutoAnalyze({ ...listing, images: [] }), false);
    assert.equal(canAutoAnalyze({ ...listing, match: "OTHER_GRADE" }), false);
    assert.equal(canAutoAnalyze({ ...listing, screen: { ...listing.screen!, pricingIssue: { kind: "CONFIG", retryAt: null } } }), false);
    const cheap: ListingSummary = { ...listing, match: undefined, screen: { ...listing.screen!, needsAnalysis: undefined, priceAnomaly: { referencePrice: 1000, photoChecked: false } } };
    assert.equal(canAutoAnalyze(cheap), true, "an unusually low price calls for immediate AI verification, not delayed discovery");
    assert.equal(resultGroup(cheap, null), "candidates");
    assert.equal(canAutoAnalyze({ ...cheap, screen: { ...cheap.screen!, status: "CANDIDATE", longShot: true } }), true, "auction likelihood must not prohibit photo verification");
    const e = cardEvaluation(); e.identity!.finish = "HOLO";
    e.photoCheck!.slab = { present: true, grader: "PSA", grade: "7", gradeQualifier: null, certNumber: "123", labelText: "PSA 7", caseCondition: "INTACT", authenticity: "NONE_SEEN", concerns: [] };
    const intent = readSearchByRules("Aquapolis PSA 7 holo");
    assert.equal(withResolvedCriteria(listing, e, intent).match, undefined);
    assert.equal(withResolvedCriteria({ ...listing, match: "OTHER_GRADE" }, e, intent).match, "OTHER_GRADE");
    e.photoCheck!.slab = null;
    assert.equal(withResolvedCriteria(listing, e, intent).match, "UNCONFIRMED_CRITERIA", "raw predicted grades cannot satisfy a slab request");
});

test("preliminary financial rejection and temporary price gaps cannot veto AI; definitive exclusions remain", () => {
    const listing: ListingSummary = { id: "1", title: "Raw card seller calls damaged", url: "#", currentPrice: 100, shipping: 7, buyingOption: "FIXED_PRICE", images: ["photo"], bids: 0, endTime: null, seller: null, isGraded: false,
        screen: { status: "DROPPED", reason: "Seller's price estimate does not clear targets", card: null, assumed: "Damaged", bestCase: null,
            money: { shipping: 7, auction: false, usual: null, paths: [{ label: "Sell raw", expectedNet: 50, fixedCosts: 0 }] } } };
    assert.equal(canAutoAnalyze(listing), true);
    assert.equal(resultGroup(listing, null), "candidates");
    const promising = { ...listing, id: "2", screen: { ...listing.screen!, status: "CANDIDATE" as const } };
    assert.ok(compareAnalysisPriority(promising, listing) < 0, "stronger leads retain priority");
    const temporary = { ...listing, screen: { ...listing.screen!, status: "UNSCREENED" as const, money: undefined, pricingIssue: { kind: "TEMPORARY" as const, retryAt: null } } };
    assert.equal(canAutoAnalyze(temporary), true);
    assert.equal(canAutoAnalyze({ ...listing, match: "OTHER_GRADE" }), false);
    assert.equal(canAutoAnalyze({ ...listing, images: [] }), false);
    assert.equal(canAutoAnalyze({ ...listing, availability: "UNAVAILABLE" }), false);
    assert.equal(canAutoAnalyze({ ...temporary, screen: { ...temporary.screen, pricingIssue: { kind: "CREDITS", retryAt: null } } }), false);
    const assessed = cardEvaluation(); assessed.underwriting!.verdict = "PASS";
    assert.equal(resultGroup(listing, assessed), null, "AI eligibility cannot turn an analyzed rejection into a Deal");
});
