import type { SqlExecutor } from "./client.ts";

export const SCHEMA_VERSION = 1;
const schema = `
CREATE TABLE dbo.ProviderCache (
 cache_hash char(64) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY,
 cache_key nvarchar(max) COLLATE Latin1_General_100_BIN2 NOT NULL, owner_scope nvarchar(160) NOT NULL,
 source nvarchar(64) NOT NULL, saved_at datetime2(3) NOT NULL,
 payload_json nvarchar(max) NOT NULL CHECK (ISJSON(payload_json)=1)
);
CREATE INDEX IX_ProviderCache_saved ON dbo.ProviderCache(saved_at);
CREATE TABLE dbo.AssessmentEvidence (
 evidence_key char(64) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY,
 item_id nvarchar(120) COLLATE Latin1_General_100_BIN2 NOT NULL,
 version nvarchar(256) NOT NULL, photo_fingerprint varchar(128) NOT NULL,
 saved_at datetime2(3) NOT NULL, answered_at datetime2(3) NULL,
 record_json nvarchar(max) NOT NULL CHECK (ISJSON(record_json)=1)
);
CREATE INDEX IX_AssessmentEvidence_item ON dbo.AssessmentEvidence(item_id,saved_at);
CREATE TABLE dbo.AssessmentHeads (
 item_id nvarchar(120) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY,
 evidence_key char(64) COLLATE Latin1_General_100_BIN2 NOT NULL REFERENCES dbo.AssessmentEvidence(evidence_key),
 saved_at datetime2(3) NOT NULL
);
CREATE TABLE dbo.PrivateEvaluations (
 owner_id nvarchar(128) COLLATE Latin1_General_100_BIN2 NOT NULL,
 item_id nvarchar(120) COLLATE Latin1_General_100_BIN2 NOT NULL,
 evidence_key char(64) COLLATE Latin1_General_100_BIN2 NOT NULL,
 saved_at datetime2(3) NOT NULL,
 evaluation_json nvarchar(max) NOT NULL CHECK (ISJSON(evaluation_json)=1),
 CONSTRAINT PK_PrivateEvaluations PRIMARY KEY(owner_id,item_id)
);
CREATE TABLE dbo.ResearchTasks (
 task_hash char(64) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY,
 task_key nvarchar(max) COLLATE Latin1_General_100_BIN2 NOT NULL,
 task_type nvarchar(64) NOT NULL, input_hash char(64) NOT NULL,
 model nvarchar(128) NULL, prompt_version nvarchar(128) NULL,
 state varchar(16) NOT NULL CHECK(state IN ('RUNNING','PENDING','DISPATCHED','UNKNOWN','COMPLETED','CANCELLED','FAILED')),
 lease_owner nvarchar(128) NULL, lease_until datetime2(3) NULL,
 result_json nvarchar(max) NULL CHECK(result_json IS NULL OR ISJSON(result_json)=1),
 created_at datetime2(3) NOT NULL, updated_at datetime2(3) NOT NULL
);
CREATE INDEX IX_ResearchTasks_pending ON dbo.ResearchTasks(state,lease_until);
CREATE TABLE dbo.SearchBudgets (
 search_id uniqueidentifier NOT NULL PRIMARY KEY,
 owner_id nvarchar(128) NOT NULL,
 cap_nano_usd bigint NOT NULL CHECK(cap_nano_usd>=0 AND cap_nano_usd<=20000000),
 held_nano_usd bigint NOT NULL DEFAULT 0 CHECK(held_nano_usd>=0),
 paused bit NOT NULL DEFAULT 1, created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME()
);
CREATE TABLE dbo.ProviderAttempts (
 attempt_id uniqueidentifier NOT NULL PRIMARY KEY,
 search_id uniqueidentifier NOT NULL REFERENCES dbo.SearchBudgets(search_id),
 task_hash char(64) COLLATE Latin1_General_100_BIN2 NULL REFERENCES dbo.ResearchTasks(task_hash),
 provider nvarchar(32) NOT NULL, input_hash char(64) NOT NULL,
 state varchar(16) NOT NULL CHECK(state IN ('RESERVED','DISPATCHED','UNKNOWN','SETTLED')),
 reserved_nano_usd bigint NOT NULL CHECK(reserved_nano_usd>=0),
 held_nano_usd bigint NOT NULL CHECK(held_nano_usd>=0),
 provider_request_id nvarchar(256) NULL,
 created_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(), settled_at datetime2(3) NULL
);
CREATE TABLE dbo.ProviderQuotaWindows (
 provider_account_hash char(64) NOT NULL,
 reset_at datetime2(3) NOT NULL, limit_count int NOT NULL CHECK(limit_count>0),
 used_count int NOT NULL CHECK(used_count>=0),
 CONSTRAINT PK_ProviderQuotaWindows PRIMARY KEY(provider_account_hash,reset_at)
);
`;

export async function migrateSchema(executor: SqlExecutor): Promise<{ version: number; applied: number[] }> {
    return executor.transaction(async tx => {
        await tx.query(`DECLARE @lock int; EXEC @lock=sp_getapplock @Resource='pokemon-flipper-schema', @LockMode='Exclusive', @LockOwner='Transaction', @LockTimeout=15000; IF @lock<0 THROW 51000,'Schema migration is locked.',1;
IF OBJECT_ID('dbo.StorageMigrations','U') IS NULL CREATE TABLE dbo.StorageMigrations(version int NOT NULL PRIMARY KEY, applied_at datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME());`);
        const rows = await tx.query<{ version: number }>("SELECT COALESCE(MAX(version),0) AS version FROM dbo.StorageMigrations");
        const current = Number(rows[0]?.version ?? 0);
        if (current > SCHEMA_VERSION) throw new Error("Database schema is newer than this application.");
        if (current === SCHEMA_VERSION) return { version: current, applied: [] };
        await tx.query(schema);
        await tx.query("INSERT dbo.StorageMigrations(version) VALUES(@version)", { version: SCHEMA_VERSION });
        return { version: SCHEMA_VERSION, applied: [SCHEMA_VERSION] };
    });
}
