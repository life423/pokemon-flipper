import { test } from "node:test";
import assert from "node:assert/strict";
import { createSqlRepositories, cacheScope } from "../../server/storage/repositories.ts";
import { StorageUnavailableError, storageBackend, sqlSettings } from "../../server/storage/config.ts";
import type { SqlExecutor, SqlValue } from "../../server/storage/client.ts";
import type { SavedRecord } from "../../server/analysis/types.ts";
import { migrateSchema } from "../../server/storage/schema.ts";

const date = "2026-11-02T18:00:00.123Z";
function executor(run: (text: string, params: Record<string, SqlValue>) => unknown[] | Promise<unknown[]>): SqlExecutor {
    const result: SqlExecutor = { query: async <T extends object>(text: string, params = {}) => await run(text, params) as T[], transaction: run => run(result) };
    return result;
}
const record = (): SavedRecord => ({ itemId: "listing-1", version: "photo-v1", photoFingerprint: "fingerprint", answeredAt: date,
    reviewContext: { title: "Charizard Base Set", photos: ["https://photo.invalid/front"] }, photoCheck: null, assessment: null });

test("SQL cache preserves scalar answers and source timestamps, with confirmed misses separate from failures", async () => {
    const rows: unknown[][] = [[{ cacheKey: "pkmnprices:example", requestedKey: "pkmnprices:example", savedAt: new Date(date), payload: '{"data":false}' }], [], []];
    const sql = createSqlRepositories(executor(() => rows.shift()!));
    assert.deepEqual(await sql.readCacheEntry("pkmnprices:example"), { key: "pkmnprices:example", savedAt: date, data: false });
    assert.equal(await sql.readCacheEntry("missing"), null);
    const failure = new StorageUnavailableError("Offline database outage");
    const unavailable = createSqlRepositories(executor(() => { throw failure; }));
    await assert.rejects(unavailable.readCacheEntry("missing"), error => error === failure);
});

test("corrupt SQL cache/assessment evidence does not become a miss", async () => {
    for (const payload of ["invalid", "null", "{}"] ) {
        const sql = createSqlRepositories(executor(() => [{ cacheKey: "pkmnprices:bad", requestedKey: "pkmnprices:bad", savedAt: date, payload }]));
        await assert.rejects(sql.readCacheEntry("pkmnprices:bad"), { code: "STORAGE_UNAVAILABLE" });
    }
    const sql = createSqlRepositories(executor(() => [{ itemId: "listing-1", savedAt: date, payload: '{"itemId":"other"}', evaluation: null }]));
    await assert.rejects(sql.readAssessmentRecord("listing-1"), { code: "STORAGE_UNAVAILABLE" });
    const mismatched = createSqlRepositories(executor(() => [{ cacheKey: "wrong", requestedKey: "pkmnprices:bad", savedAt: date, payload: '{"data":1}' }]));
    await assert.rejects(mismatched.readCacheEntry("pkmnprices:bad"), { code: "STORAGE_UNAVAILABLE" });
});

test("cache queries keep exact keys parameterized and private scopes distinct", async () => {
    assert.equal(cacheScope("pkmnprices:/cards", "alice"), "public");
    assert.equal(cacheScope("search-intent:charizard", "alice"), "owner:alice");
    assert.equal(cacheScope("ebay:item:1:ship-to:90210", "alice"), "owner:alice");
    assert.equal(cacheScope("shadowless-check:v1:model:photos", "alice"), "public");
    assert.equal(cacheScope("sold-condition:v1:model:target:photos", "bob"), "public");
    assert.equal(cacheScope("sold-condition-access:item:target", "alice"), "owner:alice");
    assert.equal(cacheScope("active-comps:v5:model::ship-to:90210:target", "alice"), "owner:alice");
    assert.equal(cacheScope("unknown:key", "bob"), "owner:bob");
    const captures: { text: string; params: Record<string, SqlValue> }[] = [];
    const sql = createSqlRepositories(executor((text, params) => { captures.push({ text, params }); return []; }));
    const key = "pkmnprices:');DROP TABLE x;--";
    await sql.readCacheEntry(key);
    assert.ok(!captures[0]!.text.includes(key));
    assert.equal(JSON.parse(String(captures[0]!.params.keys))[0].key, key);
});

