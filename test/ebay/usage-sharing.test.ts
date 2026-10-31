import { test } from "node:test";
import assert from "node:assert/strict";
import { ebayUsage } from "../../server/ebay/usage.ts";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";
test("concurrent usage requests share analytics work and an expired daily reserve cannot block a new day", async t => {
    offlineEbayCredentials(t); let analytics = 0, failed = false;
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        if (String(url).includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        analytics++; if (failed) throw new Error("offline analytics outage");
        return Response.json({ rateLimits: [{ apiName: "Browse", resources: [{ name: "buy.browse", rates: [{ count: 5000, limit: 5000, remaining: 0, reset: new Date(Date.now() - 1000).toISOString() }] }] }] });
    });
    const first = await Promise.all([ebayUsage({ fresh: true }), ebayUsage({ fresh: true }), ebayUsage({ fresh: true })]);
    assert.equal(analytics, 1); assert.ok(first.every(row => row?.remaining === 0));
    failed = true;
    assert.equal(await ebayUsage(), null, "yesterday's exhausted quota is not a permanent lockout when analytics fails");
});
