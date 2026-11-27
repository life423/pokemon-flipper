import { isolatedDataDir } from "../fixtures/isolated-data.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createShippingDestination, shippingDestination, configuredShippingZip, shippingDestinationRoutes, withShippingDestination } from "../../server/ebay/shipping-destination.ts";
import { localApi } from "../../server/lib/local-api.ts";
import { getListingDetails, listingCacheKey } from "../../server/ebay/listings.ts";
import { writeCache } from "../../server/lib/cache.ts";

test("buyer saves destination locally, validation preserves prior preference, and restart retains it", async t => {
    const file = path.join(isolatedDataDir, "shipping-settings-fixture.json");
    const store = createShippingDestination(file);
    const app = express().use("/api", localApi).use(express.json()).use("/api/shipping-destination", shippingDestinationRoutes(store));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/shipping-destination`;
    const headers = { "X-Pokemon-Flipper": "1", "Content-Type": "application/json" };
    assert.equal((await fetch(address)).status, 403);
    for (const zip of ["60601", "90210-1234"]) {
        const response = await fetch(address, { method: "PUT", headers, body: JSON.stringify({ zip }) });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), { zip });
        assert.deepEqual(await createShippingDestination(file).read(), { zip });
    }
    for (const zip of [null, 60601, "", "6060", "60601,other=value", "12345-12345"]) {
        assert.equal((await fetch(address, { method: "PUT", headers, body: JSON.stringify({ zip }) })).status, 400);
        assert.deepEqual(await store.read(), { zip: "90210-1234" });
    }
    await fs.writeFile(file, "{bad");
    assert.equal((await fetch(address, { headers })).status, 503);
    assert.equal((await fetch(address, { method: "PUT", headers, body: JSON.stringify({ zip: "60601" }) })).status, 200);
    assert.deepEqual(await store.read(), { zip: "60601" });
});

test("a request keeps one shipping destination through asynchronous work and later preference changes", async () => {
    await shippingDestination.save("60601");
    await withShippingDestination(async () => {
        assert.equal(configuredShippingZip(), "60601");
        await shippingDestination.save("90210");
        assert.equal(configuredShippingZip(), "60601");
        await withShippingDestination(async () => assert.equal(configuredShippingZip(), "60601"));
    });
    assert.equal(configuredShippingZip(), "90210");
});

test("legacy detail receipts retain the ZIP proven by their own cache scope", async t => {
    const zip = "60601", id = "v1|120000000042|0";
    const legacy = { id, title: "Offline card", shipping: 3.25, price: 20, images: [], availability: "ACTIVE" };
    await shippingDestination.save(zip);
    await writeCache(listingCacheKey(id), legacy);
    t.mock.method(globalThis, "fetch", async () => assert.fail("A correctly scoped legacy receipt needs no new transport."));
    const details = await getListingDetails(id);
    assert.deepEqual([details.shipping, details.shippingDestination], [3.25, zip]);
});
