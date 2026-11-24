import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readSniperQuote, sandboxBuyerId, sniperCapabilities, submitSandboxBid, SandboxBidRejected } from "../../server/ebay/sniper.ts";
import { buyerConnection } from "../../server/ebay/buyer-connection.ts";
import { browseSearchAllowance } from "../../server/ebay/search-budget.ts";
import { withAiUsageContext } from "../../server/ai/usage-context.ts";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";

const itemId = "v1|123456789012|0";
const usd = (value: string) => ({ currency: "USD", value });
function auction() {
    return {
        itemId, title: "Mewtwo holo", buyingOptions: ["AUCTION", "FIXED_PRICE"], listingMarketplaceId: "EBAY_US",
        itemEndDate: new Date(Date.now() + 300_000).toISOString(), bidCount: 0, price: usd("99.99"), minimumPriceToBid: usd("10.00"),
        shippingOptions: [{ shippingCost: usd("2.00"), shippingCostType: "CALCULATED", shipToLocationUsedForEstimate: { country: "US", postalCode: "7****" } }],
    };
}

function config(t: TestContext, values: Record<string, string>) {
    for (const [key, value] of Object.entries(values)) {
        const old = process.env[key];
        process.env[key] = value;
        t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    }
}

test("reminder rereads live auction terms against the same Browse allowance and uses the opening minimum", async t => {
    offlineEbayCredentials(t);
    config(t, { EBAY_SHIP_TO_ZIP: "76133" });
    let browse = 0;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        assert.equal(new URL(url).hostname, "api.ebay.com");
        if (url.includes("/oauth2/token")) return Response.json({ access_token: "fixture", expires_in: 1000 });
        assert.equal(init.method ?? "GET", "GET");
        if (url.includes("/analytics/")) return Response.json({ rateLimits: [] });
        assert.match(url, /\/buy\/browse\/v1\/item\//);
        assert.match(new Headers(init.headers).get("X-EBAY-C-ENDUSERCTX")!, /76133/);
        return Response.json(++browse === 1 ? auction() : { ...auction(), bidCount: 1, currentBidPrice: usd("10.00"), minimumPriceToBid: usd("10.50") });
    });
    const first = await readSniperQuote(itemId, "reminder", undefined, "sniper-test");
    const second = await readSniperQuote(itemId, "reminder", undefined, "sniper-test");
    assert.deepEqual([first.currentBid, first.minimumBid, first.shipping, second.currentBid, second.minimumBid], [null, 10, 2, 10, 10.50]);
    assert.equal(await withAiUsageContext({ searchId: "sniper-test" }, async () => (await browseSearchAllowance())?.used), 2);
});

test("sandbox checks first bid and existing bidder with distinct tokens, and preserves unknown terms", async t => {
    config(t, { EBAY_SANDBOX_APP_ACCESS_TOKEN: "fixture-app", EBAY_SANDBOX_USER_ACCESS_TOKEN: "fixture-buyer", EBAY_SHIP_TO_ZIP: "76133" });
    let offerStatus = 404, errorId = 120033;
    let listing: Record<string, unknown> = auction();
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        requests.push(url);
        assert.equal(new URL(url).hostname, "api.sandbox.ebay.com");
        assert.equal(init.redirect, "error");
        const headers = new Headers(init.headers);
        assert.equal(headers.get("X-EBAY-C-MARKETPLACE-ID"), "EBAY_US");
        if (url.includes("/offer/")) {
            assert.equal(headers.get("Authorization"), "Bearer fixture-buyer");
            return offerStatus === 200 ? Response.json({ itemId, auctionStatus: "ACTIVE", highBidder: true }) : Response.json({ errors: [{ errorId }] }, { status: offerStatus });
        }
        assert.equal(headers.get("Authorization"), "Bearer fixture-app");
        return Response.json(listing);
    });
    assert.deepEqual(await sniperCapabilities(), { sandbox: true });
    const quote = await readSniperQuote(itemId, "sandbox");
    assert.equal(quote.url, "https://www.sandbox.ebay.com/itm/123456789012");
    assert.deepEqual([quote.currentBid, quote.minimumBid, quote.shipping, quote.highBidder], [null, 10, 2, false]);
    offerStatus = 200;
    listing = { ...auction(), minimumPriceToBid: { ...usd("7.99"), convertedFromCurrency: "CAD" }, shippingOptions: [] };
    const leading = await readSniperQuote(itemId, "sandbox");
    assert.deepEqual([leading.minimumBid, leading.currentBid, leading.shipping, leading.highBidder], [null, null, null, true]);
    listing = { ...auction(), itemId: "v1|123456789013|0" };
    await assert.rejects(readSniperQuote(itemId, "sandbox"), /active US auction/);
    offerStatus = 404; errorId = 120001;
    await assert.rejects(readSniperQuote(itemId, "sandbox"), /HTTP 404/);
    offerStatus = 401;
    await assert.rejects(readSniperQuote(itemId, "sandbox"), /authorization failed/i);
    assert.equal(requests.length, 8);
});

