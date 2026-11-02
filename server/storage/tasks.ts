import type { SqlExecutor } from "./client.ts";
import { StorageUnavailableError } from "./config.ts";
import { createHash } from "node:crypto";

export type TaskState = "RUNNING" | "PENDING" | "DISPATCHED" | "UNKNOWN" | "COMPLETED" | "CANCELLED" | "FAILED";
export interface TaskClaim {
    key: string; type: string; inputHash: string; ownerId: string;
    leaseMs?: number; model?: string; promptVersion?: string;
}
export interface TaskResult { state: TaskState; result: unknown | null; leaseUntil: string | null }
const hash = (key: string) => createHash("sha256").update(key).digest("hex");
// The shared client binds strings as nvarchar(max). Convert the parameter,
// not the indexed char(64) column, so task claims retain a narrow key lookup.
const keyParameters = (key: string, ownerId?: string) => {
    if (typeof key !== "string" || key.length < 1 || key.length > 32_000 || ownerId !== undefined && (!ownerId || ownerId.length > 128)) throw new StorageUnavailableError("Research task identity is invalid.");
    return { hash: hash(key), key, owner: ownerId ?? null };
};
function read(row: { state: TaskState; result: string | null; leaseUntil: Date | string | null }): TaskResult {
    const states: TaskState[] = ["RUNNING", "PENDING", "DISPATCHED", "UNKNOWN", "COMPLETED", "CANCELLED", "FAILED"];
    if (!states.includes(row.state)) throw new StorageUnavailableError("Saved research state is invalid.");
    let result: unknown = null;
    try { if (row.result !== null) {
        const saved = JSON.parse(row.result);
        if (!saved || !Object.hasOwn(saved, "result")) throw new Error("Missing saved task result");
        result = saved.result;
    } }
    catch (cause) { throw new StorageUnavailableError("Saved research result is corrupt; no new provider work was authorized.", { cause }); }
    const leaseUntil = row.leaseUntil === null ? null : new Date(row.leaseUntil);
    if (leaseUntil && !Number.isFinite(leaseUntil.getTime())) throw new StorageUnavailableError("Saved research lease is invalid.");
    return { state: row.state, result, leaseUntil: leaseUntil?.toISOString() ?? null };
}

