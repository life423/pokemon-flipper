import { test } from "node:test";
import assert from "node:assert/strict";
import { getListingDetails } from "../../server/ebay/listings.ts";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";
test("eBay terms preserve USD zero shipping and do not silently treat other currencies or invalid numbers as dollars", async t => {
    offlineEbayCredentials(t);
    let terms = { value: "10", currency: "USD" };
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (String(url).includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        return Response.json({ itemId: "test", title: "Offline card", itemWebUrl: "https://www.ebay.com/itm/123", buyingOptions: ["FIXED_PRICE"], price: terms, shippingOptions: [{ shippingCost: { value: "0", currency: "USD" } }] });
    });
    const id = `currency-${Date.now()}`;
    const valid = await getListingDetails(id, { maxAgeHours: 0 }); assert.equal(valid.price, 10); assert.equal(valid.shipping, 0);
    for (const invalid of [{ value: "10", currency: "EUR" }, { value: "NaN", currency: "USD" }, { value: "Infinity", currency: "USD" }, { value: "-100", currency: "USD" }, { value: "", currency: "USD" }]) { terms = invalid; assert.equal((await getListingDetails(id, { maxAgeHours: 0 })).price, null); }
});
