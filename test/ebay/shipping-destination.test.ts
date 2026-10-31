import { test } from "node:test";
import assert from "node:assert/strict";
import { listingCacheKey } from "../../server/ebay/listings.ts";
test("destination-specific caches do not reuse an unknown or another destination's shipping quote", () => {
    const original = process.env.EBAY_SHIP_TO_ZIP;
    try {
        delete process.env.EBAY_SHIP_TO_ZIP;
        const noDestination = listingCacheKey("item");
        process.env.EBAY_SHIP_TO_ZIP = "10001";
        const first = listingCacheKey("item");
        process.env.EBAY_SHIP_TO_ZIP = "90001";
        assert.notEqual(listingCacheKey("item"), first);
        assert.notEqual(first, noDestination);
        process.env.EBAY_SHIP_TO_ZIP = " 10001 ";
        assert.equal(listingCacheKey("item"), first);
    } finally { if (original === undefined) delete process.env.EBAY_SHIP_TO_ZIP; else process.env.EBAY_SHIP_TO_ZIP = original; }
});
