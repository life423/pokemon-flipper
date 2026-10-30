import { test } from "node:test";
import assert from "node:assert/strict";
import { ebayGet, EbayAuthenticationError } from "../../server/ebay/api.ts";
import { ProviderError } from "../../server/lib/http.ts";

test("eBay authentication validates configuration, shares failures and recovers without leaking credentials", async t => {
    const before = [process.env.EBAY_CLIENT_ID, process.env.EBAY_CLIENT_SECRET];
    t.after(() => {
        for (const [index, name] of ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"].entries()) {
            if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index];
        }
    });
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    let calls = 0; let tokens = 0; let mode = "rejected";
    t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
        calls++;
        if (String(url).includes("oauth2/token")) {
            tokens++;
            if (mode === "rejected") return Response.json({ error: "invalid_client", error_description: "private-client-secret-do-not-show" }, { status: 401 });
            if (mode === "malformed") return Response.json({ access_token: null, expires_in: 7200 });
            return Response.json({ access_token: "offline-access", expires_in: 7200 });
        }
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer offline-access");
        return Response.json({ ok: true });
    });
    await t.test("missing or incomplete keys never send a network request", async () => {
        delete process.env.EBAY_CLIENT_ID; delete process.env.EBAY_CLIENT_SECRET;
        await assert.rejects(ebayGet("/offline"), error => error instanceof EbayAuthenticationError && /credentials are missing/.test(error.message));
        process.env.EBAY_CLIENT_ID = "offline-id"; process.env.EBAY_CLIENT_SECRET = "  ";
        await assert.rejects(ebayGet("/offline"), /credentials are missing/);
        assert.equal(calls, 0);
    });
    await t.test("concurrent and sequential rejection is shared for one minute with safe text", async () => {
        process.env.EBAY_CLIENT_SECRET = "private-client-secret-do-not-show";
        const results = await Promise.allSettled([ebayGet("/offline"), ebayGet("/usage")]);
        for (const result of results) {
            assert.equal(result.status, "rejected");
            if (result.status === "rejected") { assert.ok(result.reason instanceof EbayAuthenticationError); assert.match(result.reason.message, /matching Production key pair/); assert.doesNotMatch(result.reason.message, /private-client-secret/); }
        }
        await assert.rejects(ebayGet("/offline"), /Production/);
        assert.equal(tokens, 1); assert.equal(calls, 1);
        clock += 60_001;
        await assert.rejects(ebayGet("/offline"), /Production/);
        assert.equal(tokens, 2);
    });
    await t.test("malformed success cannot produce a Bearer undefined request", async () => {
        process.env.EBAY_CLIENT_SECRET = "changed-offline-key"; mode = "malformed";
        await assert.rejects(ebayGet("/offline"), error => error instanceof ProviderError && /invalid token response/.test(error.message));
        assert.equal(calls, 3);
    });
    await t.test("corrected credentials retry immediately and successful tokens remain cached", async () => {
        mode = "success";
        assert.deepEqual(await ebayGet("/offline"), { ok: true });
        assert.deepEqual(await ebayGet("/usage"), { ok: true });
        assert.equal(tokens, 4); assert.equal(calls, 6);
    });
});
