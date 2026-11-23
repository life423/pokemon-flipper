import "../fixtures/isolated-data.ts";
import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import { createBoundedEvaluator } from "../../server/analysis/bounded-evaluate.ts";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";

test("evaluations share details without overwriting newer purchase terms with an older snapshot", async t => {
    offlineEbayCredentials(t);
    const evaluateListing = createBoundedEvaluator({ now: () => Date.now() });
    const id = `v1|fresh-concurrent-${Date.now()}|0`;
    const end = new Date(Date.now() + 86400000).toISOString();
    let items = 0; let failed = false;
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (String(url).includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        assert.match(String(url), /buy\/browse\/v1\/item\//, "the photo-less fixture must not call AI or prices");
        items++;
        await new Promise(resolve => setTimeout(resolve, 10));
        if (failed) return Response.json({ errors: [{ message: "temporary offline failure" }] }, { status: 503 });
        return Response.json({ itemId: id, title: "Venusaur Base Set 15/102", itemWebUrl: "https://www.ebay.com/itm/123",
            buyingOptions: ["AUCTION"], currentBidPrice: { value: "18", currency: "USD" }, bidCount: 5, itemEndDate: end,
            localizedAspects: [{ name: "Card Name", value: "Venusaur" }, { name: "Set", value: "Base Set" }, { name: "Card Number", value: "15/102" }] });
    });
    const old = { title: "Old browser title", images: [], price: 1, shipping: 0, bids: 0, endTime: "2000-01-01T00:00:00Z" };
    const [first, duplicate] = await Promise.all([evaluateListing(id), evaluateListing(id)]);
    assert.equal(items, 1); assert.equal(first, duplicate);
    assert.equal(first.listing.price, 18); assert.equal(first.listing.shipping, null); assert.equal(first.listing.bids, 5); assert.equal(first.listing.endTime, end); assert.ok(first.listing.termsCheckedAt);
    const detailTime = Date.parse(first.listing.termsCheckedAt!);
    const browserTime = new Date(detailTime + 1_000).toISOString();
    t.mock.method(Date, "now", () => detailTime + 2_000);
    const current = { ...old, title: first.listing.title, price: 10, endTime: end };
    const [unstamped, older, newer] = await Promise.all([
        evaluateListing(id, { current }),
        evaluateListing(id, { current: { ...old, title: current.title, termsCheckedAt: new Date(detailTime - 1_000).toISOString() } }),
        evaluateListing(id, { current: { ...current, price: 12, shipping: null, bids: 7, termsCheckedAt: browserTime } }),
    ]);
    assert.equal(unstamped.listing.price, 18);
    assert.equal(older.listing.price, 18);
    assert.equal(older.listing.bids, 5);
    assert.equal(older.listing.endTime, end, "an older, ended Browse snapshot cannot reject a live detail response");
    assert.equal(older.listing.termsCheckedAt, first.listing.termsCheckedAt);
    assert.equal(newer.listing.price, 12);
    assert.equal(newer.listing.shipping, null);
    assert.equal(newer.listing.bids, 7);
    assert.equal(newer.listing.termsCheckedAt, browserTime);
    assert.equal(items, 1);
    failed = true;
    await assert.rejects(evaluateListing(id), /temporary offline failure/);
    failed = false;
    assert.equal((await evaluateListing(id)).listing.price, 18);
    assert.equal(items, 3, "a failed request must release both the queue and shared work");
});
