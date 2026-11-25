import { test } from "node:test";
import assert from "node:assert/strict";
import { createHuntProgressStore } from "../../server/analysis/deal-hunt-progress.ts";

test("hunt progress reports observed work only under the owning search and expires after completion", async () => {
    let now = Date.parse("2026-11-25T19:03:00.000Z");
    const progress = createHuntProgressStore(() => now);
    const result = await progress.observe("root", "child", new AbortController().signal, async observer => {
        assert.equal(progress.read("root"), undefined);
        assert.equal(progress.read("other-root", "child"), undefined);
        assert.equal(progress.read(undefined, "child"), undefined);
        assert.equal(progress.read("root", "child")?.phase, "planning");
        assert.equal(progress.read("root", "child")?.reviewed, 0);
        const startedAt = new Date(now).toISOString();
        now += 3000;
        observer.stage("discovering", "Base\nSet", "find_listings");
        observer.source(42, 0);
        assert.deepEqual(progress.read("root", "child"), { searchId: "child", phase: "discovering", startedAt,
            updatedAt: new Date(now).toISOString(), cohort: "Base Set", action: "find_listings", discovered: 42,
            screened: 0, retained: 0, reviewed: 0, photos: 0, scans: 0 });
        observer.stage("pricing", "Base Set", "find_listings");
        observer.source(12, 20, 1);
        observer.retain(5);
        observer.stage("reviewing", "Real listing", "inspect_photos");
        observer.checked("copy-1", "inspect_photos");
        observer.checked("copy-1", "inspect_photos");
        observer.checked("copy-1", "check_sales");
        observer.checked("copy-2", "check_listing");
        assert.equal(progress.read("root", "child")?.reviewed, 2);
        assert.equal(progress.read("root", "child")?.photos, 1);
        const snapshot = progress.read("root", "child")!;
        snapshot.retained = 50;
        assert.equal(progress.read("root", "child")?.retained, 5);
        return "result is unchanged";
    });
    assert.equal(result, "result is unchanged");
    assert.equal(progress.read("root", "child")?.phase, "completed");
    assert.equal(progress.read("root", "child")?.completedAt, new Date(now).toISOString());
    assert.equal(progress.read("root", "child")?.action, undefined);
    now += 5 * 60_000 + 1;
    assert.equal(progress.read("root", "child"), undefined);
});

test("a stopped hunt cannot overwrite a subsequent attempt under the same search", async () => {
    let now = Date.now();
    const progress = createHuntProgressStore(() => now);
    const stop = new AbortController();
    const first = Promise.withResolvers<void>();
    const attempt = progress.observe("root", "root", stop.signal, async observer => {
        observer.stage("discovering", "Old cohort", "find_listings");
        await first.promise;
        observer.source(50, 50, 1);
        observer.checked("old-copy", "inspect_photos");
    });
    stop.abort();
    assert.equal(progress.read("root")?.phase, "stopped");
    now += 1000;
    const failure = new Error("Source failed");
    await assert.rejects(progress.observe("root", "root", new AbortController().signal, async observer => {
        observer.stage("reviewing", "New copy", "check_sales");
        observer.checked("new-copy", "check_sales");
        throw failure;
    }), failure);
    const current = progress.read("root")!;
    assert.equal(current.phase, "failed");
    assert.equal(current.discovered, 0);
    assert.equal(current.reviewed, 1);
    first.resolve();
    await attempt;
    assert.deepEqual(progress.read("root"), current);
});

test("unread progress stays bounded and inactive progress expires", async () => {
    let now = Date.now();
    const progress = createHuntProgressStore(() => now);
    const pending = Promise.withResolvers<void>();
    const active = new AbortController().signal;
    const run = progress.observe("root", "root", active, async observer => {
        observer.stage("pricing", "Slow market", "find_listings");
        await pending.promise;
    });
    now += 30 * 60_000 + 1;
    assert.equal(progress.read("root"), undefined);
    pending.resolve();
    await run;
    assert.equal(progress.read("root"), undefined);
    for (let i = 0; i < 129; i++) await progress.observe(`scope-${i}`, `scope-${i}`, active, async () => {});
    assert.equal(progress.read("scope-0"), undefined);
    assert.equal(progress.read("scope-1")?.phase, "completed");
    assert.equal(progress.read("scope-128")?.phase, "completed");
});
