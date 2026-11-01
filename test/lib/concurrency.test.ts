import { test } from "node:test";
import assert from "node:assert/strict";
import { createLimiter } from "../../server/lib/concurrency.ts";

test("100 concurrent jobs make progress without admitting a 101st, and failures release slots", async () => {
    const limit = createLimiter(100); let active = 0, peak = 0, started = 0;
    let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
    const jobs = Array.from({ length: 205 }, (_, index) => limit(async () => {
        started++; active++; peak = Math.max(peak, active);
        try { await gate; if (index === 0) throw new Error("expected failure"); }
        finally { active--; }
    }));
    assert.equal(started, 100); assert.equal(active, 100);
    release(); const results = await Promise.allSettled(jobs);
    assert.equal(started, 205); assert.equal(peak, 100); assert.equal(active, 0);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
});

test("live work takes the next shared slot ahead of queued historical reviews; equal priorities stay FIFO", async () => {
    const limit = createLimiter(1), order: string[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
    const first = limit(() => gate);
    const historical = limit(async () => { order.push("historical"); }, -1);
    const live = limit(async () => { order.push("live"); });
    const liveAgain = limit(async () => { order.push("live-again"); });
    release(); await Promise.all([first, historical, live, liveAgain]);
    assert.deepEqual(order, ["live", "live-again", "historical"]);
});
