import test from "node:test";
import assert from "node:assert/strict";
import { auctionPhotoPriority } from "../../shared/auction-research.ts";
import { auctionHuntPrompt } from "../../client/src/search/auction-goal.ts";
import { researchAuctionSellers } from "../../server/deals/auction-seller-research.ts";
import { ruleSelection } from "../../server/deals/search-review-selection.ts";
import { EbayBudgetError } from "../../server/ebay/usage.ts";
import type { ListingSummary } from "../../shared/types.ts";

const now = Date.UTC(2026, 10, 24, 12);
function listing(name: string, hours: number, title = "Vintage holo card NM"): ListingSummary {
    return { id: name, title, buyingOption: "AUCTION", bids: 2, availability: "ACTIVE", currentPrice: 15, shipping: 4,
        endTime: new Date(now + hours * 3_600_000).toISOString(), images: ["front", "back"], isGraded: false, url: "https://www.ebay.com",
        seller: { username: name, feedbackPercentage: 99, feedbackScore: 50 } };
}
test("a broad auction goal keeps both inclusive years, the finish and the requested minimum profit", () => {
    const prefs = { minYear: 1999, maxYear: 2003, finish: "HOLO" };
    assert.deepEqual(auctionHuntPrompt("Find vintage holos from 1999–2003 I can flip for at least $25."), {marketPreferences: prefs, minProfit: 25});
    assert.deepEqual(auctionHuntPrompt("Find 1999 to 2003 holo auctions with $25 in profit"), {marketPreferences: prefs, minProfit: 25});
    assert.deepEqual(auctionHuntPrompt("Find 1999 to 2003 holo auctions ending in under 10 hours for at least $25 profit"), {marketPreferences: prefs, minProfit: 25});
    assert.deepEqual(auctionHuntPrompt("Find auctions with less than 10 hours left"), {marketPreferences: {}});
    for (const query of ["find auctions ending in under 2 hours", "Mewtwo 10/102 auction", "find holo auctions under $40", "find vintage auctions", "2003 to 1999 auction", "find auctions for Japanese cards"]) {
        assert.equal(auctionHuntPrompt(query), null, query);
    }
});
test("auction research uses observed merchandise counts and reuses each seller sample across copies", async () => {
    const rows = [listing("specialist", 3), listing("tools", 4), { ...listing("tools", 2), id: "another-copy" }, listing("third", 9)];
    const sampled: string[] = [];
    const ranked = await researchAuctionSellers(rows, now, undefined, async user => {
        sampled.push(user);
        return { sampledAt: new Date(now).toISOString(), cardListings: user === "tools" ? 1 : 114, otherListings: 24, categories: ["CCG singles", "home and garden"] };
    });
    assert.deepEqual(sampled, ["specialist", "tools"]);
    assert.deepEqual(ranked[1].auctionResearch, ranked[2].auctionResearch);
    assert.equal(ruleSelection(ranked, now).listingIds[0], "tools");
    assert.ok(auctionPhotoPriority(ranked[1], now) > auctionPhotoPriority(ranked[0], now));
    for (const excluded of [listing("too-early",10), listing("closed",0), {...ranked[1],cardCondition:"Damaged"}, {...ranked[1],isGraded:true}]) {
        assert.equal(auctionPhotoPriority(excluded, now), 0);
    }
});
test("optional seller research falls back on exhausted eBay quota and propagates accounting failures", async () => {
    const rows=[listing("one",1)];
    assert.deepEqual(await researchAuctionSellers(rows, now, undefined, async () => { throw new EbayBudgetError("full","QUOTA"); }),rows);
    await assert.rejects(researchAuctionSellers(rows, now, undefined, async () => { throw new EbayBudgetError("invalid ledger","ACCOUNTING"); }),/invalid ledger/);
});