test("batch cache import sends one timestamp-preserving parameter and skips repeated or older rows", async () => {
    const captures: { text: string; params: Record<string, SqlValue> }[] = [];
    const sql = createSqlRepositories(executor((text, params) => { captures.push({ text, params }); return [{ action: "INSERT" }]; }));
    const result = await sql.importCacheEntries([{ key: "pkmnprices:a", savedAt: date, data: 1 }, { key: "pkmnprices:b", savedAt: date, data: 2 }]);
    assert.deepEqual(result, { imported: 1, keptNewer: 1 });
    assert.equal(captures.length, 1);
    const rows = JSON.parse(String(captures[0]!.params.rows));
    assert.equal(rows[0].savedAt, date);
    assert.deepEqual(JSON.parse(rows[0].payload), { data: 1 });
    assert.match(captures[0]!.text, /s\.savedAt>t\.saved_at/);
    assert.equal(captures[0]!.params.replaceEqual, false);
    await assert.rejects(sql.importCacheEntries([{ key: "bad", savedAt: "invalid", data: 1 }]), { code: "STORAGE_UNAVAILABLE" });
});

test("personal valuation is excluded from shared assessment JSON and reads require the requested owner", async () => {
    const personal = { evidenceKey: "personal-targets", evaluation: { ownerOnly: true } } as unknown as NonNullable<SavedRecord["latestEvaluation"]>;
    const input = { ...record(), latestEvaluation: personal };
    const captures: Record<string, SqlValue>[] = [];
    const sql = createSqlRepositories(executor((_text, params) => { captures.push(params); return []; }));
    await sql.importAssessmentRecord(input.itemId, input, { savedAt: date, ownerId: "alice" });
    const rows = JSON.parse(String(captures[0]!.rows));
    assert.equal(JSON.parse(rows[0].payload).latestEvaluation, undefined);
    assert.deepEqual(JSON.parse(rows[0].evaluation), personal);
    assert.ok(captures.every(params => params.owner === "alice"));
    const reading = createSqlRepositories(executor((_text, params) => [{ itemId: input.itemId, savedAt: date, payload: rows[0].payload, evaluation: params.owner === "alice" ? rows[0].evaluation : null }]));
    assert.deepEqual((await reading.readAssessmentRecord(input.itemId, "alice"))!.latestEvaluation, personal);
    assert.equal((await reading.readAssessmentRecord(input.itemId, "bob"))!.latestEvaluation, undefined);
});

test("migrations run under a transaction-owned application lock and are idempotent", async () => {
    let version = 0, transactions = 0;
    const statements: string[] = [];
    const tx = executor((text, params) => {
        statements.push(text);
        if (text.startsWith("SELECT COALESCE")) return [{ version }];
        if (text.startsWith("INSERT dbo.StorageMigrations")) version = Number(params.version);
        return [];
    });
    const db: SqlExecutor = { ...tx, transaction: async run => { transactions++; return run(tx); } };
    assert.deepEqual(await migrateSchema(db), { version: 1, applied: [1] });
    assert.deepEqual(await migrateSchema(db), { version: 1, applied: [] });
    assert.equal(transactions, 2);
    assert.equal(statements.filter(text => text.includes("CREATE TABLE dbo.ProviderCache")).length, 1);
    assert.ok(statements[0]!.includes("@LockOwner='Transaction'"));
});

test("configuration is explicit and invalid SQL settings fail before credentials or networking", () => {
    const previous = { backend: process.env.POKEMON_FLIPPER_STORAGE, server: process.env.AZURE_SQL_SERVER, database: process.env.AZURE_SQL_DATABASE };
    try {
        delete process.env.POKEMON_FLIPPER_STORAGE; assert.equal(storageBackend(), "file");
        process.env.POKEMON_FLIPPER_STORAGE = "typo"; assert.throws(storageBackend, { code: "STORAGE_UNAVAILABLE" });
        process.env.AZURE_SQL_SERVER = ""; process.env.AZURE_SQL_DATABASE = "";
        assert.throws(sqlSettings, { code: "STORAGE_UNAVAILABLE" });
    } finally {
        for (const [name, value] of [["POKEMON_FLIPPER_STORAGE", previous.backend], ["AZURE_SQL_SERVER", previous.server], ["AZURE_SQL_DATABASE", previous.database]]) {
            if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
        }
    }
});
