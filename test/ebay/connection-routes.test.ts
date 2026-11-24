import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { localApi } from "../../server/lib/local-api.ts";
import { ebayConnectionRoutes } from "../../server/ebay/connection-routes.ts";
import type { BuyerEnvironment } from "../../shared/ebay-connection.ts";

test("only the initiating browser can finish sign-in, and the redirect removes the authorization code", async t => {
    let pending: string | undefined;
    let grant = false;
    let reconciliations = 0;
    let sandboxOffline = false;
    const disconnects: BuyerEnvironment[] = [];
    const { api, callback } = ebayConnectionRoutes({
        status: async (env: BuyerEnvironment) => {
            if (env === "sandbox" && sandboxOffline) throw new Error("Test storage offline");
            return { configured: env === "sandbox", connected: env === "sandbox" && grant, missing: env === "production" ? ["EBAY_RUNAME"] : [] };
        },
        start: async (_env, key) => { pending = key; return "https://auth.sandbox.ebay.com/oauth2/authorize?state=test"; },
        complete: async (state, code, key) => {
            assert.equal(state, "test"); assert.equal(key, pending);
            pending = undefined;
            if (code !== null) { assert.equal(code, "example+token"); grant = true; }
            return "sandbox";
        },
        disconnect: async env => { disconnects.push(env); if (env === "sandbox") grant = false; },
    }, async () => { reconciliations++; });
    const app = express();
    app.use("/api/ebay/connection", localApi, express.json(), api);
    app.use(callback);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { "Content-Type": "application/json", "X-Pokemon-Flipper": "1" };
    const post = (path: string, env: unknown) => fetch(base + "/api/ebay/connection/" + path, {
        method: "POST", headers, body: JSON.stringify({ environment: env }),
    });
    const finish = (query: string, cookie = "") => fetch(base + "/ebay/connection/callback?" + query, {
        redirect: "manual", headers: { cookie },
    });
    assert.equal((await fetch(base + "/api/ebay/connection")).status, 403);
    assert.equal((await post("start", "fake")).status, 400);
    const unavailable = await post("start", "production");
    assert.equal(unavailable.status, 409);
    assert.doesNotMatch((await unavailable.json()).error, /RUNAME|Configure/);
    const start = await post("start", "sandbox");
    assert.equal(start.status, 200);
    assert.match(start.headers.get("set-cookie")!, /HttpOnly/);
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const query = "code=example%2Btoken&state=test";
    assert.equal((await finish(query)).headers.get("location"), "/?ebay_connection=failed");
    const response = await finish(query, cookie);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/?ebay_connection=connected");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(reconciliations, 1);
    assert.equal((await finish(query, cookie)).headers.get("location"), "/?ebay_connection=failed");
    const again = await post("start", "sandbox");
    const declined = await finish("state=test&error=access_denied", again.headers.get("set-cookie")!.split(";")[0]);
    assert.equal(declined.headers.get("location"), "/?ebay_connection=declined");
    assert.equal(grant, true);
    const disconnected = await post("disconnect", "sandbox");
    assert.equal((await disconnected.json()).sandbox.connected, false);
    assert.equal(reconciliations, 2);

    sandboxOffline = true;
    const statusUrl = base + "/api/ebay/connection";
    assert.equal((await fetch(statusUrl, { headers })).status, 503);
    assert.equal((await fetch(statusUrl + "?environment=unknown", { headers })).status, 400);
    const publicStatus = await fetch(statusUrl + "?environment=production", { headers });
    assert.equal(publicStatus.status, 200);
    assert.deepEqual(await publicStatus.json(), { configured: false, connected: false });
    assert.equal((await post("disconnect?environment=production", "sandbox")).status, 400);
    const publicDisconnect = await post("disconnect?environment=production", "production");
    assert.deepEqual(await publicDisconnect.json(), { configured: false, connected: false });
    assert.deepEqual(disconnects, ["sandbox", "production"]);
});
