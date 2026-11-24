import test from "node:test";
import assert from "node:assert/strict";
import { auctionPhotoPriority } from "../../shared/auction-research.ts";
import { researchAuctionSellers, researchFreshRawSellers } from "../../server/deals/auction-seller-research.ts";
import { ruleSelection } from "../../server/deals/search-review-selection.ts";
import { EbayBudgetError } from "../../server/ebay/usage.ts";
import type { ListingSummary } from "../../shared/types.ts";

const now = Date.UTC(2026, 10, 24, 12);
function listing(name: string, hours: number, title = "Vintage holo card NM"): ListingSummary {
    return { id: name, title, buyingOption: "AUCTION", bids: 2, availability: "ACTIVE", currentPrice: 15, shipping: 4,
        endTime: new Date(now + hours * 3_600_000).toISOString(), images: ["front", "back"], isGraded: false, url: "https://www.ebay.com",
        seller: { username: name, feedbackPercentage: 99, feedbackScore: 50 } };
}
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

test("fresh raw seller research spends its two samples on distinct assessable sellers in buyer priority order", async () => {
    function fixed(seller: string, overrides: Partial<ListingSummary> = {}): ListingSummary {
        return { ...listing(seller, 80), buyingOption: "FIXED_PRICE", listedAt: new Date(now - 3_600_000).toISOString(),
            mistakes: [{ kind: "GENERIC_TITLE", detail: "Set omitted from title." }], ...overrides };
    }
    const skipped = [
        fixed("stale", { listedAt: new Date(now - 86_400_000).toISOString() }),
        fixed("future", { listedAt: new Date(now + 1).toISOString() }),
        fixed("auction", { buyingOption: "AUCTION" }), fixed("slab", { isGraded: true }), fixed("unscreened", { mistakes: [] }),
        fixed("expired", { endTime: new Date(now).toISOString() }), fixed("first", { id: "damaged-copy", cardCondition: "Damaged" }),
        fixed("conflict", { cardCondition: "Lightly Played" }), fixed("crease", { conditionNotes: ["Seller description: This card has a crease."] }),
        fixed("title-crease", { title: "Card creased top corner" }),
    ];
    const first = fixed("First", { title: "Card NM, crease on the sleeve" }), again = fixed("first", { id: "another" });
    const second = fixed("second", { listedAt: null, createdAt: new Date(now - 60_000).toISOString() }), third = fixed("third");
    const rows = [...skipped, first, again, second, third];
    const sampled: string[] = [];
    const enriched = await researchFreshRawSellers(rows, now, undefined, async user => {
        sampled.push(user);
        return { sampledAt: new Date(now).toISOString(), cardListings: 1, otherListings: 25, categories: ["CCG singles", "clothing", "home and garden"] };
    });
    assert.deepEqual(sampled, ["first", "second"]);
    assert.deepEqual(enriched.map(row => row.id), rows.map(row => row.id));
    assert.deepEqual(enriched.filter(row => row.auctionResearch).map(row => row.id), [first.id, again.id, second.id]);
    assert.ok(enriched.find(row => row.id === "First")!.auctionResearch === enriched.find(row => row.id === "another")!.auctionResearch);
    assert.equal(rows.some(row => row.auctionResearch), false);
    await assert.rejects(researchFreshRawSellers(rows, now, AbortSignal.abort(), async () => assert.fail("Cancelled at selection.")), { name: "AbortError" });
});
