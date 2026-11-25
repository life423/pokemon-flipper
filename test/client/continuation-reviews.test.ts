import assert from "node:assert/strict";
import test from "node:test";
import { listingsInDiagnosticBatch, searchDiagnosticRows } from "../../client/src/search/diagnostic.ts";
import { groupSearchResults } from "../../client/src/search/results.ts";
import { buyerReviewGlobalHold } from "../../client/src/search/useBuyerReviews.ts";
import { validateSearchDiagnosticRows } from "../../server/analysis/search-diagnostic-store.ts";
import { buyerReviewFailure, isRetiredRequestLimit } from "../../shared/wait-skip-review.ts";
import type { ListingSummary } from "../../shared/types.ts";

test("continued diagnostic rows match the server's original retained batch", () => {
    const listings = Array.from({ length: 62 }, (_, i) => ({ id: `v1|${120000000000 + i}|0` }) as ListingSummary);
    const owners = new Map(listings.map((row, i) => [row.id, i < 50 ? "original" : "continued"]));
    const retained = listings.slice(50).map(row => row.id);
    const rows = listingsInDiagnosticBatch(listings, owners, "continued").map(({ id }) => ({ id, outcome: "WAIT", reason: "BUYER_WAIT" }));
    assert.deepEqual(validateSearchDiagnosticRows(rows, retained).map(row => row.id), retained);
    assert.throws(() => validateSearchDiagnosticRows(listings, retained), /every listing retained/);
});

test("a provider or accounting hold stops its search without upgrading a per-copy hold", () => {
    assert.equal(buyerReviewGlobalHold(buyerReviewFailure("AI_CREDITS", false)), "AI_CREDITS");
    assert.equal(buyerReviewGlobalHold(buyerReviewFailure("AI_ACCOUNTING", false, "search")), "AI_ACCOUNTING");
    assert.equal(buyerReviewGlobalHold(buyerReviewFailure("AI_INPUT_PREFLIGHT", false, "search")), "AI_INPUT_PREFLIGHT");
    assert.equal(buyerReviewGlobalHold(buyerReviewFailure("AI_INPUT_PREFLIGHT", false, "listing")), null);
    assert.equal(buyerReviewGlobalHold(buyerReviewFailure("PRICE_RESEARCH_BUDGET", false, "search")), "PRICE_RESEARCH_BUDGET");
    assert.equal(buyerReviewGlobalHold(buyerReviewFailure("STORAGE_UNAVAILABLE", false, "search")), "STORAGE_UNAVAILABLE");
    assert.equal(buyerReviewGlobalHold(buyerReviewFailure("STORAGE_UNAVAILABLE", false, "listing")), null);
    assert.equal(buyerReviewGlobalHold(buyerReviewFailure("PRICE_RESEARCH_BUDGET", false, "listing")), null);
    assert.equal(buyerReviewGlobalHold(buyerReviewFailure("AI_EVIDENCE_HELD", false)), null);
    assert.equal(buyerReviewGlobalHold(buyerReviewFailure("PROVIDER_TEMPORARY", true)), null);
    for (const code of ["EBAY_DAILY_BUDGET", "EBAY_BUDGET_ACCOUNTING", "EBAY_AUTH"] as const) {
        assert.equal(buyerReviewGlobalHold(buyerReviewFailure(code, false, "search")), code);
    }
});

test("explicit resume can reconsider historical request ceilings while preserving unrelated evidence holds", () => {
    assert.equal(isRetiredRequestLimit(buyerReviewFailure("REVIEW_UNAVAILABLE", false),
        "This search has reached its 100-request eBay Browse cap. Cached listings remain available."), true);
    assert.equal(isRetiredRequestLimit(buyerReviewFailure("PRICE_RESEARCH_BUDGET", false), "Old recorded price ceiling."), true);
    assert.equal(isRetiredRequestLimit(buyerReviewFailure("AI_EVIDENCE_HELD", false), "A previous charge is held."), false);
    assert.equal(isRetiredRequestLimit(buyerReviewFailure("EBAY_DAILY_BUDGET", false), "Daily reserve protected."), false);
    assert.equal(isRetiredRequestLimit(buyerReviewFailure("REVIEW_UNAVAILABLE", false), "An unrelated provider response was unavailable."), false);
});

test("diagnostics retain typed wait blockers and support older generic Wait decisions", () => {
    const listings: ListingSummary[] = Array.from({ length: 4 }, (_, i) => ({
        id: `v1|${120000000000 + i}|0`, title: "Offline card", currentPrice: 10, shipping: 0,
        buyingOption: "FIXED_PRICE", bids: 0, isGraded: false, endTime: null, seller: null, url: "#", images: [],
    }));
    const decisions = Object.fromEntries(listings.map(({ id }, i) => [id, {
        decision: "WAIT" as const, reason: "Seller-provided prose is not a diagnostic reason.",
        waitReason: (["SHIPPING_UNCONFIRMED", "IDENTITY_UNRESOLVED", "PRICE_EVIDENCE_UNAVAILABLE", undefined] as const)[i],
    }]));
    const groups = groupSearchResults(listings, {}, false, new Set(), decisions);
    const rows = searchDiagnosticRows(listings, {}, groups, () => null, "NOT_ASSESSED", decisions);
    assert.deepEqual(validateSearchDiagnosticRows(rows, listings.map(row => row.id)).map(row => row.reason),
        ["SHIPPING_UNCONFIRMED", "IDENTITY_UNRESOLVED", "PRICE_EVIDENCE_UNAVAILABLE", "BUYER_WAIT"]);
});
