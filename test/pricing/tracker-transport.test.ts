import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupCards } from "../../server/pricing/price-tracker.ts";
test("duplicate tracker lookups share one bounded request, and a stalled provider fails without retrying", async t => {
    const old = process.env.POKEMON_PRICE_TRACKER_API_KEY;
    process.env.POKEMON_PRICE_TRACKER_API_KEY = "offline-test";
    t.after(() => { if (old === undefined) delete process.env.POKEMON_PRICE_TRACKER_API_KEY; else process.env.POKEMON_PRICE_TRACKER_API_KEY = old; });
    let calls = 0; let stalled = false;
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, 20_000); return originalTimeout(stalled ? 5 : ms); });
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        calls++; assert.ok(init?.signal);
        if (stalled) return new Promise<Response>((_resolve, reject) => { const timer = setTimeout(() => reject(Error("test transport did not abort")), 500); init.signal!.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true }); });
        return Response.json({ data: [] });
    });
    const query = { set: "offline", name: `shared-${Date.now()}` };
    assert.deepEqual(await Promise.all([lookupCards(query), lookupCards(query)]), [[], []]);
    assert.equal(calls, 1);
    stalled = true;
    await assert.rejects(lookupCards({ ...query, name: query.name + "-stalled" }), /timed out/);
    assert.equal(calls, 2, "a failed provider does not spend automatic retries");
});
