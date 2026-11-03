import "../fixtures/isolated-data.ts";
import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import { getListingDetails, searchListings } from "../../server/ebay/listings.ts";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";

const origin = "2026-11-02T10:06:00-06:00";
const created = "2026-11-01T08:00:00-06:00";
const item = (id: string) => ({ itemId: id, title: "Pokemon Alakazam Base Set 1/102 Holo", itemWebUrl: "https://www.ebay.com/itm/123456789012",
    buyingOptions: ["FIXED_PRICE"], price: { value: "40", currency: "USD" }, conditionId: "4000", image: { imageUrl: "https://i.ebayimg.com/images/g/offline/s-l225.jpg" } });

test("search and details preserve first-available and creation dates as distinct normalized timestamps", async t => {
    offlineEbayCredentials(t);
    let calls = 0;
    const listing = { ...item("v1|123456789012|0"), itemOriginDate: origin, itemCreationDate: created };
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (String(url).includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (String(url).includes("developer/analytics/")) return Response.json({ rateLimits: [] });
        calls++;
        assert.match(String(url), /api\.ebay\.com\/buy\/browse\/v1\//);
        return String(url).includes("item_summary/search") ? Response.json({ itemSummaries: [listing], total: 1 }) : Response.json(listing);
    });
    const search = await searchListings("offline dated Alakazam", { maxResults: 200 });
    const details = await getListingDetails(listing.itemId, { maxAgeHours: 0 });
    for (const value of [search.listings[0], details]) {
        assert.equal(value.listedAt, "2026-11-02T16:06:00.000Z");
        assert.equal(value.createdAt, "2026-11-01T14:00:00.000Z");
    }
    await searchListings("offline dated Alakazam", { maxResults: 200 });
    await getListingDetails(listing.itemId);
    assert.equal(calls, 2, "dates do not require an extra search or detail request");
});

test("missing dates keep existing caches valid and creation or retrieval time never invents a listed time", async t => {
    offlineEbayCredentials(t);
    let calls = 0;
    let dates: Record<string, unknown> = {};
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (String(url).includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        calls++;
        assert.match(String(url), /api\.ebay\.com\/buy\/browse\/v1\/item\//);
        return Response.json({ ...item("date-missing"), ...dates });
    });
    const missing = await getListingDetails("date-missing", { maxAgeHours: 0 });
    assert.equal(missing.listedAt, undefined);
    assert.equal(missing.createdAt, undefined);
    assert.ok(missing.retrievedAt);
    assert.equal((await getListingDetails("date-missing")).listedAt, undefined);
    assert.equal(calls, 1, "an existing cache must not refresh merely to acquire a date");
    dates = { itemCreationDate: created };
    const creationOnly = await getListingDetails("date-created", { maxAgeHours: 0 });
    assert.equal(creationOnly.listedAt, undefined);
    assert.equal(creationOnly.createdAt, "2026-11-01T14:00:00.000Z");
    dates = { itemOriginDate: "not a date", itemCreationDate: 123 };
    const invalid = await getListingDetails("date-invalid", { maxAgeHours: 0 });
    assert.equal(invalid.listedAt, undefined);
    assert.equal(invalid.createdAt, undefined);
});
