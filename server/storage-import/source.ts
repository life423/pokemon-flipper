import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SavedRecord } from "../analysis/types.ts";
import { writeJsonAtomic } from "../lib/atomic-json.ts";
import { DataImportError, type ImportManifest, type ImportSummary, type LegacyCacheEntry, type SourceFile } from "./types.ts";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function validateCache(value: unknown, name: string): LegacyCacheEntry {
    if (!object(value) || typeof value.key !== "string" || !value.key || value.key.length > 32_000 || !date(value.savedAt) || !Object.hasOwn(value, "data")) {
        throw new DataImportError(`Invalid cached evidence in ${name}; no replacement provider call was made.`);
    }
    return { key: value.key, savedAt: new Date(value.savedAt).toISOString(), data: value.data };
}

export function validateAssessment(value: unknown, name: string): SavedRecord {
    if (!object(value) || typeof value.itemId !== "string" || !/^[A-Za-z0-9|_-]{1,120}$/.test(value.itemId) ||
        typeof value.version !== "string" || !value.version || typeof value.photoFingerprint !== "string" || !value.photoFingerprint ||
        !(value.answeredAt === null || date(value.answeredAt)) || !Object.hasOwn(value, "photoCheck") || !Object.hasOwn(value, "assessment") ||
        !(value.photoCheck === null || object(value.photoCheck) && object(value.photoCheck.result)) ||
        !(value.assessment === null || object(value.assessment) && object(value.assessment.result))) {
        throw new DataImportError(`Invalid saved assessment in ${name}; its original file was preserved.`);
    }
    if (value.reviewContext !== undefined && (!object(value.reviewContext) || typeof value.reviewContext.title !== "string" ||
        !Array.isArray(value.reviewContext.photos) || value.reviewContext.photos.some(photo => typeof photo !== "string"))) {
        throw new DataImportError(`Invalid assessment context in ${name}; its original file was preserved.`);
    }
    if (value.latestEvaluation !== undefined && (!object(value.latestEvaluation) || typeof value.latestEvaluation.evidenceKey !== "string" ||
        !object(value.latestEvaluation.evaluation))) throw new DataImportError(`Invalid private evaluation in ${name}; its original file was preserved.`);
    return value as unknown as SavedRecord;
}

async function jsonFile(file: string): Promise<{ bytes: Buffer; value: unknown; modifiedAt: string }> {
    try {
        const before = await fs.lstat(file);
        if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) throw new DataImportError(`Import requires a regular JSON file no larger than 32 MiB: ${path.basename(file)}.`);
        const bytes = await fs.readFile(file);
        const after = await fs.lstat(file);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size) throw new DataImportError(`Source changed while reading ${path.basename(file)}. Stop writers and retry.`);
        return { bytes, value: JSON.parse(bytes.toString("utf8")), modifiedAt: new Date(after.mtimeMs).toISOString() };
    } catch (error) {
        if (error instanceof DataImportError) throw error;
        throw new DataImportError(`Could not read valid JSON from ${path.basename(file)}. Source files were preserved.`, { cause: error });
    }
}

function manifestId(ownerId: string, files: SourceFile[]): string { return sha256(JSON.stringify({ ownerId, files })); }
function owner(value: string): string {
    if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(value)) throw new DataImportError("Import requires an explicit valid local owner ID.");
    return value;
}

export async function inspectLegacyData(directory: string, ownerId = "local-owner", signal?: AbortSignal): Promise<ImportManifest> {
    const root = path.resolve(directory), files: SourceFile[] = [];
    owner(ownerId);
    try { if (!(await fs.stat(root)).isDirectory()) throw new Error("Not a directory"); }
    catch (error) { throw new DataImportError("The source data directory does not exist or cannot be read.", { cause: error }); }
    for (const [folder, kind] of [["price-cache", "cache"], ["evaluations", "assessment"]] as const) {
        let names: string[];
        try { names = (await fs.readdir(path.join(root, folder))).filter(name => name.endsWith(".json")).sort(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new DataImportError(`Cannot list ${folder}; no import started.`, { cause: error }); }
        for (const name of names) {
            signal?.throwIfAborted();
            const source = await jsonFile(path.join(root, folder, name));
            const value = kind === "cache" ? validateCache(source.value, name) : validateAssessment(source.value, name);
            const id = kind === "cache" ? (value as LegacyCacheEntry).key : (value as SavedRecord).itemId;
            const expected = kind === "cache" ? `${createHash("sha1").update(id).digest("hex")}.json` : `${id.replace(/[^A-Za-z0-9]/g, "_")}.json`;
            if (name !== expected) throw new DataImportError(`The contents of ${folder}/${name} do not match its original lookup key. No import started.`);
            files.push({ kind, path: `${folder}/${name}`, id, sha256: sha256(source.bytes), bytes: source.bytes.byteLength,
                savedAt: kind === "cache" ? (value as LegacyCacheEntry).savedAt : source.modifiedAt });
        }
    }
    return { version: 1, id: manifestId(ownerId, files), sourceDirectory: root, ownerId, createdAt: new Date().toISOString(), files };
}

export function summarizeImport(manifest: ImportManifest): ImportSummary {
    return { cacheEntries: manifest.files.filter(file => file.kind === "cache").length,
        assessments: manifest.files.filter(file => file.kind === "assessment").length,
        bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) };
}

