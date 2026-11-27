import { createTaskRepository } from "./tasks.ts";
import { createHash } from "node:crypto";
import type { SqlExecutor } from "./client.ts";
import { StorageUnavailableError, localOwner } from "./config.ts";

export interface CacheEntry { key: string; savedAt: string; data: unknown }
export interface ImportResult { imported: number; keptNewer: number }
export const storageHash = (value: string) => createHash("sha256").update(value).digest("hex");
const validId = (value: string, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;
export function storageDate(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new StorageUnavailableError("Saved evidence has an invalid timestamp; no replacement analysis was started.");
    return date.toISOString();
}
function json(value: unknown): string {
    try { const result = JSON.stringify(value); if (typeof result === "string") return result; } catch {}
    throw new StorageUnavailableError("Saved evidence is not valid JSON.");
}
function parse(value: string): any {
    try { return JSON.parse(value); } catch (cause) { throw new StorageUnavailableError("Saved SQL evidence is corrupt; no replacement provider work was authorized.", { cause }); }
}
// Public observations are reusable. Search intent, destination-specific terms
// and unfamiliar namespaces stay owner-scoped until explicitly classified.
export function cacheScope(key: string, owner = localOwner()) {
    const publicKey = /^(pkmnprices:|pokemonpricetracker:|photo-find:|photo-match:|title-reading:|comp-check:|shadowless-check:|sold-condition:|active-comp-photo:|active-comps:|bounded-assessment:|ebay:item:)/.test(key);
    return publicKey && !key.includes(":ship-to:") ? "public" : `owner:${owner}`;
}
function cacheRow(entry: CacheEntry) {
    if (!validId(entry.key, 32_000) || entry.data === undefined) throw new StorageUnavailableError("Saved cache entry is invalid.");
    const ownerScope = cacheScope(entry.key);
    return { cacheHash: storageHash(json([ownerScope, entry.key])), cacheKey: entry.key, ownerScope,
        source: entry.key.split(":")[0]!.slice(0, 64), savedAt: storageDate(entry.savedAt), payload: json({ data: entry.data }) };
}
function uniqueRows<T>(entries: T[], key: (entry: T) => string, timestamp: (entry: T) => string): T[] {
    if (entries.length > 500) throw new StorageUnavailableError("A storage import batch exceeds 500 entries.");
    const rows = new Map<string, T>();
    for (const entry of entries) { const id = key(entry), old = rows.get(id); if (!old || timestamp(entry) > timestamp(old)) rows.set(id, entry); }
    return [...rows.values()];
}
const cacheColumns = `cacheHash char(64), cacheKey nvarchar(max), ownerScope nvarchar(160), source nvarchar(64), savedAt datetime2(3), payload nvarchar(max)`;

export function createSqlRepositories(executor: SqlExecutor) {
    async function importCacheEntries(entries: CacheEntry[], replaceEqual = false): Promise<ImportResult> {
        const rows = uniqueRows(entries.map(cacheRow), row => row.cacheHash, row => row.savedAt);
        if (!rows.length) return { imported: 0, keptNewer: 0 };
        return executor.transaction(async tx => {
            const actions = await tx.query<{ action: string }>(`
IF EXISTS(SELECT 1 FROM dbo.ProviderCache t JOIN OPENJSON(@rows) WITH(${cacheColumns}) s ON t.cache_hash=s.cacheHash WHERE t.cache_key<>s.cacheKey OR t.owner_scope<>s.ownerScope) THROW 51001,'Cache identity mismatch.',1;
MERGE dbo.ProviderCache WITH(HOLDLOCK) t USING OPENJSON(@rows) WITH(${cacheColumns}) s ON t.cache_hash=s.cacheHash
WHEN MATCHED AND (s.savedAt>t.saved_at OR (@replaceEqual=1 AND s.savedAt=t.saved_at)) THEN UPDATE SET cache_key=s.cacheKey,owner_scope=s.ownerScope,source=s.source,saved_at=s.savedAt,payload_json=s.payload
WHEN NOT MATCHED THEN INSERT(cache_hash,cache_key,owner_scope,source,saved_at,payload_json) VALUES(s.cacheHash,s.cacheKey,s.ownerScope,s.source,s.savedAt,s.payload)
OUTPUT $action AS action;`, { rows: json(rows), replaceEqual });
            return { imported: actions.length, keptNewer: rows.length - actions.length };
        });
    }
    async function readCacheEntries(keys: string[]): Promise<CacheEntry[]> {
        if (!keys.length) return [];
        const inputs = uniqueRows(keys.map(key => ({ key, hash: cacheRow({ key, savedAt: new Date().toISOString(), data: null }).cacheHash })), row => row.hash, () => "");
        const rows = await executor.query<{ cacheKey: string; requestedKey: string; savedAt: Date | string; payload: string }>(`
SELECT t.cache_key AS cacheKey,s.[key] AS requestedKey,t.saved_at AS savedAt,t.payload_json AS payload FROM dbo.ProviderCache t JOIN OPENJSON(@keys) WITH(hash char(64),[key] nvarchar(max)) s ON t.cache_hash=s.hash;`, { keys: json(inputs) });
        return rows.map(row => { if (row.cacheKey !== row.requestedKey) throw new StorageUnavailableError("Saved SQL cache identity is inconsistent; no replacement provider work was authorized.");
            const body = parse(row.payload); if (!body || !Object.hasOwn(body, "data")) throw new StorageUnavailableError("Saved SQL cache payload is invalid.");
            return { key: row.cacheKey, savedAt: storageDate(row.savedAt), data: body.data }; });
    }
    return {
        importCacheEntries, readCacheEntries,
        ...createTaskRepository(executor),
        async readCacheEntry(key: string) { return (await readCacheEntries([key]))[0] ?? null; },
        async writeCacheEntry(entry: CacheEntry) { await importCacheEntries([entry], true); },
    };
}
export type SqlRepositories = ReturnType<typeof createSqlRepositories>;
