import test from "node:test";
import assert from "node:assert/strict";
import { runBenchmarkQueue } from "../../scripts/review/benchmark-queue.ts";
import { BOUNDED_AUTO_CONCURRENCY } from "../../shared/research-policy.ts";

const listing = (id: string) => ({ id, title: `Card ${id}`, images: ["photo"], buyingOption: "FIXED_PRICE", currentPrice: 20, shipping: 0, isGraded: false, endTime: null,
    screen: { status: "CANDIDATE" } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve: value => resolve(value) }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const base = { filters: {}, targets: { minProfit: 0, minRoi: 0 }, signal: new AbortController().signal, assertTransport() {},
    failureOf: error => ({ code: error.code, error: error.message }) };

test("diagnostic queue respects the live slot limit, refills it and excludes known ineligible rows", async () => {
    const jobs = [], started = [];
    let inFlight = 0, peak = 0;
    const total = BOUNDED_AUTO_CONCURRENCY + 4;
    const work = runBenchmarkQueue([...Array.from({ length: total }, (_, n) => listing(String(n))), { ...listing("junk"), screen: { junk: true } }], {
        ...base, evaluate: async row => {
            started.push(row.id); peak = Math.max(peak, ++inFlight);
            const job = deferred(); jobs.push(job); await job.promise; inFlight--; return { id: row.id };
        },
    });
    await tick(); assert.equal(started.length, BOUNDED_AUTO_CONCURRENCY);
    for (let n = 0; n < total; n++) { jobs[n].resolve(); await tick(); }
    const result = await work;
    assert.equal(peak, BOUNDED_AUTO_CONCURRENCY); assert.equal(result.admitted.length, total); assert.equal(Object.keys(result.evaluations).length, total);
    assert.equal(started.includes("junk"), false); assert.deepEqual(result.waiting, []);
});

for (const code of ["AI_BUDGET", "PRICE_RESEARCH_BUDGET"]) test(`${code} denial stops admissions and preserves another accepted response`, async () => {
    const accepted = deferred(); let calls = 0;
    const work = runBenchmarkQueue(Array.from({ length: BOUNDED_AUTO_CONCURRENCY + 3 }, (_, n) => listing(String(n))), {
        ...base, evaluate: async () => {
            calls++;
            if (calls === 1) throw Object.assign(new Error("Insufficient reservation"), { code });
            await accepted.promise; return { saved: true };
        },
    });
    await tick(); accepted.resolve(); const result = await work;
    assert.equal(calls, BOUNDED_AUTO_CONCURRENCY); assert.equal(result.stopped?.code, code);
    assert.deepEqual(result.errors, {}, "a spending pause is not a manual-review error");
    assert.equal(Object.keys(result.evaluations).length, BOUNDED_AUTO_CONCURRENCY - 1); assert.equal(result.waiting.length, 3);
});

test("a held photo request leaves the queue open for independent candidates", async () => {
    const rows = ["held", "next", "later"].map(listing);
    const result = await runBenchmarkQueue(rows, {
        ...base, evaluate: async row => {
            if (row.id === "held") throw Object.assign(new Error("Earlier photo request unresolved"), { code: "AI_EVIDENCE_HELD" });
            return { id: row.id };
        },
    });
    assert.equal(result.stopped, null);
    assert.equal(result.failures.held.code, "AI_EVIDENCE_HELD");
    assert.deepEqual(result.errors, {});
    assert.equal(result.admitted.filter(id => id === "held").length, 1);
    assert.deepEqual(Object.keys(result.evaluations).sort(), ["later", "next"]);
});

test("non-English assessments are excluded rather than becoming manual review errors", async () => {
    const result = await runBenchmarkQueue([listing("foreign")], {
        ...base, evaluate: async () => { throw Object.assign(new Error("Not English"), { code: "OTHER_LANGUAGE" }); },
    });
    assert.deepEqual(result.otherLanguage, ["foreign"]); assert.deepEqual(result.errors, {});
    assert.equal(result.stopped, null); assert.equal(result.failures.foreign.code, "OTHER_LANGUAGE");
});

test("a diagnostic transport stop cannot refill the queue or retry an errored assessment", async () => {
    let blocked = false, calls = 0;
    const result = await runBenchmarkQueue(Array.from({ length: 8 }, (_, n) => listing(String(n))), {
        ...base, assertTransport() { if (blocked) throw new Error("Diagnostic price ceiling reached"); },
        evaluate: async () => { calls++; blocked = true; throw new Error("Provider blocked"); },
    });
    assert.equal(calls, BOUNDED_AUTO_CONCURRENCY); assert.equal(result.admitted.length, BOUNDED_AUTO_CONCURRENCY);
    assert.equal(result.stopped?.code, "DIAGNOSTIC_TRANSPORT_LIMIT"); assert.equal(result.waiting.length, 8 - BOUNDED_AUTO_CONCURRENCY);
});
