import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCacheStore } from "../../server/lib/cache.ts";
import { createAssessmentStore, photoFingerprint, reusableRecord } from "../../server/analysis/store.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import type { SavedRecord } from "../../server/analysis/types.ts";

const run = promisify(execFile);
const at = Date.parse("2026-11-02T18:00:00Z");
const filename = (directory: string, key: string) => path.join(directory, `${createHash("sha1").update(key).digest("hex")}.json`);
const noSql = {
    readCacheEntry: async () => { assert.fail("file mode must not query SQL"); },
    writeCacheEntry: async () => { assert.fail("file mode must not write SQL"); },
};
async function temporary(t: { after(callback: () => unknown): void }) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-storage-integration-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test("file caches preserve legacy wrappers, expiration and actual misses without contacting SQL", async t => {
    const directory = await temporary(t);
    const cache = createCacheStore({ directory, backend: () => "file", sql: noSql, now: () => at });
    assert.equal(await cache.read("missing", 1), null);
    await fs.writeFile(filename(directory, "legacy"), JSON.stringify({ savedAt: new Date(at - 30 * 60_000).toISOString(), data: { oldPaidAnswer: true } }));
    assert.deepEqual(await cache.read("legacy", 1), { oldPaidAnswer: true });
    assert.equal(await cache.read("legacy", 0.25), null);
    await cache.write("new", { currentAnswer: true });
    assert.deepEqual(JSON.parse(await fs.readFile(filename(directory, "new"), "utf8")), {
        key: "new", savedAt: new Date(at).toISOString(), data: { currentAnswer: true },
    });
});

test("corrupt or unreadable file cache evidence is preserved and cannot become a provider cache miss", async t => {
    const directory = await temporary(t);
    const cache = createCacheStore({ directory, backend: () => "file", sql: noSql, now: () => at });
    const damaged = ["{partial", "null", "[]", JSON.stringify({ savedAt: "bad-date", data: "paid" }),
        JSON.stringify({ key: "another-task", savedAt: new Date(at).toISOString(), data: "paid" }),
        JSON.stringify({ savedAt: new Date(at).toISOString() })];
    let providerCalls = 0;
    for (const [index, contents] of damaged.entries()) {
        const key = `damaged-${index}`;
        await fs.writeFile(filename(directory, key), contents);
        await assert.rejects(async () => {
            if (await cache.read(key, 1) === null) providerCalls++;
        }, StorageUnavailableError);
        assert.equal(await fs.readFile(filename(directory, key), "utf8"), contents);
    }
    await fs.mkdir(filename(directory, "unreadable"));
    await assert.rejects(cache.read("unreadable", 1), StorageUnavailableError);
    assert.equal(providerCalls, 0);
});

test("SQL cache reads use original timestamps and SQL writes never create a second file cache", async t => {
    const directory = await temporary(t);
    const old = { key: "task", savedAt: new Date(at - 2 * 3600_000).toISOString(), data: { answer: "unchanged" } };
    const writes: unknown[] = [];
    const cache = createCacheStore({ directory, backend: () => "azure-sql", now: () => at,
        sql: { readCacheEntry: async key => { assert.equal(key, "task"); return old; }, writeCacheEntry: async entry => { writes.push(entry); } } });
    assert.deepEqual(await cache.read("task", 24), old.data);
    assert.equal(await cache.read("task", 1), null, "importing an old answer must not reset its freshness");
    await cache.write("new-task", { answer: "new" });
    assert.deepEqual(writes, [{ key: "new-task", savedAt: new Date(at).toISOString(), data: { answer: "new" } }]);
    assert.deepEqual(await fs.readdir(directory), []);
});

test("SQL cache failures never fall back to matching local files or launch replacement work", async t => {
    const directory = await temporary(t);
    await fs.writeFile(filename(directory, "task"), JSON.stringify({ key: "task", savedAt: new Date(at).toISOString(), data: "local-copy" }));
    const failed = new StorageUnavailableError("offline SQL unavailable");
    const cache = createCacheStore({ directory, backend: () => "azure-sql", now: () => at,
        sql: { readCacheEntry: async () => { throw failed; }, writeCacheEntry: async () => { throw failed; } } });
    let providerCalls = 0;
    await assert.rejects(async () => { if (await cache.read("task", 24) === null) providerCalls++; }, error => error === failed);
    await assert.rejects(cache.write("task", "replacement"), error => error === failed);
    assert.equal(providerCalls, 0);
    assert.equal(JSON.parse(await fs.readFile(filename(directory, "task"), "utf8")).data, "local-copy");
});