export async function prepareSnapshot(manifest: ImportManifest, backupRoot = path.join(manifest.sourceDirectory, "database-migration"), signal?: AbortSignal): Promise<string> {
    if (manifest.id !== manifestId(manifest.ownerId, manifest.files)) throw new DataImportError("Import manifest checksum is invalid.");
    const destination = path.join(backupRoot, manifest.id);
    await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    // Every source byte is copied and verified before the first database write.
    for (const file of manifest.files) {
        signal?.throwIfAborted();
        const source = await fs.readFile(path.join(manifest.sourceDirectory, file.path));
        if (sha256(source) !== file.sha256) throw new DataImportError(`Source changed after inspection: ${file.path}. No database import started.`);
        const output = path.join(destination, "snapshot", file.path);
        await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
        try { await fs.writeFile(output, source, { flag: "wx", mode: 0o600 }); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (sha256(await fs.readFile(output)) !== file.sha256) throw new DataImportError(`Existing backup checksum failed: ${file.path}. It was preserved.`);
        }
    }
    await writeJsonAtomic(path.join(destination, "manifest.json"), manifest);
    await writeJsonAtomic(path.join(backupRoot, "latest.json"), { version: 1, manifestId: manifest.id });
    return destination;
}

export async function loadSnapshot(directory: string): Promise<ImportManifest> {
    const value = (await jsonFile(path.join(directory, "manifest.json"))).value;
    if (!object(value) || value.version !== 1 || typeof value.ownerId !== "string" || typeof value.id !== "string" ||
        typeof value.sourceDirectory !== "string" || typeof value.createdAt !== "string" || !Array.isArray(value.files)) throw new DataImportError("Backup manifest is invalid.");
    owner(value.ownerId);
    const paths = new Set<string>(), identities = new Set<string>();
    for (const item of value.files) {
        if (!object(item) || !["cache", "assessment"].includes(String(item.kind)) || typeof item.path !== "string" ||
            !/^(?:price-cache|evaluations)\/[A-Za-z0-9_-]+\.json$/.test(item.path) || typeof item.id !== "string" ||
            typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) ||
            (item.bytes as number) < 0 || (item.bytes as number) > MAX_FILE_BYTES || !date(item.savedAt)) throw new DataImportError("Backup contains an invalid source descriptor.");
        const identity = `${item.kind}:${item.id}`;
        if (paths.has(item.path) || identities.has(identity) || !item.path.startsWith(item.kind === "cache" ? "price-cache/" : "evaluations/")) throw new DataImportError("Backup manifest contains duplicate or conflicting identities.");
        paths.add(item.path); identities.add(identity);
    }
    const result = value as unknown as ImportManifest;
    if (result.id !== manifestId(result.ownerId, result.files)) throw new DataImportError("Backup manifest checksum is invalid.");
    return result;
}

export async function readSnapshotEntry(directory: string, file: SourceFile): Promise<LegacyCacheEntry | SavedRecord> {
    const saved = await jsonFile(path.join(directory, "snapshot", file.path));
    if (sha256(saved.bytes) !== file.sha256 || saved.bytes.byteLength !== file.bytes) throw new DataImportError(`Backup checksum failed: ${file.path}. No replacement provider call was made.`);
    return file.kind === "cache" ? validateCache(saved.value, file.path) : validateAssessment(saved.value, file.path);
}

export async function latestSnapshot(directory: string): Promise<string> {
    const root = path.join(path.resolve(directory), "database-migration");
    const value = (await jsonFile(path.join(root, "latest.json"))).value;
    if (!object(value) || value.version !== 1 || typeof value.manifestId !== "string" || !/^[a-f0-9]{64}$/.test(value.manifestId)) throw new DataImportError("No valid latest import snapshot is available.");
    return path.join(root, value.manifestId);
}
