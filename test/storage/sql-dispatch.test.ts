import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createSqlAiDispatch } from "../../server/ai/sql-dispatch.ts";
import { StorageUnavailableError, type TaskClaim, type TaskResult } from "../../server/storage/index.ts";

const body = { model: "offline-model", input: [{ text: "same exact evidence" }], max_output_tokens: 10 };
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};
async function temporary(t: { after(callback: () => unknown): void }) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-sql-dispatch-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}
function response(id = "offline-answer") {
    return Response.json({ status: "completed", id, output: [{ text: "saved paid evidence" }] }, {
        headers: { "x-request-id": "offline-request", "set-cookie": "private-provider-cookie", "authorization": "private-provider-header" },
    });
}
interface TaskRow extends TaskResult { owner: string; inputHash: string; type: string }
function memoryRepository() {
    const rows = new Map<string, TaskRow>();
    const calls = { claims: 0, reads: 0, dispatched: 0, completions: 0, unknown: 0, releases: 0 };
    const hooks: { beforeClaim?: () => Promise<void>; afterClaim?: () => void; beforeDispatched?: () => Promise<void>; completionFailures: number } = { completionFailures: 0 };
    function owned(key: string, owner: string) {
        const row = rows.get(key);
        assert.ok(row && row.owner === owner, "a task must retain its original lease owner");
        return row;
    }
    const snapshot = (row: TaskRow): TaskResult => ({ state: row.state, result: row.result, leaseUntil: row.leaseUntil });
    const repo = {
        async claimTask(claim: TaskClaim) {
            calls.claims++;
            await hooks.beforeClaim?.();
            let row = rows.get(claim.key), claimed = false;
            if (!row || row.state === "PENDING" || row.state === "RUNNING" && Date.parse(row.leaseUntil ?? "") <= Date.now()) {
                row = { owner: claim.ownerId, inputHash: claim.inputHash, type: claim.type, state: "RUNNING", result: null,
                    leaseUntil: new Date(Date.now() + (claim.leaseMs ?? 120_000)).toISOString() };
                rows.set(claim.key, row); claimed = true;
            }
            assert.equal(row.inputHash, claim.inputHash);
            hooks.afterClaim?.();
            return { ...snapshot(row), claimed };
        },
        async readTask(key: string) { calls.reads++; const row = rows.get(key); return row ? snapshot(row) : null; },
        async markTaskDispatched(key: string, owner: string) {
            await hooks.beforeDispatched?.();
            const row = owned(key, owner);
            assert.equal(row.state, "RUNNING");
            calls.dispatched++; row.state = "DISPATCHED";
        },
        async completeTask(key: string, owner: string, result: unknown) {
            calls.completions++;
            if (hooks.completionFailures-- > 0) throw new StorageUnavailableError("offline SQL completion failure");
            const row = owned(key, owner);
            assert.ok(["RUNNING", "DISPATCHED", "UNKNOWN"].includes(row.state));
            row.state = "COMPLETED"; row.result = structuredClone(result);
        },
        async markTaskUnknown(key: string, owner: string) {
            calls.unknown++;
            const row = owned(key, owner);
            if (row.state === "DISPATCHED") row.state = "UNKNOWN";
        },
        async releaseTask(key: string, owner: string) {
            calls.releases++;
            const row = owned(key, owner);
            if (row.state === "RUNNING") { row.state = "PENDING"; row.leaseUntil = null; }
        },
    };
    return { repo, rows, calls, hooks };
}
function options(state: ReturnType<typeof memoryRepository>, recoveryDirectory: string, scope = "owner-a") {
    return { enabled: () => true, repository: async () => state.repo, recoveryDirectory, scope: () => scope, pollMs: 1, waitMs: 3000 };
}

test("different backend dispatchers share one provider attempt and replay the saved completed response", async t => {
    const directory = await temporary(t), state = memoryRepository();
    const first = createSqlAiDispatch(options(state, path.join(directory, "worker-one")));
    const second = createSqlAiDispatch(options(state, path.join(directory, "worker-two")));
    const accepted = deferred(), finish = deferred(), secondClaim = deferred();
    let providerCalls = 0;
    state.hooks.afterClaim = () => { if (state.calls.claims === 2) secondClaim.resolve(); };
    const send = async (beforeSend: () => Promise<void>) => {
        await beforeSend(); providerCalls++; accepted.resolve(); await finish.promise; return response();
    };
    const a = first(body, send);
    await accepted.promise;
    const b = second(structuredClone(body), send);
    await secondClaim.promise;
    finish.resolve();
    const [original, reused] = await Promise.all([a, b]);
    assert.equal(providerCalls, 1);
    assert.equal(state.calls.dispatched, 1);
    assert.deepEqual(await original.json(), await reused.json());
    assert.equal(reused.headers.get("x-pokemon-flipper-reused"), "true");
    assert.equal(reused.headers.get("x-request-id"), "offline-request");
    assert.equal(reused.headers.get("authorization"), null);
    assert.equal(reused.headers.get("set-cookie"), null);
    assert.equal([...state.rows.values()][0].state, "COMPLETED");
});

