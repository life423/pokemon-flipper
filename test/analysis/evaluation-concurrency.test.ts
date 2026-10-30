import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateListing } from "../../server/analysis/evaluate.ts";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";

test("fresh evaluations share paid work and use server terms; different browser snapshots stay separate", async t => {
    offlineEbayCredentials(t);
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
    const [first, duplicate] = await Promise.all([evaluateListing(id, { fresh: true, current: old }), evaluateListing(id, { fresh: true, current: { ...old, price: 2 } })]);
    assert.equal(items, 1); assert.equal(first, duplicate);
    assert.equal(first.listing.price, 18); assert.equal(first.listing.shipping, null); assert.equal(first.listing.bids, 5); assert.equal(first.listing.endTime, end); assert.ok(first.listing.termsCheckedAt);
    const current = { ...old, title: first.listing.title, price: 10, endTime: end };
    const [a, b] = await Promise.all([evaluateListing(id, { current }), evaluateListing(id, { current: { ...current, price: 12 } })]);
    assert.equal(a.listing.price, 10); assert.equal(b.listing.price, 12); assert.equal(items, 1);
    failed = true;
    await assert.rejects(evaluateListing(id, { fresh: true }), /temporary offline failure/);
    failed = false;
    assert.equal((await evaluateListing(id, { fresh: true })).listing.price, 18);
    assert.equal(items, 3, "a failed request must release both the queue and shared work");
});
