import assert from "node:assert/strict";
import { test } from "node:test";
import type { DealHuntResponse } from "../../shared/deal-hunt.ts";
import type { ListingSummary } from "../../shared/types.ts";
import { selectedHuntListing } from "../../client/src/search/hunt-result.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

const searchId = "1a87d6b7-402c-458d-ac49-8b6cf6056dbe";

function discovered() {
    const evaluation = cardEvaluation();
    const listing: ListingSummary = { ...evaluation.listing, id: "v1|123456789012|0", url: "https://www.ebay.com/itm/123456789012",
        buyingOption: "FIXED_PRICE", images: ["front"], currentPrice: 40, isGraded: false };
    Object.assign(evaluation.listing, listing, { photos: ["front", "back"] });
    const response: DealHuntResponse = { report: { searchId, goal: "resell", decision: "BUY", reason: "Clears the profit target.",
        destination: { listingId: listing.id, section: "sales" }, steps: [] }, evaluation, alternative: { listing, reason: "Three recent matching sales." } };
    return { response, listing };
}

test("an open flip hunt can show a verified listing outside the original search, including an empty search", () => {
    const { response, listing } = discovered();
    assert.equal(selectedHuntListing(response, searchId, "resell", "any_card", []), listing);
    assert.throws(() => selectedHuntListing(response, searchId, "resell", "search", []));
    assert.throws(() => selectedHuntListing(response, searchId, "resell", "any_card", [listing]));
    assert.throws(() => selectedHuntListing(response, "old-run", "resell", "any_card", []));
    assert.throws(() => selectedHuntListing({ ...response, alternative: undefined }, searchId, "resell", "any_card", []));
    assert.equal(selectedHuntListing({ ...response, alternative: undefined }, searchId, "resell", "search", [listing]), listing);
});

test("a standalone raw grading result opens the exact fixed-price copy and its grading breakdown", () => {
    const { response, listing } = discovered();
    response.report.goal = "grade_raw";
    response.report.destination!.section = "grading";
    const now = Date.now();
    listing.listedAt = new Date(now - 60_000).toISOString();
    response.evaluation!.listing.termsCheckedAt = new Date(now).toISOString();
    response.evaluation!.photoCheck!.cardCount = "ONE";
    const select = () => selectedHuntListing(response, searchId, "grade_raw", "any_card", []);
    assert.throws(select, "a fresh grading purchase requires the grading quote");
    response.gradingOpportunity = { grader: "PSA", listingDate: listing.listedAt, dateSource: "listed", validUntil: now + 45_000,
        delivered: 45, gradingCosts: 40, likely: { grade: 7, profit: 43, sales30: 3 }, lower: { grade: 6, profit: 13, sales30: 1 } };
    assert.equal(select(), listing);
    for (const changes of [{ validUntil: now - 1 }, { validUntil: now + 86_400_000 }, { listingDate: new Date(now - 600_000).toISOString() }]) {
        assert.throws(() => selectedHuntListing({ ...response, gradingOpportunity: { ...response.gradingOpportunity!, ...changes } }, searchId, "grade_raw", "any_card", []));
    }
    listing.buyingOption = response.evaluation!.listing.buyingOption = "AUCTION";
    response.report.decision = "WAIT";
    assert.throws(() => selectedHuntListing(response, searchId, "grade_raw", "any_card", [], "AUCTION"));
});

test("the alternative listing, gallery and eBay URL must match the assessed copy before showing purchase advice", () => {
    for (const override of [{ images: ["another-front"] }, { id: "v1|222222222222|0" },
        { url: "https://www.ebay.com/itm/222222222222" }, { title: "Different card" }]) {
        const { response, listing } = discovered();
        response.alternative = { listing: { ...listing, ...override }, reason: "Recent matching sales." };
        assert.throws(() => selectedHuntListing(response, searchId, "resell", "any_card", []));
    }
    const { response } = discovered();
    response.report.destination = null;
    assert.throws(() => selectedHuntListing(response, searchId, "resell", "any_card", []));
    response.report.decision = "WAIT";
    assert.equal(selectedHuntListing({ report: response.report, evaluation: null }, searchId, "resell", "any_card", []), undefined);
});

test("collector auction bids only open with a current collector quote for the evaluated copy", () => {
    const { response, listing } = discovered();
    response.report.goal = "collect_slab";
    response.report.decision = "BID";
    response.evaluation!.listing.buyingOption = listing.buyingOption = "AUCTION";
    const quote = { listingId: listing.id, status: "BID" as const, validUntil: Date.now() + 60_000 };
    const select = () => selectedHuntListing(response, searchId, "collect_slab", "any_card", [], "AUCTION");
    Object.assign(response, { auctionOpportunity: quote });
    assert.throws(select, "a resale quote alone must not stand in for collector advice");
    delete response.auctionOpportunity;
    Object.assign(response, { collectorAuction: quote });
    assert.equal(select(), listing);
    assert.equal(selectedHuntListing({ ...response, alternative: undefined }, searchId, "collect_slab", "search", [listing], "AUCTION"), listing);
    assert.throws(() => selectedHuntListing(response, searchId, "collect_slab", "any_card", []));
    for (const change of [{ validUntil: Date.now() - 1 }, { status: "WATCH" }, { listingId: "another card" }]) {
        Object.assign(response, { collectorAuction: { ...quote, ...change } });
        assert.throws(select);
    }
    response.report.goal = "resell";
    Object.assign(response, { collectorAuction: quote });
    assert.throws(() => selectedHuntListing(response, searchId, "resell", "any_card", [], "AUCTION"), "collector quotes cannot qualify a flip");
});
