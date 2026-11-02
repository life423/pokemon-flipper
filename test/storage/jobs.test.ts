import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskRepository } from "../../server/storage/tasks.ts";
import type { SqlExecutor, SqlValue } from "../../server/storage/client.ts";

function executor(run: (text: string, params: Record<string, SqlValue>) => unknown[]): SqlExecutor {
    const db: SqlExecutor = { query: async <T extends object>(text: string, params = {}) => run(text, params) as T[], transaction: run => run(db) };
    return db;
}
test("completed and uncertain dispatched jobs are returned without authorizing another provider call", async () => {
    for (const state of ["COMPLETED", "DISPATCHED", "UNKNOWN"] as const) {
        let statement = "";
        const jobs = createTaskRepository(executor(text => { statement = text; return [{ claimed: false, state, result: state === "COMPLETED" ? '{"result":{"saved":true}}' : null, leaseUntil: null }]; }));
        const result = await jobs.claimTask({ key: "photo:one", type: "photo", inputHash: "a".repeat(64), ownerId: "worker-2" });
        assert.equal(result.claimed, false); assert.equal(result.state, state);
        assert.deepEqual(result.result, state === "COMPLETED" ? { saved: true } : null);
        assert.match(statement, /state='PENDING' OR state='RUNNING' AND lease_until<=@now/);
        assert.ok(!statement.includes("state='DISPATCHED' AND lease_until"));
        assert.match(statement, /WITH\(UPDLOCK,HOLDLOCK\)/);
        assert.match(statement, /task_hash=CONVERT\(char\(64\),@hash\)/);
        assert.doesNotMatch(statement, /task_hash=@hash/);
    }
});

test("dispatch requires the active unpaid lease and stopping cannot requeue a paid task", async () => {
    const commands: string[] = [];
    const jobs = createTaskRepository(executor(text => { commands.push(text); return []; }));
    await assert.rejects(jobs.markTaskDispatched("photo:one", "lost-worker"), { code: "STORAGE_UNAVAILABLE" });
    assert.match(commands[0]!, /lease_until>SYSUTCDATETIME\(\)/);
    assert.match(commands[0]!, /task_hash=CONVERT\(char\(64\),@hash\)/);
    await jobs.releaseTask("photo:one", "worker-1");
    assert.match(commands[1]!, /state='RUNNING'/);
    assert.ok(!commands[1]!.includes("state='DISPATCHED'"));
});

test("accepted results save under their owner and corrupted completed results fail closed", async () => {
    let captured: Record<string, SqlValue> = {};
    const jobs = createTaskRepository(executor((_text, params) => { captured = params; return [{ state: "COMPLETED" }]; }));
    await jobs.completeTask("photo:one", "worker-1", { grade: 8 });
    assert.equal(captured.owner, "worker-1");
    assert.deepEqual(JSON.parse(String(captured.payload)), { result: { grade: 8 } });
    const corrupt = createTaskRepository(executor(() => [{ state: "COMPLETED", result: "{}", leaseUntil: null }]));
    await assert.rejects(corrupt.readTask("photo:one"), { code: "STORAGE_UNAVAILABLE" });
});