test("SQL connection, claim and pre-dispatch failures authorize zero provider requests", async t => {
    const directory = await temporary(t);
    for (const failureAt of ["connection", "claim", "before-send"] as const) {
        const state = memoryRepository(), failed = new StorageUnavailableError(`offline ${failureAt}`);
        const repo = { ...state.repo,
            claimTask: failureAt === "claim" ? async () => { throw failed; } : state.repo.claimTask,
            markTaskDispatched: failureAt === "before-send" ? async () => { throw failed; } : state.repo.markTaskDispatched,
        };
        const dispatch = createSqlAiDispatch({ ...options(state, path.join(directory, failureAt)),
            repository: async () => { if (failureAt === "connection") throw failed; return repo; } });
        let providerCalls = 0;
        await assert.rejects(dispatch(body, async beforeSend => { await beforeSend(); providerCalls++; return response(); }), error => error === failed);
        assert.equal(providerCalls, 0);
        assert.equal(state.calls.dispatched, 0);
        if (failureAt === "before-send") {
            assert.equal(state.calls.releases, 1);
            assert.equal([...state.rows.values()][0].state, "PENDING");
        }
    }
});

test("an unknown paid outcome or an expired dispatched claim cannot buy another assessment", async t => {
    const directory = await temporary(t);
    for (const stateAfter of ["UNKNOWN", "DISPATCHED"] as const) {
        const state = memoryRepository(), dispatch = createSqlAiDispatch({ ...options(state, path.join(directory, stateAfter)), waitMs: 5 });
        let providerCalls = 0;
        const transportError = new Error("offline unknown transport outcome");
        await assert.rejects(dispatch(body, async beforeSend => { await beforeSend(); providerCalls++; throw transportError; }), error => error === transportError);
        const row = [...state.rows.values()][0];
        assert.equal(row.state, "UNKNOWN");
        row.state = stateAfter;
        row.leaseUntil = "2000-01-01T00:00:00Z";
        await assert.rejects(dispatch(body, async beforeSend => { await beforeSend(); providerCalls++; return response("must-not-run"); }), error => error.code === "AI_PAUSED");
        assert.equal(providerCalls, 1);
        assert.equal(state.calls.dispatched, 1);
        assert.equal(state.calls.releases, 0);
        assert.equal(row.state, stateAfter);
    }
});

test("Stop during an awaited claim releases only the unpaid running task", async t => {
    const directory = await temporary(t), state = memoryRepository(), entered = deferred(), finishClaim = deferred();
    state.hooks.beforeClaim = async () => { entered.resolve(); await finishClaim.promise; };
    const stopped = new AbortController(), dispatch = createSqlAiDispatch(options(state, directory));
    let providerCalls = 0;
    const operation = dispatch(body, async beforeSend => { await beforeSend(); providerCalls++; return response(); }, stopped.signal);
    const rejected = assert.rejects(operation, { name: "AbortError" });
    await entered.promise; stopped.abort(); finishClaim.resolve(); await rejected;
    assert.equal(providerCalls, 0);
    assert.equal(state.calls.dispatched, 0);
    assert.equal(state.calls.releases, 1);
    assert.equal(state.calls.unknown, 0);
    assert.equal([...state.rows.values()][0].state, "PENDING");
});

