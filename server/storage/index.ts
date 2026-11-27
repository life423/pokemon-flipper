import type { CacheEntry, SqlRepositories } from "./repositories.ts";
export { StorageUnavailableError, storageBackend, localOwner } from "./config.ts";
export { createSqlRepositories } from "./repositories.ts";
export type { SqlExecutor, SqlValue } from "./client.ts";

export async function getSqlRepositories(): Promise<SqlRepositories> {
    const { getSqlExecutor } = await import("./client.ts");
    const { createSqlRepositories } = await import("./repositories.ts");
    return createSqlRepositories(await getSqlExecutor());
}
export async function readCacheEntry(key: string) { return (await getSqlRepositories()).readCacheEntry(key); }
export async function readCacheEntries(keys: string[]) { return (await getSqlRepositories()).readCacheEntries(keys); }
export async function writeCacheEntry(entry: CacheEntry) { return (await getSqlRepositories()).writeCacheEntry(entry); }



export async function assertSqlStorageReady(): Promise<void> {
    const { storageBackend, StorageUnavailableError } = await import("./config.ts");
    if (storageBackend() === "file") return;
    const { getSqlExecutor } = await import("./client.ts");
    const { assertDocumentsReady } = await import("./documents.ts");
    await assertDocumentsReady();
    const SCHEMA_VERSION = 1;
    const [state] = await (await getSqlExecutor()).query<{ version: number; cache: number | null; tasks: number | null }>(
        "SELECT MAX(version) AS version, OBJECT_ID('dbo.ProviderCache','U') AS cache, OBJECT_ID('dbo.ResearchTasks','U') AS tasks FROM dbo.StorageMigrations");
    if (state?.version !== SCHEMA_VERSION || state.cache == null || state.tasks == null)
        throw new StorageUnavailableError("Azure SQL storage migrations must be applied before provider work can start.");
}
export async function closeDatabase() { const { closeDatabase } = await import("./client.ts"); await closeDatabase(); }

export type { SqlRepositories } from "./repositories.ts";
