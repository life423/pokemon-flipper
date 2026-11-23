import "../fixtures/isolated-data.ts";
import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import { getListingDetails, searchListings } from "../../server/ebay/listings.ts";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";

test("Browse quotes shipping by destination and separates unknown shipping from free shipping across caches", async t => {
    offlineEbayCredentials(t);
    const original = process.env.EBAY_SHIP_TO_ZIP;
    t.after(() => {
        if (original === undefined) delete process.env.EBAY_SHIP_TO_ZIP;
        else process.env.EBAY_SHIP_TO_ZIP = original;
    });
    const id = "v1|shipping-quote-fixture|0";
    const item = { itemId: id, title: "Venusaur Base Set 15/102 Holo", itemWebUrl: "https://www.ebay.com/itm/123456789012",
        buyingOptions: ["FIXED_PRICE"], price: { value: "25", currency: "USD" } };
    const firstLocation = `contextualLocation=${encodeURIComponent("country=US,zip=10001")}`;
    const secondLocation = `contextualLocation=${encodeURIComponent("country=US,zip=90001")}`;
    const extendedLocation = `contextualLocation=${encodeURIComponent("country=US,zip=10001-1234")}`;
    const calls: ["search" | "details", string | null][] = [];
    t.mock.method(globalThis, "fetch", async (input: unknown, request?: RequestInit) => {
        const address = String(input);
        if (address.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (address.includes("rate_limit")) return Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse", rates: [{ count: 0, limit: 5000, remaining: 5000 }] }] }] });
        assert.match(new URL(address).pathname, /\/buy\/browse\/v1\/(?:item_summary\/search|item\/)/);
        const location = new Headers(request?.headers).get("X-EBAY-C-ENDUSERCTX");
        const route = address.includes("item_summary/search") ? "search" : "details";
        calls.push([route, location]);
        const quote = (value: string, currency = "USD") => ({ value, currency });
        const options = [{ shippingCost: quote("0", "CAD") }, { shippingCost: quote("0"), shippingCostType: "CALCULATED",
            shipToLocationUsedForEstimate: { country: "US", postalCode: "70001" } }];
        if (location === firstLocation) options.push({ shippingCost: quote("8.50"), shippingCostType: "CALCULATED",
            shipToLocationUsedForEstimate: { country: "US", postalCode: "1***1" } });
        if (location === secondLocation) options.push({ shippingCost: quote("0"), shippingCostType: "FIXED",
            shipToLocationUsedForEstimate: { country: "US" } });
        if (location === extendedLocation) options.push({ shippingCost: quote("9.25"), shippingCostType: "CALCULATED",
            shipToLocationUsedForEstimate: { country: "US", postalCode: "1***1" } });
        const response = { ...item, shippingOptions: options };
        return Response.json(route === "search" ? { total: 1, itemSummaries: [response] } : response);
    });
    const readShipping = async () => [(await searchListings(item.title)).listings[0].shipping, (await getListingDetails(id)).shipping];

    process.env.EBAY_SHIP_TO_ZIP = " 10001-invalid ";
    assert.deepEqual(await readShipping(), [null, null]);
    delete process.env.EBAY_SHIP_TO_ZIP;
    assert.deepEqual(await readShipping(), [null, null]);
    process.env.EBAY_SHIP_TO_ZIP = " 10001 ";
    assert.deepEqual(await readShipping(), [8.5, 8.5]);
    process.env.EBAY_SHIP_TO_ZIP = "90001";
    assert.deepEqual(await readShipping(), [0, 0]);
    process.env.EBAY_SHIP_TO_ZIP = "10001-1234";
    assert.deepEqual(await readShipping(), [9.25, 9.25]);
    process.env.EBAY_SHIP_TO_ZIP = "10001";
    assert.deepEqual(await readShipping(), [8.5, 8.5]);
    delete process.env.EBAY_SHIP_TO_ZIP;
    assert.deepEqual(await readShipping(), [null, null]);
    assert.deepEqual(calls, [null, firstLocation, secondLocation, extendedLocation].flatMap(location => [["search", location], ["details", location]]));
});
