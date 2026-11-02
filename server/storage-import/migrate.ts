import fs from "node:fs/promises";
import path from "node:path";
import type { SavedRecord } from "../analysis/types.ts";
import { writeJsonAtomic } from "../lib/atomic-json.ts";
import { DataImportError, type ImportCheckpoint, type ImportManifest, type ImportTarget, type LegacyCacheEntry, type SourceFile, type VerifySummary } from "./types.ts";
import { loadSnapshot, readSnapshotEntry } from "./source.ts";

const CACHE_BATCH_SIZE = 100;
// Assessments contain large photo reports and private valuation snapshots.
// Keep their transactions small on Basic rather than raising the Azure tier.
const ASSESSMENT_BATCH_SIZE = 20;
const BATCH_BYTES = 4 * 1024 * 1024;
function* batches(files: readonly SourceFile[]) {
    let batch: SourceFile[] = [], bytes = 0;
    for (const file of files) {
        const limit = file.kind === "assessment" ? ASSESSMENT_BATCH_SIZE : CACHE_BATCH_SIZE;
        if (batch.length && (file.kind !== batch[0]!.kind || batch.length >= limit || bytes + file.bytes > BATCH_BYTES)) { yield batch; batch = []; bytes = 0; }
        batch.push(file); bytes += file.bytes;
    }
    if (batch.length) yield batch;
}

function stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
    return JSON.stringify(value);
}

async function verifyFiles(snapshot: string, manifest: ImportManifest, files: readonly SourceFile[], target: ImportTarget, signal?: AbortSignal): Promise<VerifySummary> {
    const result: VerifySummary = { matched: 0, keptNewer: 0, missing: 0, mismatched: 0 };
    for (const batch of batches(files)) {
        signal?.throwIfAborted();
        const saved = batch[0]!.kind === "cache"
            ? (await target.readCacheEntries(batch.map(file => file.id))).map(entry => ({ id: entry.key, savedAt: entry.savedAt, data: entry }))
            : (await target.readAssessmentRecords(batch.map(file => file.id), manifest.ownerId)).map(entry => ({ id: entry.itemId, savedAt: entry.savedAt, data: entry.record }));
        const byId = new Map(saved.map(entry => [entry.id, entry]));
        for (const file of batch) {
            const source = await readSnapshotEntry(snapshot, file), current = byId.get(file.id);
            if (!current) { result.missing++; continue; }
            const at = Date.parse(current.savedAt), before = Date.parse(file.savedAt);
            if (Number.isFinite(at) && at > before) { result.keptNewer++; continue; }
            if (at !== before || stable(current.data) !== stable(source)) { result.mismatched++; continue; }
            result.matched++;
        }
    }
    return result;
}

export async function verifySnapshot(snapshot: string, target: ImportTarget, signal?: AbortSignal): Promise<VerifySummary> {
    const manifest = await loadSnapshot(snapshot);
    return verifyFiles(snapshot, manifest, manifest.files, target, signal);
}

export async function importSnapshot(snapshot: string, target: ImportTarget, targetId: string, options: {
    signal?: AbortSignal;
    onProgress?: (checkpoint: ImportCheckpoint) => void;
} = {}): Promise<ImportCheckpoint & { verification: VerifySummary; resumed: number }> {
    if (!targetId.trim()) throw new DataImportError("A database identity is required for import checkpoints.");
    const manifest = await loadSnapshot(snapshot), lockPath = path.join(snapshot, "import.lock"), checkpointFile = path.join(snapshot, "checkpoint.json");
    let lock;
    try { lock = await fs.open(lockPath, "wx"); }
    catch (error) { throw new DataImportError("This snapshot already has an active or interrupted import lock. Inspect it before retrying; no lock was stolen.", { cause: error }); }
    try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, targetId, at: new Date().toISOString() }));
        let checkpoint: ImportCheckpoint = { version: 1, manifestId: manifest.id, targetId, processed: 0, imported: 0, keptNewer: 0, complete: false, updatedAt: new Date().toISOString() };
        let previous: ImportCheckpoint | null = null;
        try { previous = JSON.parse(await fs.readFile(checkpointFile, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new DataImportError("Import checkpoint cannot be read; it was preserved.", { cause: error }); }
        if (previous) {
            if (previous.version !== 1 || previous.manifestId !== manifest.id || previous.targetId !== targetId || !Number.isSafeInteger(previous.processed) ||
                previous.processed < 0 || previous.processed > manifest.files.length || !Number.isSafeInteger(previous.imported) || previous.imported < 0 ||
                !Number.isSafeInteger(previous.keptNewer) || previous.keptNewer < 0 || previous.imported + previous.keptNewer !== previous.processed) {
                throw new DataImportError("Import checkpoint belongs to a different database or has invalid totals. It was preserved.");
            }
            // A local checkpoint cannot authorize skipping data missing from SQL
            // after a restore/reset. Validate the completed prefix before resuming.
            const prefix = await verifyFiles(snapshot, manifest, manifest.files.slice(0, previous.processed), target, options.signal);
            if (!prefix.missing && !prefix.mismatched) checkpoint = { ...previous, complete: false };
        }
        const resumed = checkpoint.processed;
        for (const batch of batches(manifest.files.slice(checkpoint.processed))) {
            options.signal?.throwIfAborted();
            const values = await Promise.all(batch.map(file => readSnapshotEntry(snapshot, file)));
            const counts = batch[0]!.kind === "cache"
                ? await target.importCacheEntries(values as LegacyCacheEntry[])
                : await target.importAssessmentRecords(batch.map((file, index) => ({ itemId: file.id, savedAt: file.savedAt, record: values[index] as SavedRecord })), manifest.ownerId);
            if (!Number.isSafeInteger(counts.imported) || !Number.isSafeInteger(counts.keptNewer) || counts.imported < 0 || counts.keptNewer < 0 || counts.imported + counts.keptNewer !== batch.length) {
                throw new DataImportError("Database returned inconsistent import totals; no checkpoint was advanced.");
            }
            checkpoint.processed += batch.length; checkpoint.imported += counts.imported; checkpoint.keptNewer += counts.keptNewer; checkpoint.updatedAt = new Date().toISOString();
            await writeJsonAtomic(checkpointFile, checkpoint);
            options.onProgress?.({ ...checkpoint });
        }
        const verification = await verifyFiles(snapshot, manifest, manifest.files, target, options.signal);
        if (verification.missing || verification.mismatched) throw new DataImportError(`Import readback failed: ${verification.missing} missing and ${verification.mismatched} mismatched records. Originals and checkpoints were preserved.`);
        checkpoint.complete = true; checkpoint.updatedAt = new Date().toISOString();
        await writeJsonAtomic(checkpointFile, checkpoint);
        return { ...checkpoint, verification, resumed };
    } finally { await lock.close(); await fs.unlink(lockPath); }
}
