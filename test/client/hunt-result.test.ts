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
