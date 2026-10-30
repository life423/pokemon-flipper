import { test } from "node:test";
import assert from "node:assert/strict";
import { withPricingRecovery, ASSESSMENT_PRICE_WAIT_MS } from "../../server/pricing/recover.ts";
import { PricingProviderError } from "../../server/pricing/errors.ts";

test("an assessment resumes its failed price stage after cooldown without repeating completed work", async () => {
    let time = 1000; let calls = 0; const waits: number[] = [];
    const result = await withPricingRecovery(async () => { calls++; if (calls === 1) throw new PricingProviderError("cooldown", "RATE_LIMIT", 31_000); return { grade: 7, median: 100 }; }, {
        now: () => time, wait: async ms => { waits.push(ms); time += ms; },
    });
    assert.equal(calls, 2); assert.deepEqual(waits, [30_000]); assert.deepEqual(result, { grade: 7, median: 100 });
});

test("missing comps and successful prices do not repeat a pricing stage", async () => {
    let calls = 0;
    const result = await withPricingRecovery(async () => { calls++; return { status: "PRICE_UNAVAILABLE", reason: "No sales" }; }, { wait: async () => { throw Error("unexpected wait"); } });
    assert.equal(calls, 1); assert.equal(result.status, "PRICE_UNAVAILABLE");
});

test("account problems, identity errors and long provider waits do not start another attempt", async () => {
    for (const error of [new PricingProviderError("credits", "CREDITS"), new PricingProviderError("config", "CONFIG"), new Error("wrong card"), new PricingProviderError("long wait", "RATE_LIMIT", 1000 + ASSESSMENT_PRICE_WAIT_MS + 1)]) {
        let calls = 0;
        await assert.rejects(withPricingRecovery(async () => { calls++; throw error; }, { now: () => 1000, wait: async () => { throw Error("unexpected wait"); } }), e => e === error);
        assert.equal(calls, 1);
    }
});

test("a second temporary failure stops, and a retry without a date uses bounded backoff", async () => {
    let calls = 0; const waits: number[] = [];
    await assert.rejects(withPricingRecovery(async () => { calls++; throw new PricingProviderError("temporary", "TEMPORARY"); }, { now: () => 1000, wait: async ms => { waits.push(ms); } }));
    assert.equal(calls, 2); assert.deepEqual(waits, [30_000]);
});
