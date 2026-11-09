import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setYears } from "../../server/pricing/price-tracker.ts";
test("set year lookups share a bounded request and reuse the saved catalog", async t => {
    const old = process.env.POKEMON_PRICE_TRACKER_API_KEY;
    process.env.POKEMON_PRICE_TRACKER_API_KEY = "offline-test";
    t.after(() => { if (old === undefined) delete process.env.POKEMON_PRICE_TRACKER_API_KEY; else process.env.POKEMON_PRICE_TRACKER_API_KEY = old; });
    let calls = 0; let stalled = true;
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, 20_000); return originalTimeout(stalled ? 5 : ms); });
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        calls++; assert.ok(init?.signal);
        assert.equal(new URL(url).pathname, "/api/v2/sets");
        if (stalled) return new Promise<Response>((_resolve, reject) => { const timer = setTimeout(() => reject(Error("test transport did not abort")), 500); init.signal!.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true }); });
        return Response.json({ data: [{ name: "Offline Set", releaseDate: "2020-01-01", language: "English" }] });
    });
    await assert.rejects(Promise.all([setYears(), setYears()]), /timed out/);
    assert.equal(calls, 1, "concurrent callers share the failed attempt without automatic retries");
    stalled = false;
    const expected = { "offline set": 2020 };
    assert.deepEqual(await Promise.all([setYears(), setYears()]), [expected, expected]);
    assert.deepEqual(await setYears(), expected);
    assert.equal(calls, 2, "concurrent success and cache reuse share one more request");
});
