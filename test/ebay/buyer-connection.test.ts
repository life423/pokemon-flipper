import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBuyerConnection } from "../../server/ebay/buyer-connection.ts";

const scope = "https://api.ebay.com/oauth/api_scope/buy.offer.auction";
const tokens = { access_token: "test-access", token_type: "User Access Token", expires_in: 7200,
    refresh_token: "test-refresh", refresh_token_expires_in: 31_536_000 };
const config = { EBAY_CLIENT_ID: "prod-id", EBAY_CLIENT_SECRET: "prod-secret", EBAY_RUNAME: "prod-redirect",
    EBAY_SANDBOX_CLIENT_ID: "test-id", EBAY_SANDBOX_CLIENT_SECRET: "test-secret", EBAY_SANDBOX_RUNAME: "test-redirect" };

async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "buyer-oauth-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, "buyers"), keyFile = path.join(root, "keys", "key");
    let clock = Date.now(), respond = async () => Response.json(tokens);
    const requests: { url: string; params: URLSearchParams; headers: Headers }[] = [];
    const options = { directory, keyFile, env: { ...config }, now: () => clock,
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push({ url: String(input), params: new URLSearchParams(String(init?.body)), headers: new Headers(init?.headers) });
            return respond();
        } };
    const service = createBuyerConnection(options);
    async function begin(env: "production" | "sandbox" = "sandbox") {
        return new URL(await service.start(env, "session-a")).searchParams.get("state")!;
    }
    return { service, options, directory, keyFile, requests, begin, response(fn: typeof respond) { respond = fn; }, advance(ms: number) { clock += ms; } };
}

test("authorizes the requested eBay environment and persists only an encrypted refresh credential", async t => {
    const f = await fixture(t);
    const url = new URL(await f.service.start("sandbox", "session-a"));
    assert.equal(url.origin, "https://auth.sandbox.ebay.com");
    assert.equal(url.searchParams.get("redirect_uri"), config.EBAY_SANDBOX_RUNAME);
    assert.equal(url.searchParams.get("client_id"), config.EBAY_SANDBOX_CLIENT_ID);
    assert.equal(url.searchParams.get("scope"), scope);
    const state = url.searchParams.get("state")!;
    await assert.rejects(f.service.complete(state, "code", "different-session"), /same browser/);
    assert.equal(f.requests.length, 0);
    assert.equal(await f.service.complete(state, "v^1+%/", "session-a"), "sandbox");
    assert.equal(f.requests[0].url, "https://api.sandbox.ebay.com/identity/v1/oauth2/token");
    assert.equal(f.requests[0].params.get("code"), "v^1+%/");
    assert.equal(f.requests[0].params.get("grant_type"), "authorization_code");
    assert.equal(f.requests[0].headers.get("authorization"), "Basic " + Buffer.from("test-id:test-secret").toString("base64"));
    const id = await f.service.connectionId("sandbox");
    assert.ok(id);
    assert.equal(await f.service.accessToken("sandbox", id), "test-access");
    assert.equal(f.requests.length, 1);
    const blob = path.join(f.directory, "sandbox.enc");
    assert.equal((await fs.readFile(blob)).includes(Buffer.from("test-refresh")), false);
    assert.equal((await fs.stat(blob)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(f.keyFile)).mode & 0o777, 0o600);
    assert.deepEqual(await f.service.status("production"), { configured: true, connected: false, missing: [] });
    const restarted = createBuyerConnection(f.options);
    assert.equal(await restarted.connectionId("sandbox"), id);
    f.response(async () => Response.json({ access_token: "new-access", expires_in: 7200, token_type: "User Access Token" }));
    assert.deepEqual(await Promise.all([restarted.accessToken("sandbox", id), restarted.accessToken("sandbox", id)]), ["new-access", "new-access"]);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].params.get("refresh_token"), "test-refresh");
    assert.equal(f.requests[1].params.get("scope"), scope);
    await assert.rejects(f.service.complete(state, "duplicate", "session-a"));
    await assert.rejects(f.service.accessToken("production", id));
});

