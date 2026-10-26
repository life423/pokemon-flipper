import { test } from "node:test";
import assert from "node:assert/strict";
import { createSingleFlight } from "../../server/lib/single-flight.ts";
import { fetchJson } from "../../server/lib/http.ts";

test("concurrent lookups share work and failures can be retried", async () => {
    const share = createSingleFlight();
    let calls = 0;
    const release = Promise.withResolvers();
    const work = async () => { calls += 1; await release.promise; return 42; };
    const requests = Array.from({ length: 20 }, () => share("same-card", work));
    release.resolve();
    assert.deepEqual(await Promise.all(requests), Array(20).fill(42));
    assert.equal(calls, 1);
    await assert.rejects(share("failure", async () => { throw new Error("temporary"); }));
    assert.equal(await share("failure", async () => 7), 7);
    assert.equal(await share("same-card", async () => 43), 43);
});

test("provider deadlines also cover a stalled response body", async (t) => {
    const keepAlive = setTimeout(() => {}, 1000);
    t.mock.method(globalThis, "fetch", async (_url, init) => ({
        ok: true,
        json: () => new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        }),
    }));
    try {
        await assert.rejects(fetchJson("https://example.invalid", {}, { service: "Test provider", timeoutMs: 10 }), /Test provider timed out/);
    } finally { clearTimeout(keepAlive); }
});

test("a rate-limited price service cools down across different lookups instead of hammering it", async (t) => {
    const { lookupCards } = await import("../../server/pricing/pkmnprices.ts");
    const previous = process.env.PKMNPRICES_API_KEY;
    process.env.PKMNPRICES_API_KEY = "offline-test-key";
    t.after(() => { if (previous === undefined) delete process.env.PKMNPRICES_API_KEY; else process.env.PKMNPRICES_API_KEY = previous; });
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: "RATE_LIMIT", message: "Too many requests" } }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" } });
    });
    await assert.rejects(lookupCards({ set: "Offline cooldown test alpha", name: "Audit", cardNumber: "1" }), /rate limited/);
    await assert.rejects(lookupCards({ set: "Offline cooldown test bravo", name: "Audit", cardNumber: "2" }), /cooling down/);
    assert.equal(calls, 1);
});
