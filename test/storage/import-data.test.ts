import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SavedRecord } from "../../server/analysis/types.ts";
import { inspectLegacyData, prepareSnapshot, readSnapshotEntry, summarizeImport } from "../../server/storage-import/source.ts";
import { importSnapshot, verifySnapshot } from "../../server/storage-import/migrate.ts";
import type { ImportTarget, LegacyAssessmentEntry, LegacyCacheEntry } from "../../server/storage-import/types.ts";
import { databaseArguments, runDatabaseCommand } from "../../scripts/database.ts";

const at = "2026-11-01T12:00:00.000Z";
const record = (itemId = "v1|123456789012|0") => ({ itemId, version: "preserved-v1", photoFingerprint: "unchanged-photos",
    answeredAt: at, photoCheck: { result: { confidence: "MEDIUM" }, usage: { inputTokens: 200, outputTokens: 100 } }, assessment: null,
    reviewContext: { title: "Original seller title", photos: ["https://photo.invalid/original"] },
    latestEvaluation: { evidenceKey: "private", evaluation: { privateCeiling: 123 } } }) as unknown as SavedRecord;

async function fixture(t: { after: (run: () => Promise<unknown>) => void }, count = 1, includeAssessment = true) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-import-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, "price-cache")); await fs.mkdir(path.join(root, "evaluations"));
    const keys: string[] = [];
    for (let n = 0; n < count; n++) {
        const key = `fixture:${n}`, name = `${createHash("sha1").update(key).digest("hex")}.json`;
        keys.push(key);
        await fs.writeFile(path.join(root, "price-cache", name), JSON.stringify({ key, savedAt: at, data: { original: n } }));
    }
    if (includeAssessment) {
        const saved = record(), file = path.join(root, "evaluations", `${saved.itemId.replace(/[^A-Za-z0-9]/g, "_")}.json`);
        await fs.writeFile(file, JSON.stringify(saved)); await fs.utimes(file, new Date(at), new Date(at));
    }
    return { root, keys };
}

function target(): ImportTarget & { cache: Map<string, LegacyCacheEntry>; assessments: Map<string, LegacyAssessmentEntry>; cacheCalls: number; failOn: number } {
    const value = {
        cache: new Map<string, LegacyCacheEntry>(), assessments: new Map<string, LegacyAssessmentEntry>(), cacheCalls: 0, failOn: 0,
        async importCacheEntries(entries: LegacyCacheEntry[]) {
            value.cacheCalls++;
            if (value.cacheCalls === value.failOn) throw new Error("Offline database unavailable");
            let imported = 0, keptNewer = 0;
            for (const entry of entries) {
                if (Date.parse(value.cache.get(entry.key)?.savedAt ?? "") >= Date.parse(entry.savedAt)) { keptNewer++; continue; }
                value.cache.set(entry.key, structuredClone(entry)); imported++;
            }
            return { imported, keptNewer };
        },
        async importAssessmentRecords(entries: LegacyAssessmentEntry[], ownerId = "local-owner") {
            let imported = 0, keptNewer = 0;
            for (const entry of entries) {
                const id = `${ownerId}:${entry.itemId}`;
                if (Date.parse(value.assessments.get(id)?.savedAt ?? "") >= Date.parse(entry.savedAt)) { keptNewer++; continue; }
                value.assessments.set(id, structuredClone(entry)); imported++;
            }
            return { imported, keptNewer };
        },
        async readCacheEntries(keys: string[]) { return keys.flatMap(key => value.cache.has(key) ? [structuredClone(value.cache.get(key)!)] : []); },
        async readAssessmentRecords(ids: string[], ownerId = "local-owner") { return ids.flatMap(id => value.assessments.has(`${ownerId}:${id}`) ? [structuredClone(value.assessments.get(`${ownerId}:${id}`)!)] : []); },
    };
    return value;
}

test("dry-run validates source data without loading SQL or contacting any provider", async t => {
    const { root } = await fixture(t);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("No network in dry-run"); });
    const before = await inspectLegacyData(root);
    const result = await runDatabaseCommand(["import", "--dry-run", "--data-dir", root]) as any;
    assert.equal(result.cacheEntries, 1); assert.equal(result.assessments, 1); assert.equal(result.manifestId, before.id);
    assert.equal(calls, 0);
    await assert.rejects(fs.stat(path.join(root, "database-migration")), { code: "ENOENT" });
    assert.equal((await inspectLegacyData(root)).id, before.id);
});

test("snapshot import preserves original evidence, private owner and timestamps and verifies all records", async t => {
    const { root } = await fixture(t, 3);
    const manifest = await inspectLegacyData(root, "owner-one"), snapshot = await prepareSnapshot(manifest), db = target();
    const source = await fs.readFile(path.join(root, manifest.files[0]!.path));
    const result = await importSnapshot(snapshot, db, "server/database");
    assert.equal(result.complete, true); assert.equal(result.processed, 4); assert.equal(result.imported, 4);
    assert.equal(result.verification.matched, 4); assert.equal(db.assessments.size, 1);
    assert.deepEqual([...db.assessments.values()][0]!.record, record());
    assert.ok(db.assessments.has(`owner-one:${record().itemId}`));
    assert.equal([...db.assessments.values()][0]!.savedAt, at);
    assert.equal([...db.cache.values()][0]!.savedAt, at);
    assert.deepEqual(await fs.readFile(path.join(root, manifest.files[0]!.path)), source);
    assert.equal((await inspectLegacyData(root, "owner-one")).id, manifest.id);
    const again = await importSnapshot(snapshot, db, "server/database");
    assert.equal(again.resumed, 4); assert.equal(db.cacheCalls, 1, "completed verified rows are not rewritten");
});

