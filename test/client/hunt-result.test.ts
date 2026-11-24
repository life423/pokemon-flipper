import assert from "node:assert/strict";
import { test } from "node:test";
import type { DealHuntResponse } from "../../shared/deal-hunt.ts";
import type { ListingSummary } from "../../shared/types.ts";
import { selectedHuntListing } from "../../client/src/search/hunt-result.ts";
import { huntGoalPrompt } from "../../client/src/search/hunt-goal.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

const searchId = "1a87d6b7-402c-458d-ac49-8b6cf6056dbe";

test("a collector auction goal preserves a delivered budget and edition-specific questions stay in named search", () => {
    assert.deepEqual(huntGoalPrompt("Find graded holo auctions from 1999 to 2003 for my collection under $150 delivered."), {
        marketPreferences: { minYear: 1999, maxYear: 2003, finish: "HOLO" }, goal: "collect_slab", maxDelivered: 150,
    });
    assert.deepEqual(huntGoalPrompt("Find slabs to collect in auctions"), { marketPreferences: {}, goal: "collect_slab" });
    for (const query of ["Find PSA 8 auctions for my collection", "Find graded Dark Gengar auctions for my collection",
        "Find raw holo auctions to collect", "Find graded auctions to collect under $20 profit",
        "Find graded auctions to collect under $40 delivered in two hours", "Find graded auctions to collect under $30"])
        assert.equal(huntGoalPrompt(query), null, query);
});

test("a fresh raw grading goal preserves its constraints and named cards stay in ordinary search", () => {
    const fresh = { marketPreferences: {}, goal: "grade_raw" };
    assert.deepEqual(huntGoalPrompt("Find newly listed raw Pokémon cards worth grading"), fresh);
    assert.deepEqual(huntGoalPrompt("Show me a raw card worth grading"), fresh);
    assert.deepEqual(huntGoalPrompt("Find just-listed ungraded holos from 1999 through 2003 to grade under $150 delivered with $25 in profit"), {
        ...fresh, marketPreferences: { minYear: 1999, maxYear: 2003, finish: "HOLO" }, minProfit: 25, maxDelivered: 150,
    });
    for (const query of ["newly listed Dark Alakazam worth grading", "Find raw Alakazam worth grading", "Find raw Base Set cards worth grading",
        "Find raw Japanese cards worth grading", "Find raw cards worth grading ending in under 10 hours", "Find raw auctions worth grading",
        "Find raw cards worth grading from the last 2 hours", "Find PSA 10 candidates", "Find raw cards worth grading under $100"]) {
        assert.equal(huntGoalPrompt(query), null, query);
    }
});

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