export function createTaskRepository(executor: SqlExecutor) {
    return {
        async claimTask(claim: TaskClaim): Promise<TaskResult & { claimed: boolean }> {
            const parameters = keyParameters(claim.key, claim.ownerId);
            if (!/^[a-f0-9]{64}$/i.test(claim.inputHash) || !claim.type || claim.type.length > 64 ||
                claim.model && claim.model.length > 128 || claim.promptVersion && claim.promptVersion.length > 128) throw new StorageUnavailableError("Research input identity is invalid.");
            const leaseMs = claim.leaseMs ?? 120_000;
            if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 900_000) throw new StorageUnavailableError("Research claim lease is invalid.");
            return executor.transaction(async tx => {
                const rows = await tx.query<{ claimed: boolean; state: TaskState; result: string | null; leaseUntil: Date | string | null }>(`
DECLARE @now datetime2(3)=SYSUTCDATETIME(),@claimed bit=0;
IF EXISTS(SELECT 1 FROM dbo.ResearchTasks WITH(UPDLOCK,HOLDLOCK) WHERE task_hash=CONVERT(char(64),@hash) AND (task_key<>@key OR input_hash<>CONVERT(char(64),@inputHash) OR task_type<>@type)) THROW 51002,'Research task identity changed.',1;
IF NOT EXISTS(SELECT 1 FROM dbo.ResearchTasks WITH(UPDLOCK,HOLDLOCK) WHERE task_hash=CONVERT(char(64),@hash))
BEGIN
 INSERT dbo.ResearchTasks(task_hash,task_key,task_type,input_hash,model,prompt_version,state,lease_owner,lease_until,created_at,updated_at)
 VALUES(@hash,@key,@type,@inputHash,@model,@promptVersion,'RUNNING',@owner,DATEADD(millisecond,CONVERT(int,@leaseMs),@now),@now,@now);
 SET @claimed=1;
END
ELSE
BEGIN
 UPDATE dbo.ResearchTasks SET state='RUNNING',lease_owner=@owner,lease_until=DATEADD(millisecond,CONVERT(int,@leaseMs),@now),updated_at=@now
 WHERE task_hash=CONVERT(char(64),@hash) AND (state='PENDING' OR state='RUNNING' AND lease_until<=@now);
 IF @@ROWCOUNT=1 SET @claimed=1;
END
SELECT @claimed AS claimed,state,result_json AS result,lease_until AS leaseUntil FROM dbo.ResearchTasks WHERE task_hash=CONVERT(char(64),@hash);`,
                    { ...parameters, type: claim.type, inputHash: claim.inputHash, model: claim.model ?? null, promptVersion: claim.promptVersion ?? null, leaseMs });
                if (!rows[0]) throw new StorageUnavailableError("Research task claim could not be verified.");
                return { ...read(rows[0]), claimed: rows[0].claimed === true };
            });
        },
        async readTask(key: string): Promise<TaskResult | null> {
            const rows = await executor.query<{ state: TaskState; result: string | null; leaseUntil: Date | string | null }>(
                "SELECT state,result_json AS result,lease_until AS leaseUntil FROM dbo.ResearchTasks WHERE task_hash=CONVERT(char(64),@hash) AND task_key=@key", keyParameters(key));
            return rows[0] ? read(rows[0]) : null;
        },
        async markTaskDispatched(key: string, ownerId: string): Promise<void> {
            const rows = await executor.query<{ state: string }>(`UPDATE dbo.ResearchTasks SET state='DISPATCHED',updated_at=SYSUTCDATETIME()
OUTPUT inserted.state WHERE task_hash=CONVERT(char(64),@hash) AND task_key=@key AND lease_owner=@owner AND state='RUNNING' AND lease_until>SYSUTCDATETIME();`, keyParameters(key, ownerId));
            if (!rows.length) throw new StorageUnavailableError("The research claim is no longer owned; no provider dispatch is authorized.");
        },
        async completeTask(key: string, ownerId: string, result: unknown): Promise<void> {
            let payload: string;
            try { payload = JSON.stringify({ result }); if (result === undefined) throw new Error(); }
            catch (cause) { throw new StorageUnavailableError("Research result is not serializable.", { cause }); }
            const rows = await executor.query<{ state: string }>(`UPDATE dbo.ResearchTasks SET state='COMPLETED',result_json=@payload,updated_at=SYSUTCDATETIME()
OUTPUT inserted.state WHERE task_hash=CONVERT(char(64),@hash) AND task_key=@key AND lease_owner=@owner AND state IN ('RUNNING','DISPATCHED','UNKNOWN');`, { ...keyParameters(key, ownerId), payload });
            if (!rows.length) throw new StorageUnavailableError("The accepted research result could not be saved under its original claim.");
        },
        async markTaskUnknown(key: string, ownerId: string): Promise<void> {
            await executor.query(`UPDATE dbo.ResearchTasks SET state='UNKNOWN',updated_at=SYSUTCDATETIME() WHERE task_hash=CONVERT(char(64),@hash) AND task_key=@key AND lease_owner=@owner AND state='DISPATCHED';`, keyParameters(key, ownerId));
        },
        async releaseTask(key: string, ownerId: string): Promise<void> {
            // A dispatched or unknown attempt is never returned to the queue
            // by lease expiry or cancellation: doing so could buy it again.
            await executor.query(`UPDATE dbo.ResearchTasks SET state='PENDING',lease_owner=NULL,lease_until=NULL,updated_at=SYSUTCDATETIME() WHERE task_hash=CONVERT(char(64),@hash) AND task_key=@key AND lease_owner=@owner AND state='RUNNING';`, keyParameters(key, ownerId));
        },
    };
}