test("Stop before the native-send guard keeps an unpaid claim reusable, while Stop during dispatch marking retains uncertainty", async t => {
    const directory = await temporary(t);
    for (const stopAt of ["before-guard", "marking-dispatched"] as const) {
        const state = memoryRepository(), entered = deferred(), continueSend = deferred(), stopped = new AbortController();
        if (stopAt === "marking-dispatched") state.hooks.beforeDispatched = async () => { entered.resolve(); await continueSend.promise; };
        const dispatch = createSqlAiDispatch(options(state, path.join(directory, stopAt)));
        let providerCalls = 0;
        const operation = dispatch(body, async beforeSend => {
            if (stopAt === "before-guard") { entered.resolve(); await continueSend.promise; }
            await beforeSend(); providerCalls++; return response();
        }, stopped.signal);
        const rejected = assert.rejects(operation, { name: "AbortError" });
        await entered.promise; stopped.abort(); continueSend.resolve(); await rejected;
        assert.equal(providerCalls, 0);
        assert.equal([...state.rows.values()][0].state, stopAt === "before-guard" ? "PENDING" : "UNKNOWN");
        assert.equal(state.calls.releases, stopAt === "before-guard" ? 1 : 0);
    }
});

test("completed responses replay only for exact inputs; changed evidence requires a separate claim", async t => {
    const directory = await temporary(t), state = memoryRepository(), dispatch = createSqlAiDispatch(options(state, directory));
    let providerCalls = 0;
    const send = async (beforeSend: () => Promise<void>) => { await beforeSend(); providerCalls++; return response(`answer-${providerCalls}`); };
    assert.equal((await (await dispatch(body, send)).json()).id, "answer-1");
    assert.equal((await (await dispatch(structuredClone(body), send)).json()).id, "answer-1");
    const changed = { ...body, input: [{ text: "new listing photo evidence" }] };
    assert.equal((await (await dispatch(changed, send)).json()).id, "answer-2");
    assert.equal(providerCalls, 2);
    assert.equal(state.rows.size, 2);
    const completed = [...state.rows.values()][0];
    completed.result = { ...(completed.result as object), requestHash: "wrong-evidence" };
    await assert.rejects(dispatch(body, send), StorageUnavailableError);
    assert.equal(providerCalls, 2, "corrupt completed data is not permission for another paid attempt");
});

test("accepted responses survive SQL completion failure and reconcile from local recovery without a second send", async t => {
    const directory = await temporary(t), state = memoryRepository();
    state.hooks.completionFailures = 1;
    const warnings: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { warnings.push(args); });
    let providerCalls = 0;
    const send = async (beforeSend: () => Promise<void>) => { await beforeSend(); providerCalls++; return response("accepted-once"); };
    const dispatch = createSqlAiDispatch(options(state, directory));
    const accepted = await dispatch(body, send);
    assert.equal((await accepted.json()).id, "accepted-once");
    const recoveryFiles = await fs.readdir(directory);
    assert.equal(recoveryFiles.length, 1);
    assert.equal([...state.rows.values()][0].state, "DISPATCHED");
    const recoveryText = await fs.readFile(path.join(directory, recoveryFiles[0]), "utf8");
    assert.doesNotMatch(recoveryText, /private-provider/);
    assert.equal(warnings.length, 1);
    const restarted = createSqlAiDispatch(options(state, directory));
    const replayed = await restarted(body, send);
    assert.equal((await replayed.json()).id, "accepted-once");
    assert.equal(replayed.headers.get("x-pokemon-flipper-reused"), "true");
    assert.equal(providerCalls, 1);
    assert.equal(state.calls.completions, 2);
    assert.equal([...state.rows.values()][0].state, "COMPLETED");
    assert.deepEqual(await fs.readdir(directory), []);
});

test("an unavailable local recovery directory does not discard an accepted answer that SQL can save", async t => {
    const directory = await temporary(t), recoveryDirectory = path.join(directory, "recovery"), state = memoryRepository();
    const warnings: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { warnings.push(args); });
    const dispatch = createSqlAiDispatch(options(state, recoveryDirectory));
    let providerCalls = 0;
    const first = await dispatch(body, async beforeSend => {
        await beforeSend(); providerCalls++;
        // Recovery was absent when dispatch began; disk becomes unusable while
        // the accepted provider response is in flight, before its checkpoint.
        await fs.writeFile(recoveryDirectory, "offline disk obstacle");
        return response("saved-in-sql");
    });
    assert.equal((await first.json()).id, "saved-in-sql");
    assert.equal([...state.rows.values()][0].state, "COMPLETED");
    assert.equal(state.calls.completions, 1);
    assert.equal(warnings.length, 0);
    await fs.rm(recoveryDirectory);
    const replayed = await dispatch(body, async beforeSend => { await beforeSend(); providerCalls++; return response("must-not-run"); });
    assert.equal((await replayed.json()).id, "saved-in-sql");
    assert.equal(providerCalls, 1);
});

