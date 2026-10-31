import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { cachedCompChecks } from "../../server/ai/comp-checker.ts";
import type { Comp } from "../../server/pricing/types.ts";
test("reading existing comp verdicts never starts a paid request for uncached evidence", async t => {
    let files = 0, requests = 0;
    t.mock.method(fs, "readFile", async () => {
        if (files++ > 0) throw Error("uncached sale");
        return JSON.stringify({ savedAt: new Date(Date.now()).toISOString(), data: { keep: true, reason: null, note: "matches" } });
    });
    t.mock.method(globalThis, "fetch", async () => { requests++; throw Error("No paid request allowed"); });
    const sales = [1, 2].map(id => ({ id, title: `Offline card ${id}` } as Comp));
    const result = await cachedCompChecks(sales, { cardName: "Offline", setName: "Offline set", cardNumber: "1/1", printingLabel: "Unlimited", grader: "RAW", grade: "LIGHTLY_PLAYED" });
    assert.equal(result.size, 1); assert.equal(result.get(sales[0])?.keep, true);
    assert.equal(result.has(sales[1]), false); assert.equal(requests, 0);
});
