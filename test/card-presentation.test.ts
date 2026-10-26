import { test } from "node:test";
import assert from "node:assert/strict";
import { auctionDecision, gradingRoutes, returnText, scenarioAt } from "../shared/card-presentation.ts";
import { cardEvaluation, salesSummary } from "./fixtures/card-evaluation.ts";
import { pathNumbers } from "../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../shared/money/config.ts";

const any = { minProfit: 0, minRoi: 0 };
test("auction profit, total investment and ROI all use the displayed winning price", () => {
    const evaluation = cardEvaluation();
    const decision = auctionDecision(evaluation);
    const best = evaluation.underwriting!.best!;
    const expected = pathNumbers({ expectedNet: best.expectedNet, fixedCosts: best.fixedCosts, shipping: best.shipping, price: best.maxBid }, MONEY_CONFIG);
    assert.ok(decision.atCeiling);
    assert.equal(decision.atCeiling.price, decision.ceiling);
    assert.equal(decision.atCeiling.cost, expected.cost);
    assert.equal(decision.atCeiling.profit, expected.profit);
    assert.equal(decision.atCeiling.roi, expected.profit / expected.cost);
    assert.notEqual(decision.atCeiling.cost, decision.atCurrent?.cost);
    assert.notEqual(decision.atCeiling.profit, decision.atCurrent?.profit);
});

test("Any profit and ROI explicitly produce a break-even ceiling, retaining small nonzero returns", () => {
    const decision = auctionDecision(cardEvaluation(any), any);
    assert.equal(decision.breakEven, true);
    assert.equal(decision.label, "Break-even bid ceiling");
    assert.equal(returnText(0.1 / 82.2), "0.12%");
    assert.equal(returnText(-0.0012), "-0.12%");
    assert.equal(returnText(0.000001), "<0.01%");
    assert.equal(returnText(null), "—");
    assert.equal(returnText(NaN), "—");
});

test("an exceeded limit and an ended auction never say within limit", () => {
    const e = cardEvaluation();
    e.listing.price = e.underwriting!.best!.maxBid + 0.01;
    assert.equal(auctionDecision(e).status, "OVER_LIMIT");
    e.listing.endTime = "2020-01-01T00:00:00Z";
    assert.equal(auctionDecision(e).status, "ENDED");
    e.listing.endTime = "bad date";
    e.underwriting!.best = null;
    assert.equal(auctionDecision(e).status, "UNPRICED");
    assert.equal(auctionDecision(e).atCeiling, null);
});

test("weak photos and missing likely grade produce provisional limits and no raw closing guide", () => {
    const e = cardEvaluation();
    e.listing.price = 1;
    e.condition!.confidence = "LOW";
    e.condition!.gradeRange.likely = null;
    assert.equal(auctionDecision(e).status, "PROVISIONAL");
    assert.equal(auctionDecision(e).benchmark, null);
    e.condition = null;
    assert.equal(auctionDecision(e).benchmark, null);
});

test("graded resale after grading cannot become a raw auction closing guide", () => {
    const e = cardEvaluation();
    assert.equal(auctionDecision(e).benchmark?.price, 85);
    e.underwriting!.paths = e.underwriting!.paths.filter((path) => path.path !== "RAW");
    assert.equal(auctionDecision(e).benchmark, null);
});

test("slab guides use dated exact-grade sold evidence and discard future, undated and stale sales", () => {
    const e = cardEvaluation();
    const now = Date.parse("2026-10-26T12:00:00Z");
    e.slab = { status: "OK", grader: "PSA", grade: "7", gradeQualifier: null, certNumber: "test", certUrl: null, labelText: "Offline label", caseCondition: "CLEAR", reasons: [], concerns: [] };
    const summary = salesSummary();
    summary.sales = [
        { price: 150, soldAt: "2026-10-20", title: "A", url: null },
        { price: 200, soldAt: "2026-10-10", title: "B", url: null },
        ...["2026-10-27", "", "2020-01-01"].map((soldAt) => ({ price: 1000, soldAt, title: "Excluded", url: null })),
    ];
    e.slabPricing = { status: "PRICED", summary };
    assert.deepEqual(auctionDecision(e, any, now).benchmark, { price: 175, low: 150, high: 200, count: 2, source: "Dated sold comps" });
    summary.sales = [];
    assert.equal(auctionDecision(e, any, now).benchmark, null, "a slab never borrows a raw quote");
});

test("both grading routes share the photo range but retain their separate prices and fees", () => {
    const e = cardEvaluation();
    const routes = gradingRoutes(e);
    assert.deepEqual(routes.map((route) => route.grader), ["PSA", "CGC"]);
    assert.equal(routes[0].range, routes[1].range);
    assert.ok(routes[0].priced && routes[1].priced);
    assert.notEqual(routes[0].priced.expectedSale, routes[1].priced.expectedSale);
    assert.notEqual(routes[0].priced.fixedCosts, routes[1].priced.fixedCosts);
    e.underwriting!.paths = e.underwriting!.paths.filter((path) => path.grader !== "CGC");
    assert.equal(gradingRoutes(e)[1].priced, null);
    e.slab = { status: "OK", grader: "CGC", grade: "7", gradeQualifier: null, certNumber: null, certUrl: null, labelText: "CGC 7", caseCondition: "CLEAR", reasons: [], concerns: [] };
    assert.deepEqual(gradingRoutes(e), []);
});

test("rendering decisions and changing hypothetical prices makes no provider requests or input mutations", (t) => {
    const e = cardEvaluation();
    const before = structuredClone(e);
    t.mock.method(globalThis, "fetch", () => { throw new Error("presentation must not fetch"); });
    auctionDecision(e); gradingRoutes(e); scenarioAt(e.underwriting!.best!, 40);
    assert.deepEqual(e, before);
});
