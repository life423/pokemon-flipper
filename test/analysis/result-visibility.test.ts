import { test } from "node:test";
import assert from "node:assert/strict";
import { resultGroup } from "../../shared/analysis.ts";
import type { ListingSummary } from "../../shared/types.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

test("incomplete screening and failed analyses stay visible in Review without becoming Deals", () => {
    const evaluation = cardEvaluation();
    const listing: ListingSummary = {
        id: evaluation.listing.id, title: evaluation.listing.title, url: evaluation.listing.url,
        currentPrice: 30, shipping: 0, bids: 0, buyingOption: "FIXED_PRICE", endTime: null,
        images: [], seller: null, isGraded: false,
        screen: { status: "UNSCREENED", reason: "Price lookup failed", card: null, bestCase: null, assumed: null },
    };
    assert.equal(resultGroup(listing, null, true), "review");
    const candidate: ListingSummary = { ...listing, screen: { ...listing.screen!, status: "CANDIDATE" } };
    assert.equal(resultGroup(candidate, null), "candidates");
    assert.equal(resultGroup(candidate, null, true, true), "review");
    assert.equal(resultGroup({ ...listing, screen: { ...listing.screen!, status: "DROPPED" } }, null), null);
    evaluation.underwriting = { verdict: "CANT_PRICE", reasons: [], best: null, paths: [], assumptions: [] };
    assert.equal(resultGroup(candidate, evaluation), "review");
    evaluation.underwriting.verdict = "PASS";
    assert.equal(resultGroup(candidate, evaluation, false, true), null, "a completed assessment supersedes an earlier failed attempt");
});