test("sandbox dispatch sends a single exact capped POST and distinguishes rejection from uncertain delivery", async t => {
    config(t, { EBAY_SANDBOX_USER_ACCESS_TOKEN: "fixture-only", EBAY_SANDBOX_APP_ACCESS_TOKEN: "fixture-app" });
    const buyerId = (await sandboxBuyerId())!;
    let posts = 0;
    const responses = [Response.json({ proxyBidId: "test-receipt" }), Response.json({}, { status: 409 }), Response.json({}), new Error("Socket disconnected")];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        posts++;
        assert.equal(url, "https://api.sandbox.ebay.com/buy/offer/v1_beta/bidding/v1%7C123456789012%7C0/place_proxy_bid");
        assert.equal(init.redirect, "error");
        assert.equal(init.method, "POST");
        assert.deepEqual(JSON.parse(String(init.body)), { maxAmount: { currency: "USD", value: "40.05" } });
        const result = responses.shift();
        if (result instanceof Error) throw result;
        return result;
    });
    await assert.rejects(submitSandboxBid("https://www.ebay.com/itm/123456789012", 40.05, undefined, buyerId));
    await assert.rejects(submitSandboxBid(itemId, 40.051, undefined, buyerId), SandboxBidRejected);
    assert.equal(await submitSandboxBid(itemId, 40.05, undefined, buyerId), "test-receipt");
    await assert.rejects(submitSandboxBid(itemId, 40.05, undefined, buyerId), SandboxBidRejected);
    await assert.rejects(submitSandboxBid(itemId, 40.05, undefined, buyerId), /receipt/);
    await assert.rejects(submitSandboxBid(itemId, 40.05, undefined, buyerId), /Socket disconnected/);
    process.env.EBAY_SANDBOX_USER_ACCESS_TOKEN = "another-test-buyer";
    await assert.rejects(submitSandboxBid(itemId, 40.05, undefined, buyerId), SandboxBidRejected);
    assert.equal(posts, 4);
});

test("a linked sandbox buyer uses its grant for Offer and an independent sandbox application token for Browse", async t => {
    config(t, {
        EBAY_SANDBOX_RUNAME: "test-redirect", EBAY_SANDBOX_CLIENT_ID: "test-sandbox-id", EBAY_SANDBOX_CLIENT_SECRET: "test-secret",
        EBAY_SANDBOX_USER_ACCESS_TOKEN: "manual-buyer", EBAY_SANDBOX_APP_ACCESS_TOKEN: "",
    });
    let current: string | null = "linked-buyer";
    t.mock.method(buyerConnection, "connectionId", async (env: string) => { assert.equal(env, "sandbox"); return current; });
    t.mock.method(buyerConnection, "accessToken", async (env: string, expected: string) => {
        assert.equal(env, "sandbox"); assert.equal(expected, current);
        return "user-access";
    });
    t.mock.method(buyerConnection, "invalidate", async (env: string, expected: string) => {
        assert.equal(env, "sandbox"); assert.equal(expected, current); current = null;
    });
    let mints = 0, rejected = false, posts = 0;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        assert.equal(new URL(url).hostname, "api.sandbox.ebay.com");
        const auth = new Headers(init.headers).get("Authorization");
        if (url.includes("/oauth2/token")) {
            mints++;
            assert.match(auth!, /^Basic /);
            assert.equal((init.body as URLSearchParams).get("grant_type"), "client_credentials");
            return Response.json({ access_token: "browse-access", expires_in: 7200 });
        }
        if (url.includes("/browse/")) {
            assert.equal(auth, "Bearer browse-access");
            return Response.json(auction());
        }
        assert.equal(auth, "Bearer user-access");
        if (init.method === "POST") posts++;
        if (rejected) return Response.json({}, { status: 401 });
        return Response.json({ errors: [{ errorId: 120033 }] }, { status: 404 });
    });
    for (let n = 0; n < 2; n++) assert.equal((await readSniperQuote(itemId, "sandbox")).buyerConnectionId, "linked-buyer");
    assert.equal(mints, 1);
    rejected = true;
    await assert.rejects(submitSandboxBid(itemId, 20, undefined, "linked-buyer"), SandboxBidRejected);
    assert.deepEqual(await sniperCapabilities(), { sandbox: false });
    await assert.rejects(submitSandboxBid(itemId, 20, undefined, "linked-buyer"), SandboxBidRejected);
    assert.equal(posts, 1);
});
