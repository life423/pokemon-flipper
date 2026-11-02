import { createHash } from "node:crypto";
import type { SavedRecord } from "../analysis/types.ts";
import type { SqlExecutor } from "./client.ts";
import { StorageUnavailableError, localOwner } from "./config.ts";
import { createTaskRepository } from "./tasks.ts";

export interface CacheEntry { key: string; savedAt: string; data: unknown }
export interface AssessmentEntry { itemId: string; record: SavedRecord; savedAt: string }
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
function assessmentRow(entry: AssessmentEntry) {
    const { itemId, record } = entry;
    if (!validId(itemId, 120) || !record || record.itemId !== itemId || !validId(record.version, 256) ||
        !validId(record.photoFingerprint, 128) || !Object.hasOwn(record, "photoCheck") || !Object.hasOwn(record, "assessment")) {
        throw new StorageUnavailableError("Saved assessment has an invalid identity or evidence version.");
    }
    const { latestEvaluation, ...shared } = record;
    const evidenceKey = storageHash(json([itemId, record.version, record.photoFingerprint, record.reviewContext?.title ?? null]));
    return { itemId, evidenceKey, version: record.version, fingerprint: record.photoFingerprint,
        savedAt: storageDate(entry.savedAt), answeredAt: record.answeredAt === null ? null : storageDate(record.answeredAt),
        payload: json(shared), evaluation: latestEvaluation ? json(latestEvaluation) : null };
}
function owner(value = localOwner()) {
    if (!validId(value, 128)) throw new StorageUnavailableError("A valid assessment owner is required.");
    return value;
}
function uniqueRows<T>(entries: T[], key: (entry: T) => string, timestamp: (entry: T) => string): T[] {
    if (entries.length > 500) throw new StorageUnavailableError("A storage import batch exceeds 500 entries.");
    const rows = new Map<string, T>();
    for (const entry of entries) { const id = key(entry), old = rows.get(id); if (!old || timestamp(entry) > timestamp(old)) rows.set(id, entry); }
    return [...rows.values()];
}
const cacheColumns = `cacheHash char(64), cacheKey nvarchar(max), ownerScope nvarchar(160), source nvarchar(64), savedAt datetime2(3), payload nvarchar(max)`;
const assessmentColumns = `itemId nvarchar(120), evidenceKey char(64), version nvarchar(256), fingerprint varchar(128), savedAt datetime2(3), answeredAt datetime2(3), payload nvarchar(max), evaluation nvarchar(max)`;

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
    async function importAssessmentRecords(entries: AssessmentEntry[], ownerId = localOwner(), replaceEqual = false): Promise<ImportResult> {
        const ownerIdValue = owner(ownerId);
        const rows = uniqueRows(entries.map(assessmentRow), row => row.itemId, row => row.savedAt);
        if (!rows.length) return { imported: 0, keptNewer: 0 };
        return executor.transaction(async tx => {
            const parameters = { rows: json(rows), owner: ownerIdValue, replaceEqual };
            await tx.query(`MERGE dbo.AssessmentEvidence WITH(HOLDLOCK) t USING OPENJSON(@rows) WITH(${assessmentColumns}) s ON t.evidence_key=s.evidenceKey
WHEN MATCHED AND (s.savedAt>t.saved_at OR (@replaceEqual=1 AND s.savedAt=t.saved_at)) THEN UPDATE SET record_json=s.payload,saved_at=s.savedAt,answered_at=s.answeredAt
WHEN NOT MATCHED THEN INSERT(evidence_key,item_id,version,photo_fingerprint,saved_at,answered_at,record_json) VALUES(s.evidenceKey,s.itemId,s.version,s.fingerprint,s.savedAt,s.answeredAt,s.payload);`, parameters);
            const actions = await tx.query<{ action: string }>(`MERGE dbo.AssessmentHeads WITH(HOLDLOCK) t USING OPENJSON(@rows) WITH(${assessmentColumns}) s ON t.item_id=s.itemId
WHEN MATCHED AND (s.savedAt>t.saved_at OR (@replaceEqual=1 AND s.savedAt=t.saved_at)) THEN UPDATE SET evidence_key=s.evidenceKey,saved_at=s.savedAt
WHEN NOT MATCHED THEN INSERT(item_id,evidence_key,saved_at) VALUES(s.itemId,s.evidenceKey,s.savedAt)
OUTPUT $action AS action;`, parameters);
            await tx.query(`MERGE dbo.PrivateEvaluations WITH(HOLDLOCK) t USING (
 SELECT s.* FROM OPENJSON(@rows) WITH(${assessmentColumns}) s JOIN dbo.AssessmentHeads h ON h.item_id=s.itemId AND h.evidence_key=s.evidenceKey AND h.saved_at<=s.savedAt WHERE s.evaluation IS NOT NULL
) s ON t.owner_id=@owner AND t.item_id=s.itemId
WHEN MATCHED AND (s.savedAt>t.saved_at OR (@replaceEqual=1 AND s.savedAt=t.saved_at)) THEN UPDATE SET evidence_key=s.evidenceKey,saved_at=s.savedAt,evaluation_json=s.evaluation
WHEN NOT MATCHED THEN INSERT(owner_id,item_id,evidence_key,saved_at,evaluation_json) VALUES(@owner,s.itemId,s.evidenceKey,s.savedAt,s.evaluation);`, parameters);
            // A new checkpoint that deliberately clears a personal valuation
            // cannot resurrect an older same-input recommendation on read.
            await tx.query(`DELETE t FROM dbo.PrivateEvaluations t JOIN OPENJSON(@rows) WITH(${assessmentColumns}) s ON t.owner_id=@owner AND t.item_id=s.itemId
JOIN dbo.AssessmentHeads h ON h.item_id=s.itemId AND h.evidence_key=s.evidenceKey AND h.saved_at<=s.savedAt
WHERE s.evaluation IS NULL AND t.saved_at<=s.savedAt;`, parameters);
            return { imported: actions.length, keptNewer: rows.length - actions.length };
        });
    }
    async function readAssessmentRecords(ids: string[], ownerId = localOwner()): Promise<AssessmentEntry[]> {
        if (!ids.length) return [];
        if (ids.length > 500 || ids.some(id => !validId(id, 120))) throw new StorageUnavailableError("Assessment lookup identifiers are invalid.");
        const rows = await executor.query<{ itemId: string; savedAt: Date | string; payload: string; evaluation: string | null }>(`
SELECT h.item_id AS itemId,h.saved_at AS savedAt,e.record_json AS payload,p.evaluation_json AS evaluation
FROM dbo.AssessmentHeads h JOIN dbo.AssessmentEvidence e ON e.evidence_key=h.evidence_key
JOIN OPENJSON(@ids) s ON h.item_id=s.value
LEFT JOIN dbo.PrivateEvaluations p ON p.owner_id=@owner AND p.item_id=h.item_id AND p.evidence_key=h.evidence_key;`, { ids: json([...new Set(ids)]), owner: owner(ownerId) });
        return rows.map(row => {
            const record = parse(row.payload) as SavedRecord;
            assessmentRow({ itemId: row.itemId, record, savedAt: storageDate(row.savedAt) });
            if (Object.hasOwn(record, "latestEvaluation")) throw new StorageUnavailableError("Personal financial advice was found in shared assessment evidence.");
            if (row.evaluation !== null) record.latestEvaluation = parse(row.evaluation);
            return { itemId: row.itemId, record, savedAt: storageDate(row.savedAt) };
        });
    }
    return {
        importCacheEntries, readCacheEntries, importAssessmentRecords, readAssessmentRecords,
        async readCacheEntry(key: string) { return (await readCacheEntries([key]))[0] ?? null; },
        async writeCacheEntry(entry: CacheEntry) { await importCacheEntries([entry], true); },
        async importCacheEntry(entry: CacheEntry) { return (await importCacheEntries([entry])).imported ? "imported" as const : "kept-newer" as const; },
        async readAssessmentRecord(itemId: string, ownerId?: string) { return (await readAssessmentRecords([itemId], ownerId))[0]?.record ?? null; },
        async writeAssessmentRecord(itemId: string, record: SavedRecord, ownerId?: string) { await importAssessmentRecords([{ itemId, record, savedAt: new Date().toISOString() }], ownerId, true); },
        async importAssessmentRecord(itemId: string, record: SavedRecord, options: { savedAt: string; ownerId?: string }) {
            return (await importAssessmentRecords([{ itemId, record, savedAt: options.savedAt }], options.ownerId)).imported ? "imported" as const : "kept-newer" as const;
        },
        ...createTaskRepository(executor),
    };
}
export type SqlRepositories = ReturnType<typeof createSqlRepositories>;