test("misconfiguration, old states, denied consent, expiry and restart require no eBay call", async t => {
    const f = await fixture(t);
    f.options.env.EBAY_RUNAME = "";
    assert.deepEqual(await f.service.status("production"), { configured: false, connected: false, missing: ["EBAY_RUNAME"] });
    await assert.rejects(f.service.start("production", "session-a"), /EBAY_RUNAME/);
    const old = await f.begin(), fresh = await f.begin();
    await assert.rejects(f.service.complete(old, "code", "session-a"));
    assert.equal(await f.service.complete(fresh, null, "session-a"), "sandbox");
    await assert.rejects(f.service.complete(fresh, "replay", "session-a"));
    const expired = await f.begin();
    f.advance(600_001);
    await assert.rejects(f.service.complete(expired, "code", "session-a"));
    const lost = await f.begin();
    await assert.rejects(createBuyerConnection(f.options).complete(lost, "code", "session-a"));
    assert.equal(f.requests.length, 0);
});

test("a disconnect during exchange prevents saving the grant and never revives a bound plan", async t => {
    const f = await fixture(t), state = await f.begin();
    const started = Promise.withResolvers<void>(), response = Promise.withResolvers<Response>();
    f.response(() => { started.resolve(); return response.promise; });
    const connecting = f.service.complete(state, "code", "session-a");
    await started.promise;
    await f.service.disconnect("sandbox");
    f.response(async () => new Response(null, { status: 200 }));
    response.resolve(Response.json(tokens));
    await assert.rejects(connecting, /sign-in has expired or changed/);
    assert.equal(f.requests.filter(request => request.url.endsWith("/revoke")).length, 2);
    assert.equal(await f.service.connectionId("sandbox"), null);
});

test("disconnect erases local authority and attempts eBay revocation even when offline", async t => {
    const f = await fixture(t);
    const start = new URL(await f.service.start("production", "session-a"));
    assert.equal(start.origin, "https://auth.ebay.com");
    assert.equal(start.searchParams.get("scope"), "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly");
    f.response(async () => Response.json({ ...tokens, scope: "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly" }));
    await f.service.complete(start.searchParams.get("state")!, "code", "session-a");
    assert.equal(f.requests[0].url, "https://api.ebay.com/identity/v1/oauth2/token");
    const old = await f.service.connectionId("production");
    assert.ok(old);
    f.response(async () => { throw new Error("private request detail"); });
    await assert.rejects(f.service.disconnect("production"), /Disconnected locally/);
    assert.deepEqual(f.requests.slice(1).map(r => r.params.get("token_type_hint")).sort(), ["access_token", "refresh_token"]);
    assert.ok(f.requests.slice(1).every(r => r.url === "https://api.ebay.com/identity/v1/oauth2/token/revoke"));
    await assert.rejects(f.service.accessToken("production", old));
    f.response(async () => Response.json(tokens));
    await f.service.complete(await f.begin("production"), "new-code", "session-a");
    const newId = await f.service.connectionId("production");
    assert.ok(newId);
    assert.notEqual(newId, old);
    await f.service.invalidate("production", old);
    assert.equal(await f.service.connectionId("production"), newId);
});

test("rejected scopes and revoked refresh tokens do not grant buyer access", async t => {
    const f = await fixture(t);
    f.response(async () => Response.json({ ...tokens, scope: "irrelevant" }));
    await assert.rejects(f.service.complete(await f.begin(), "code", "session-a"), /incomplete/);
    assert.equal(await f.service.connectionId("sandbox"), null);
    f.response(async () => Response.json(tokens));
    await f.service.complete(await f.begin(), "code", "session-a");
    const id = await f.service.connectionId("sandbox");
    assert.ok(id);
    f.advance(7200_000);
    f.response(async () => Response.json({ error: "invalid_grant", error_description: "private-value" }, { status: 400 }));
    await assert.rejects(f.service.accessToken("sandbox", id), /withdrawn/);
    assert.equal(await f.service.connectionId("sandbox"), null);
});

test("corrupted stored credentials fail closed without replacing the key or contacting eBay", async t => {
    const f = await fixture(t), state = await f.begin();
    const file = path.join(f.directory, "sandbox.enc");
    const contents = await fs.readFile(file);
    contents[contents.length - 1] ^= 1;
    await fs.writeFile(file, contents);
    await assert.rejects(f.service.complete(state, "code", "session-a"));
    await assert.rejects(f.service.status("sandbox"));
    assert.equal(f.requests.length, 0);
});