test("SQL and local checkpoint failures retain the dispatched claim instead of repurchasing its answer", async t => {
    const directory = await temporary(t), recoveryDirectory = path.join(directory, "recovery"), state = memoryRepository();
    state.hooks.completionFailures = 1;
    t.mock.method(console, "error", () => {});
    const dispatch = createSqlAiDispatch({ ...options(state, recoveryDirectory), waitMs: 5 });
    let providerCalls = 0;
    const accepted = await dispatch(body, async beforeSend => {
        await beforeSend(); providerCalls++;
        await fs.writeFile(recoveryDirectory, "offline disk obstacle");
        return response("returned-despite-checkpoint-failure");
    });
    assert.equal((await accepted.json()).id, "returned-despite-checkpoint-failure");
    assert.equal([...state.rows.values()][0].state, "DISPATCHED");
    await fs.rm(recoveryDirectory);
    await assert.rejects(dispatch(body, async beforeSend => { await beforeSend(); providerCalls++; return response(); }), error => error.code === "AI_PAUSED");
    assert.equal(providerCalls, 1);
    assert.equal(state.calls.releases, 0);
});

test("a contradictory or corrupt completed SQL answer cannot erase a valid local recovery checkpoint", async t => {
    const directory = await temporary(t);
    t.mock.method(console, "error", () => {});
    for (const damaged of ["contradictory", "corrupt"] as const) {
        const recoveryDirectory = path.join(directory, damaged), state = memoryRepository();
        state.hooks.completionFailures = 1;
        const dispatch = createSqlAiDispatch(options(state, recoveryDirectory));
        let providerCalls = 0;
        await dispatch(body, async beforeSend => { await beforeSend(); providerCalls++; return response("good-recovery"); });
        const files = await fs.readdir(recoveryDirectory);
        assert.equal(files.length, 1);
        const file = path.join(recoveryDirectory, files[0]), saved = await fs.readFile(file, "utf8");
        const row = [...state.rows.values()][0], recovered = JSON.parse(saved).response;
        row.state = "COMPLETED";
        row.result = damaged === "contradictory"
            ? { ...recovered, body: JSON.stringify({ status: "completed", id: "different-evidence" }) }
            : { ...recovered, body: "not-json" };
        await assert.rejects(dispatch(body, async beforeSend => { await beforeSend(); providerCalls++; return response("must-not-run"); }), StorageUnavailableError);
        assert.equal(providerCalls, 1);
        assert.equal(state.calls.completions, 1);
        assert.equal(await fs.readFile(file, "utf8"), saved);
    }
});

test("private owner scopes cannot reuse each other's transport response even with identical request bodies", async t => {
    const directory = await temporary(t), state = memoryRepository();
    const a = createSqlAiDispatch(options(state, path.join(directory, "a"), "owner-a"));
    const b = createSqlAiDispatch(options(state, path.join(directory, "b"), "owner-b"));
    let providerCalls = 0;
    const sendFor = (id: string) => async (beforeSend: () => Promise<void>) => { await beforeSend(); providerCalls++; return response(id); };
    assert.equal((await (await a(body, sendFor("private-a"))).json()).id, "private-a");
    assert.equal((await (await b(body, sendFor("private-b"))).json()).id, "private-b");
    assert.equal((await (await a(body, sendFor("must-not-run"))).json()).id, "private-a");
    assert.equal(providerCalls, 2);
    assert.equal(state.rows.size, 2);
});

test("corrupt accepted-response recovery files are retained and never authorize reassessment", async t => {
    const directory = await temporary(t);
    for (const [index, damaged] of ["{partial", "null", "{}", "[]"].entries()) {
        const scope = `owner-${index}`, recoveryDirectory = path.join(directory, scope), state = memoryRepository();
        await fs.mkdir(recoveryDirectory);
        const hash = createHash("sha256").update(JSON.stringify([scope, body])).digest("hex"), file = path.join(recoveryDirectory, `${hash}.json`);
        await fs.writeFile(file, damaged);
        const dispatch = createSqlAiDispatch(options(state, recoveryDirectory, scope));
        let providerCalls = 0;
        await assert.rejects(dispatch(body, async beforeSend => { await beforeSend(); providerCalls++; return response(); }), StorageUnavailableError);
        assert.equal(providerCalls, 0);
        assert.equal(state.calls.claims, 0);
        assert.equal(await fs.readFile(file, "utf8"), damaged);
    }
});
