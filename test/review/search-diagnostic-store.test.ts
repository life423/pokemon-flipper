import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSearchDiagnosticStore, SearchDiagnosticInputError } from "../../server/analysis/search-diagnostic-store.ts";

const first = "v1|123456789012|0";
const second = "v1|123456789013|0";
const discovery = { total: 12, found: 6, screened: 4, skipped: 1, deferred: 1, retainedIds: [first, second] };
const rows = [
    { id: first, outcome: "DEAL", reason: "DEAL_CONFIRMED", photoChecked: true, priced: true, profit: 4.5, title: "Seller prose" },
    { id: second, outcome: "SKIPPED", reason: "SOLD_EVIDENCE_MISSING", photoChecked: false },
];

test("diagnostics freeze one snapshot per completed search across store instances", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "search-diagnostic-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const config = { directory };
    const store = createSearchDiagnosticStore<{ attempts: number }>(config);
    const sameStore = createSearchDiagnosticStore<{ attempts: number }>(config);
    const id = randomUUID();

    assert.equal(await store.saveSnapshot(id, rows, { attempts: 0 }), null);
    await store.saveDiscovery(id, discovery);
    for (const invalid of [[rows[0]], [rows[0], rows[0]], [rows[0], { ...rows[1], id: "other" }],
        [rows[0], { ...rows[1], reason: "untrusted text" }], [{ ...rows[0], profit: Infinity }, rows[1]]]) {
        await assert.rejects(store.saveSnapshot(id, invalid, { attempts: 0 }), SearchDiagnosticInputError);
    }
    const [a, b] = await Promise.all([
        store.saveSnapshot(id, [...rows].reverse(), { attempts: 1 }),
        sameStore.saveSnapshot(id, rows, { attempts: 2 }),
    ]);
    assert.deepEqual(a, b);
    assert.deepEqual(a?.rows.map(row => row.id), [first, second]);
    assert.deepEqual(await sameStore.loadSnapshot(id), a);
    assert.ok(!(await fs.readFile(path.join(directory, "index.json"), "utf8")).includes("Seller prose"));

    const result = { searchId: id, savedAt: a!.savedAt, status: "skipped" as const };
    await store.saveResult(id, result);
    assert.deepEqual(await sameStore.saveResult(id, { ...result, status: "unavailable" }), result);
    assert.deepEqual(await sameStore.loadResult(id), result);

    const racingId = randomUUID();
    await store.saveDiscovery(racingId, discovery);
    const racing = await store.saveSnapshot(racingId, rows, { attempts: 0 });
    const failed = { searchId: racingId, savedAt: racing!.savedAt, status: "unavailable" as const };
    const complete = { ...failed, status: "complete" as const, review: { summary: "Saved result", proposedTasks: [] } };
    await store.saveResult(racingId, failed);
    assert.deepEqual(await sameStore.saveResult(racingId, complete), complete);
    assert.deepEqual(await store.saveResult(racingId, failed), complete, "a concurrent transient failure cannot hide a completed review");
});

test("diagnostic retention expires discovery, its decisions, and the review together", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "search-diagnostic-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let now = Date.UTC(2026, 10, 9);
    const store = createSearchDiagnosticStore({ directory, now: () => now, maxAgeMs: 20, maxSearches: 1 });
    const oldId = randomUUID();
    await store.saveDiscovery(oldId, discovery);
    const snapshot = await store.saveSnapshot(oldId, rows, {});
    await store.saveResult(oldId, { searchId: oldId, savedAt: snapshot!.savedAt, status: "skipped" });

    const newId = randomUUID();
    await store.saveDiscovery(newId, discovery);
    assert.equal(await store.loadDiscovery(oldId), null);
    assert.equal(await store.loadSnapshot(oldId), null);
    assert.equal(await store.loadResult(oldId), null);
    assert.ok(await store.loadDiscovery(newId));

    now += 20;
    assert.equal(await store.loadDiscovery(newId), null);
    assert.equal(await store.saveSnapshot(newId, rows, {}), null);
});