function record(): SavedRecord {
    return { itemId: "v1|offline|0", version: "fixture-v1", photoFingerprint: photoFingerprint(["front", "back"]),
        reviewContext: { title: "Charizard fixture", photos: ["front", "back"] }, answeredAt: "2026-11-01T18:00:00Z",
        photoCheck: { result: {} as any, usage: { inputTokens: 100, outputTokens: 10 } }, assessment: null };
}

test("SQL assessment integration keeps owner scope, original paid evidence and version checks", async t => {
    const directory = await temporary(t), saved = record();
    const writes: unknown[] = [];
    const store = createAssessmentStore({ directory, backend: () => "azure-sql", ownerId: "user-a", sql: {
        readAssessmentRecord: async (itemId, ownerId) => { assert.equal(itemId, saved.itemId); assert.equal(ownerId, "user-a"); return saved; },
        writeAssessmentRecord: async (itemId, value, ownerId) => { writes.push({ itemId, value, ownerId }); },
    } });
    const loaded = await store.load(saved.itemId);
    assert.equal(loaded, saved);
    assert.equal(loaded?.answeredAt, "2026-11-01T18:00:00Z");
    assert.equal(reusableRecord(loaded, { version: saved.version, fingerprint: saved.photoFingerprint, title: saved.reviewContext!.title }), saved);
    assert.equal(reusableRecord(loaded, { version: "new-rules", fingerprint: saved.photoFingerprint, title: saved.reviewContext!.title }), null);
    assert.equal(reusableRecord(loaded, { version: saved.version, fingerprint: "different-photos", title: saved.reviewContext!.title }), null);
    assert.equal(reusableRecord(loaded, { version: saved.version, fingerprint: saved.photoFingerprint, title: "changed-title" }), null);
    await store.save(saved.itemId, saved);
    assert.deepEqual(writes, [{ itemId: saved.itemId, value: saved, ownerId: "user-a" }]);
    assert.deepEqual(await fs.readdir(directory), []);
});

test("SQL assessment failures do not use a local copy; file-only assessments still save and reuse", async t => {
    const directory = await temporary(t), saved = record();
    const fileStore = createAssessmentStore({ directory, backend: () => "file" });
    await fileStore.save(saved.itemId, saved);
    assert.deepEqual(await fileStore.load(saved.itemId), saved);
    const failed = new StorageUnavailableError("offline assessment SQL failure");
    const sqlStore = createAssessmentStore({ directory, backend: () => "azure-sql", sql: {
        readAssessmentRecord: async () => { throw failed; }, writeAssessmentRecord: async () => { throw failed; },
    } });
    await assert.rejects(sqlStore.load(saved.itemId), error => error === failed);
    await assert.rejects(sqlStore.save(saved.itemId, { ...saved, version: "replacement" }), error => error === failed);
    assert.deepEqual(await fileStore.load(saved.itemId), saved);
    assert.equal(await fileStore.load("missing"), null);
});

test("a syntactically valid but damaged paid-assessment file cannot masquerade as missing evidence", async t => {
    const directory = await temporary(t), store = createAssessmentStore({ directory, backend: () => "file" });
    for (const [index, contents] of ["null", "[]", "{}", JSON.stringify({ ...record(), itemId: "another-listing" })].entries()) {
        const itemId = `damaged${index}`, file = path.join(directory, `${itemId}.json`);
        await fs.writeFile(file, contents);
        await assert.rejects(store.load(itemId), StorageUnavailableError);
        assert.equal(await fs.readFile(file, "utf8"), contents);
    }
});

test("real price and eBay consumers send zero provider requests when selected SQL storage is unconfigured", async t => {
    const directory = await temporary(t);
    const script = `
        import assert from "node:assert/strict";
        let calls=0;
        globalThis.fetch=async()=>{calls++;throw new Error("No provider transport is allowed in this fixture");};
        const { lookupCards }=await import("./server/pricing/pkmnprices.ts");
        const { getListingDetails }=await import("./server/ebay/listings.ts");
        await assert.rejects(lookupCards({set:"Base Set",name:"Charizard",cardNumber:"4/102"}), error=>error.code==="STORAGE_UNAVAILABLE");
        await assert.rejects(getListingDetails("v1|offline|0"), error=>error.code==="STORAGE_UNAVAILABLE");
        assert.equal(calls,0);
        process.stdout.write("zero-provider-dispatch");
    `;
    const result = await run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: path.resolve(import.meta.dirname, "../.."), timeout: 15_000,
        env: { ...process.env, POKEMON_FLIPPER_DATA_DIR: directory, POKEMON_FLIPPER_STORAGE: "azure-sql",
            AZURE_SQL_SERVER: "", AZURE_SQL_DATABASE: "", PKMNPRICES_API_KEY: "offline", EBAY_CLIENT_ID: "offline", EBAY_CLIENT_SECRET: "offline" },
    });
    assert.equal(result.stdout, "zero-provider-dispatch");
});
