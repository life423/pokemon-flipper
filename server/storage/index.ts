import type { SavedRecord } from "../analysis/types.ts";
import type { CacheEntry, SqlRepositories } from "./repositories.ts";
export { StorageUnavailableError, storageBackend, localOwner } from "./config.ts";
export { createSqlRepositories } from "./repositories.ts";
export type { CacheEntry, AssessmentEntry, ImportResult, SqlRepositories } from "./repositories.ts";
export type { SqlExecutor, SqlValue } from "./client.ts";
export type { TaskClaim, TaskResult, TaskState } from "./tasks.ts";

export async function getSqlRepositories(): Promise<SqlRepositories> {
    const { getSqlExecutor } = await import("./client.ts");
    const { createSqlRepositories } = await import("./repositories.ts");
    return createSqlRepositories(await getSqlExecutor());
}
export async function readCacheEntry(key: string) { return (await getSqlRepositories()).readCacheEntry(key); }
export async function writeCacheEntry(entry: CacheEntry) { return (await getSqlRepositories()).writeCacheEntry(entry); }
export async function readAssessmentRecord(itemId: string, ownerId?: string) { return (await getSqlRepositories()).readAssessmentRecord(itemId, ownerId); }
export async function writeAssessmentRecord(itemId: string, record: SavedRecord, ownerId?: string) { return (await getSqlRepositories()).writeAssessmentRecord(itemId, record, ownerId); }

export async function migrateDatabase() {
    const { getSqlExecutor } = await import("./client.ts");
    const { migrateSchema } = await import("./schema.ts");
    return migrateSchema(await getSqlExecutor());
}
export async function databaseStatus() {
    const { getSqlExecutor } = await import("./client.ts");
    const { sqlSettings } = await import("./config.ts");
    const rows = await (await getSqlExecutor()).query<{ version: number; cacheEntries: number; assessmentRecords: number }>(`
SELECT (SELECT COALESCE(MAX(version),0) FROM dbo.StorageMigrations) AS version,
(SELECT COUNT(*) FROM dbo.ProviderCache) AS cacheEntries,(SELECT COUNT(*) FROM dbo.AssessmentHeads) AS assessmentRecords;`);
    return { backend: "azure-sql" as const, ...sqlSettings(), ...rows[0]! };
}
export async function assertSqlStorageReady(): Promise<void> {
    const { storageBackend, StorageUnavailableError } = await import("./config.ts");
    if (storageBackend() === "file") return;
    const { getSqlExecutor } = await import("./client.ts");
    const { SCHEMA_VERSION } = await import("./schema.ts");
    const rows = await (await getSqlExecutor()).query<{ version: number }>("SELECT MAX(version) AS version FROM dbo.StorageMigrations");
    if (rows[0]?.version !== SCHEMA_VERSION) throw new StorageUnavailableError("Azure SQL storage migrations must be applied before provider work can start.");
}
export async function closeDatabase() { const { closeDatabase } = await import("./client.ts"); await closeDatabase(); }
