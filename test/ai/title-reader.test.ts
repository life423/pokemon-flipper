import { test } from "node:test";
import assert from "node:assert/strict";
import { createTitleReader } from "../../server/ai/title-reader.ts";
import { createBatcher } from "../../server/lib/batcher.ts";

const reading = { cardName: "Charizard", set: "Base Set", cardNumber: "4/102", language: null };

test("single requests are answered in batches, each with its own answer", async () => {
    const batches = [];
    const double = createBatcher(
        async (numbers) => {
            batches.push(numbers.length);
            return numbers.map((n) => n * 2);
        },
        { maxSize: 3, maxWaitMs: 5 }
    );

    const answers = await Promise.all([1, 2, 3, 4, 5].map(double));

    assert.deepEqual(answers, [2, 4, 6, 8, 10]);
    assert.deepEqual(batches, [3, 2]);
});

test("title readings still use full batches of 25 and reuse cached answers", async () => {
    const batches = [];
    const cache = new Map();
    const read = createTitleReader({
        load: async (key) => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, value); },
        read: async (titles) => {
            batches.push(titles.length);
            return titles.map(() => reading);
        },
    });

    const answers = await Promise.all(Array.from({ length: 50 }, (_, index) => read(`Card ${index}`)));
    assert.deepEqual(batches, [25, 25]);
    assert.ok(answers.every((answer) => answer === reading));
    assert.equal(await read("Card 0"), reading);
    assert.deepEqual(batches, [25, 25]);
});

test("cancelled title batches waiting for an AI slot do not make paid requests", async () => {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    let calls = 0;
    const read = createTitleReader({
        load: async () => null,
        save: async () => {},
        read: async (titles) => {
            calls += 1;
            if (calls === 100) started.resolve();
            await release.promise;
            return titles.map(() => reading);
        },
    });
    const stopped = new AbortController();
    const active = Array.from({ length: 2500 }, (_, index) => read(`Active ${index}`));
    const queued = Array.from({ length: 25 }, (_, index) => read(`Cancelled ${index}`, stopped.signal));

    await started.promise;
    stopped.abort();
    release.resolve();

    assert.ok((await Promise.all(active)).every((answer) => answer === reading));
    assert.deepEqual(await Promise.all(queued), Array(25).fill(null));
    assert.equal(calls, 100);
});

test("one cancelled search does not cancel a shared title needed by another search", async () => {
    let calls = 0;
    const read = createTitleReader({
        load: async () => null,
        save: async () => {},
        read: async (titles) => { calls += 1; return titles.map(() => reading); },
    });
    const stopped = new AbortController();
    const live = new AbortController();
    const first = read("Shared title", stopped.signal);
    const second = read("Shared title", live.signal);
    stopped.abort();

    assert.deepEqual(await Promise.all([first, second]), [reading, reading]);
    assert.equal(calls, 1);
    assert.equal(await read("Already stopped", stopped.signal), null);
    assert.equal(calls, 1);
});


test("a title batch stops at global dispatch while already accepted answers still save for a restart", async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const cache = new Map(); let calls = 0;
    const stopped = new AbortController();
    const read = createTitleReader({ load: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, value); },
        read: async (titles, signal) => {
            calls++; started.resolve(signal!);
            // An accepted request intentionally finishes despite cancellation.
            await release.promise;
            return titles.map(() => reading);
        },
    });
    const first = read("Accepted title", stopped.signal);
    const dispatchSignal = await started.promise;
    stopped.abort();
    assert.equal(dispatchSignal.aborted, true);
    const resumed = read("Accepted title");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 1, "a restart cannot repay while the accepted answer is saving");
    release.resolve();
    assert.deepEqual(await Promise.all([first, resumed]), [reading, reading]);
    assert.equal(calls, 1);
});

test("title dispatch cancellation reaches a queued request before it is paid", async () => {
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let paid = 0; const stopped = new AbortController();
    const read = createTitleReader({ load: async () => null, save: async () => {},
        read: async (titles, signal) => {
            started.resolve(); await release.promise;
            signal?.throwIfAborted(); paid++;
            return titles.map(() => reading);
        },
    });
    const result = read("Queued title", stopped.signal);
    await started.promise; stopped.abort(); release.resolve();
    assert.equal(await result, null); assert.equal(paid, 0);
});
