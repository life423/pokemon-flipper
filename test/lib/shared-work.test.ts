import { test } from "node:test";
import assert from "node:assert/strict";
import { createSharedWork, drainSharedWork } from "../../server/lib/shared-work.ts";

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

test("shutdown drains detached accepted jobs through their final save before storage can close", async () => {
    const share = createSharedWork(), stopped = new AbortController();
    const started = deferred<void>(), response = deferred<number>(), save = deferred<void>();
    let saved = false, closed = false, dispatched = 0;
    const work = share("accepted", async () => {
        dispatched++; started.resolve();
        const accepted = await response.promise;
        await save.promise;
        assert.equal(closed, false, "SQL must remain available while an accepted answer saves");
        saved = true;
        return accepted;
    }, stopped.signal);
    await started.promise; stopped.abort(); await assert.rejects(work, { name: "AbortError" });
    let finished = false;
    const shutdown = drainSharedWork().then(result => { assert.equal(saved, true); closed = true; finished = true; return result; });
    response.resolve(42);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(finished, false, "consumer cancellation and a returned response are not completion barriers");
    save.resolve();
    assert.deepEqual(await shutdown, { complete: true, pending: 0 });
    assert.equal(dispatched, 1); assert.equal(closed, true);
});

test("a drain timeout reports incomplete accepted work without cancelling it or authorizing another dispatch", async () => {
    const share = createSharedWork(), stopped = new AbortController(), started = deferred<AbortSignal>(), response = deferred<number>();
    let saved = false, dispatched = 0;
    const work = share("late", async signal => { dispatched++; started.resolve(signal); const value = await response.promise; saved = true; return value; }, stopped.signal);
    const signal = await started.promise; stopped.abort(); await assert.rejects(work, { name: "AbortError" });
    assert.equal(signal.aborted, true);
    assert.deepEqual(await drainSharedWork({ timeoutMs: 0 }), { complete: false, pending: 1 });
    assert.equal(saved, false); assert.equal(dispatched, 1);
    response.resolve(7);
    assert.deepEqual(await drainSharedWork(), { complete: true, pending: 0 });
    assert.equal(saved, true); assert.equal(dispatched, 1);
});