test("a completed backup remains usable after original files change", async t => {
    const { root } = await fixture(t, 1, false), manifest = await inspectLegacyData(root), snapshot = await prepareSnapshot(manifest);
    const original = await readSnapshotEntry(snapshot, manifest.files[0]!);
    await fs.writeFile(path.join(root, manifest.files[0]!.path), "changed after backup");
    const db = target();
    await importSnapshot(snapshot, db, "server/database");
    assert.deepEqual([...db.cache.values()][0], original);
});

test("interrupted batches resume only after readback of checkpointed records", async t => {
    const { root } = await fixture(t, 125, false), snapshot = await prepareSnapshot(await inspectLegacyData(root)), db = target();
    db.failOn = 2;
    await assert.rejects(importSnapshot(snapshot, db, "server/database"), /database unavailable/);
    const checkpoint = JSON.parse(await fs.readFile(path.join(snapshot, "checkpoint.json"), "utf8"));
    assert.equal(checkpoint.processed, 100); assert.equal(checkpoint.complete, false); assert.equal(db.cache.size, 100);
    db.failOn = 0;
    const result = await importSnapshot(snapshot, db, "server/database");
    assert.equal(result.resumed, 100); assert.equal(result.processed, 125); assert.equal(result.verification.matched, 125);
    assert.equal(db.cacheCalls, 3);
    db.cache.clear();
    const restored = await importSnapshot(snapshot, db, "server/database");
    assert.equal(restored.resumed, 0, "a stale local checkpoint cannot hide data missing after a SQL restore");
    assert.equal(db.cache.size, 125);
});

test("newer SQL evidence is retained, while equal-time mismatches fail verification", async t => {
    const { root, keys } = await fixture(t, 1, false), snapshot = await prepareSnapshot(await inspectLegacyData(root)), db = target();
    db.cache.set(keys[0]!, { key: keys[0]!, savedAt: "2026-11-02T12:00:00.000Z", data: { newer: true } });
    const kept = await importSnapshot(snapshot, db, "server/database");
    assert.equal(kept.keptNewer, 1); assert.equal(kept.verification.keptNewer, 1);
    assert.deepEqual(db.cache.get(keys[0]!)!.data, { newer: true });
    db.cache.set(keys[0]!, { key: keys[0]!, savedAt: at, data: { wrong: true } });
    assert.equal((await verifySnapshot(snapshot, db)).mismatched, 1);
    await assert.rejects(importSnapshot(snapshot, db, "server/database"), /readback failed/);
});

test("corrupt and misnamed sources fail before backup or SQL work", async t => {
    const { root } = await fixture(t, 1, false), manifest = await inspectLegacyData(root);
    await fs.writeFile(path.join(root, manifest.files[0]!.path), "{broken");
    await assert.rejects(inspectLegacyData(root), /valid JSON/);
    await assert.rejects(prepareSnapshot(manifest), /Source changed/);
    await fs.writeFile(path.join(root, manifest.files[0]!.path), JSON.stringify({ key: "different-key", savedAt: at, data: null }));
    await assert.rejects(inspectLegacyData(root), /original lookup key/);
    await assert.rejects(inspectLegacyData(path.join(root, "missing")), /does not exist/);
});

test("backup corruption and retained locks fail closed without losing originals", async t => {
    const { root } = await fixture(t, 1, false), manifest = await inspectLegacyData(root), snapshot = await prepareSnapshot(manifest), db = target();
    await fs.writeFile(path.join(snapshot, "import.lock"), "retained-owner");
    await assert.rejects(importSnapshot(snapshot, db, "server/database"), /No lock was stolen|no lock was stolen/);
    assert.equal(await fs.readFile(path.join(snapshot, "import.lock"), "utf8"), "retained-owner");
    await fs.unlink(path.join(snapshot, "import.lock"));
    await fs.writeFile(path.join(snapshot, "snapshot", manifest.files[0]!.path), JSON.stringify({ key: "altered", savedAt: at, data: null }));
    await assert.rejects(importSnapshot(snapshot, db, "server/database"), /checksum failed/);
    assert.equal(db.cacheCalls, 0);
    assert.equal((await inspectLegacyData(root)).id, manifest.id);
});

test("command validation rejects ambiguous flags and snapshot summary has no evidence payload", async t => {
    const { root } = await fixture(t);
    assert.throws(() => databaseArguments(["status", "--dry-run"]), /import only/);
    assert.throws(() => databaseArguments(["import", "--data-dir"]), /missing value/);
    assert.throws(() => databaseArguments(["unknown"]), /Usage/);
    const manifest = await inspectLegacyData(root);
    const summary = summarizeImport(manifest);
    assert.deepEqual(Object.keys(summary).sort(), ["assessments", "bytes", "cacheEntries"]);
    assert.ok(summary.bytes > 0);
    assert.throws(() => databaseArguments(["migrate", "--snapshot", root]), /import and verify/);
});
