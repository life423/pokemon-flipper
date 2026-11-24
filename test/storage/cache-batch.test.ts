import "../fixtures/isolated-data.ts";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createCacheStore } from "../../server/lib/cache.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";

const now = Date.parse("2026-11-24T20:00:00Z");
const entry = (key: string, age = 0) => ({ key, savedAt: new Date(now - age).toISOString(), data: { key } });

test("concurrent single reads coalesce and subsequent writes stay visible", async () => {
    const calls: string[][] = [];
    let saved = entry("a");
    const store = createCacheStore({ backend: () => "azure-sql", now: () => now, sql: {
        readCacheEntry: async () => assert.fail("concurrent reads must batch"),
        readCacheEntries: async keys => { calls.push(keys); return keys.filter(key => key === "a").map(() => saved); },
        writeCacheEntry: async update => { saved = update as typeof saved; },
    } });
    const [first, duplicate, missing] = await Promise.all([store.read<{ key: string }>("a", 1), store.read<{ key: string }>("a", 1), store.read("missing", 1)]);
    assert.deepEqual(calls, [["a", "missing"]]);
    assert.equal(missing, null);
    first!.key = "one caller's local change";
    assert.equal(duplicate!.key, "a");
    await store.write("a", { key: "corrected" });
    assert.deepEqual(await store.read("a", 1), { key: "corrected" });
    assert.equal(calls.length, 2);
});

test("cache coalescing respects the SQL batch bound and completes every caller", async () => {
    const sizes: number[] = [];
    const store = createCacheStore({ backend: () => "azure-sql", now: () => now, sql: {
        readCacheEntry: async () => assert.fail("single SQL fallback"), writeCacheEntry: async () => assert.fail("unexpected write"),
        readCacheEntries: async keys => { sizes.push(keys.length); return keys.map(key => entry(key)); },
    } });
    const answers = await Promise.all(Array.from({ length: 1001 }, (_, index) => store.read<{ key: string }>(String(index), 1)));
    assert.deepEqual(sizes, [500, 500, 1]);
    assert.ok(answers.every((answer, index) => answer?.key === String(index)));
});

test("a failed cache batch rejects all subscribers without automatic fallback or retry", async () => {
    let calls = 0, fail = true;
    const failure = new StorageUnavailableError("Database unavailable");
    const store = createCacheStore({ backend: () => "azure-sql", now: () => now, sql: {
        readCacheEntry: async () => assert.fail("single SQL fallback"), writeCacheEntry: async () => assert.fail("unexpected write"),
        readCacheEntries: async keys => { calls++; if (fail) throw failure; return keys.map(key => entry(key)); },
    } });
    const answers = await Promise.allSettled([store.read("a", 1), store.read("b", 1), store.read("c", 1)]);
    assert.ok(answers.every(answer => answer.status === "rejected" && answer.reason === failure));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    fail = false;
    assert.deepEqual(await store.read("a", 1), { key: "a" });
    assert.equal(calls, 2);
});

test("one SQL batch preserves requested order, duplicate independence and cache ages", async () => {
    const calls: string[][] = [];
    const store = createCacheStore({ backend: () => "azure-sql", now: () => now, sql: {
        readCacheEntry: async () => assert.fail("a batch must not issue per-key reads"),
        writeCacheEntry: async () => assert.fail("reading must not change evidence"),
        readCacheEntries: async keys => { calls.push(keys); return [entry("b"), entry("a"), entry("old", 7_200_000), entry("future", -1)]; },
    } });
    assert.deepEqual(await store.readMany([], 1), []);
    const result = await store.readMany<{ key: string }>(["a", "b", "missing", "old", "future", "a"], 1);
    assert.deepEqual(calls, [["a", "b", "missing", "old", "future"]]);
    assert.deepEqual(result, [{ key: "a" }, { key: "b" }, null, null, null, { key: "a" }]);
    result[0]!.key = "changed locally";
    assert.equal(result[5]!.key, "a");
});

test("invalid SQL batch evidence fails without per-key fallback or replacement work", async () => {
    let rows: unknown[] = [];
    const store = createCacheStore({ backend: () => "azure-sql", now: () => now, sql: {
        readCacheEntry: async () => assert.fail("corruption cannot authorize fallback"),
        writeCacheEntry: async () => assert.fail("corruption cannot authorize a write"),
        readCacheEntries: async () => rows as ReturnType<typeof entry>[],
    } });
    for (const invalid of [[entry("wrong")], [entry("a"), entry("a")], [{ ...entry("a"), savedAt: "bad" }], [{ key: "a", savedAt: new Date(now).toISOString() }], [null]]) {
        rows = invalid;
        await assert.rejects(store.readMany(["a"], 1), StorageUnavailableError);
    }
});

test("file batches retain legacy wrappers and preserve corrupt files", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pf-cache-batch-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = (key: string) => path.join(directory, createHash("sha1").update(key).digest("hex") + ".json");
    const store = createCacheStore({ directory, backend: () => "file", now: () => now });
    await fs.writeFile(file("legacy"), JSON.stringify({ savedAt: new Date(now).toISOString(), data: "paid answer" }));
    assert.deepEqual(await store.readMany(["legacy", "missing"], 1), ["paid answer", null]);
    await fs.writeFile(file("broken"), "null");
    await assert.rejects(store.readMany(["legacy", "broken"], 1), StorageUnavailableError);
    assert.equal(await fs.readFile(file("broken"), "utf8"), "null");
});
