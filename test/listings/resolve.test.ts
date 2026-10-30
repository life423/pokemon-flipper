import { test } from "node:test";
import assert from "node:assert/strict";
import { createListingResolver, ListingLinkError } from "../../server/listings/resolve.ts";
import type { ListingDetails } from "../../server/ebay/listings.ts";

const id = "v1|267743966894|0";
const details = (): ListingDetails => ({ id, title: "Mewtwo Pokemon Base Set Holo 10/102", url: "https://www.ebay.com/itm/267743966894?tracking=server", price: 350, shipping: 6.4,
    bids: 0, buyingOption: "FIXED_PRICE", endTime: null, images: ["https://i.ebayimg.com/front.jpg", "https://i.ebayimg.com/back.jpg"], seller: null,
    condition: "Ungraded", cardCondition: "Near mint or better", conditionNotes: [], aspects: {}, availability: "ACTIVE", retrievedAt: "2026-10-30T12:00:00Z" });

test("direct resolution fetches just the canonical item with current terms and strips tracking", async () => {
    let requests = 0;
    const resolve = createListingResolver({ details: async (itemId, options) => { requests++; assert.equal(itemId, id); assert.equal(options?.maxAgeHours, 0); return details(); } });
    const listing = await resolve("https://www.ebay.com/itm/267743966894?_skw=mewtwo&itmprp=tracking");
    assert.equal(requests, 1); assert.equal(listing.currentPrice, 350); assert.equal(listing.shipping, 6.4); assert.equal(listing.isGraded, false);
    assert.equal(listing.url, "https://www.ebay.com/itm/267743966894"); assert.equal(listing.termsCheckedAt, "2026-10-30T12:00:00Z"); assert.equal(listing.images.length, 2);
});
test("invalid links and variations cannot spend a detail or AI request", async () => {
    let calls = 0; const resolve = createListingResolver({ details: async () => { calls++; return details(); } });
    for (const input of [null, "https://evil.example/itm/267743966894", "https://www.ebay.com/itm/267743966894?var=123"]) await assert.rejects(resolve(input), error => error instanceof ListingLinkError);
    assert.equal(calls, 0);
});
test("unavailable, ended, photo-less and non-single-card listings stop before analysis", async () => {
    for (const change of [{ availability: "UNAVAILABLE" as const }, { endTime: "2000-01-01T00:00:00Z" }, { images: [] }, { title: "Mewtwo lot of 5 cards" }, { title: "Mewtwo custom proxy" }, { itemGroupType: "SELLER_DEFINED_VARIATIONS" }]) {
        const resolve = createListingResolver({ details: async () => ({ ...details(), ...change }) });
        await assert.rejects(resolve("267743966894"), error => error instanceof ListingLinkError && [410, 422].includes(error.status));
    }
});
test("slabs are identified as graded and provider failures remain failures", async () => {
    const resolve = createListingResolver({ details: async () => ({ ...details(), condition: "Graded", aspects: { "Professional Grader": "PSA" } }) });
    assert.equal((await resolve("267743966894")).isGraded, true);
    const offline = createListingResolver({ details: async () => { throw new Error("offline provider"); } });
    await assert.rejects(offline("267743966894"), /offline provider/);
});
