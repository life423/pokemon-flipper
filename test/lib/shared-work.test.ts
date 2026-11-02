import { test } from "node:test";
import assert from "node:assert/strict";
import { createSharedWork } from "../../server/lib/shared-work.ts";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

test("one stopped consumer cannot cancel shared work another consumer still needs", async () => {
    const share = createSharedWork();
    const a = new AbortController(), b = new AbortController();
    const started = deferred<AbortSignal>(), finish = deferred<number>(); let calls = 0;
    const run = async (signal: AbortSignal) => { calls++; started.resolve(signal); return finish.promise; };
    const first = share("same", run, a.signal), second = share("same", run, b.signal);
    const signal = await started.promise;
    a.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal(signal.aborted, false);
    finish.resolve(42);
    assert.equal(await second, 42); assert.equal(calls, 1);
});

test("a restart waits for an accepted paid answer to save before checking the cache", async () => {
    const share = createSharedWork();
    const stopped = new AbortController(), started = deferred<AbortSignal>(), finish = deferred<number>();
    let paid = 0, cached: number | undefined;
    const run = async (signal: AbortSignal) => {
        signal.throwIfAborted();
        if (cached !== undefined) return cached;
        paid++; started.resolve(signal);
        cached = await finish.promise; // An already accepted call can finish and checkpoint.
        return cached;
    };
    const first = share("same", run, stopped.signal);
    const signal = await started.promise;
    stopped.abort();
    await assert.rejects(first, { name: "AbortError" });
    assert.equal(signal.aborted, true);
    const resumed = share("same", run);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(paid, 1);
    finish.resolve(17);
    assert.equal(await resumed, 17); assert.equal(paid, 1);
});

test("all consumers stopping before dispatch prevents work; failures release the key", async () => {
    const share = createSharedWork(); const stopped = new AbortController(); let calls = 0;
    const pending = share("same", async () => { calls++; return 1; }, stopped.signal);
    stopped.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await assert.rejects(share("same", async () => { throw new Error("offline failure"); }), /offline failure/);
    assert.equal(await share("same", async () => 2), 2);
    assert.equal(calls, 0);
});
