import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../lib/paths.ts";
import type { SavedRecord } from "./types.ts";
import { writeJsonAtomic } from "../lib/atomic-json.ts";
import { createKeyedLock } from "../lib/keyed-lock.ts";
import { storageBackend, readAssessmentRecord, writeAssessmentRecord, StorageUnavailableError } from "../storage/index.ts";

export const withAssessmentLock = createKeyedLock();

// Saved model answers, one JSON file per listing in data/evaluations.
// Each file holds the item ID, a fingerprint of the photos, and the
// model's own output. No seller or buyer data.
const STORE_DIR = path.join(DATA_DIR, "evaluations");

// Changes whenever the photos, or their order, change.
export function photoFingerprint(photoUrls: string[]): string {
    return createHash("sha256").update(photoUrls.join(" ")).digest("hex");
}

interface AssessmentStoreOptions {
    directory?: string;
    backend?: () => "file" | "azure-sql";
    ownerId?: string;
    sql?: {
        readAssessmentRecord(itemId: string, ownerId?: string): Promise<SavedRecord | null>;
        writeAssessmentRecord(itemId: string, record: SavedRecord, ownerId?: string): Promise<void>;
    };
}

// The local owner is an explicit single-user compatibility scope. Public user
// authentication must supply an owner; it is not a globally shared shortlist or
// financial recommendation. SQL shares evidence separately from latestEvaluation.
export function createAssessmentStore({ directory = STORE_DIR, backend = storageBackend,
    ownerId, sql = { readAssessmentRecord, writeAssessmentRecord } }: AssessmentStoreOptions = {}) {
    function fileFor(itemId: string): string {
        // v1|336813300333|0 becomes v1_336813300333_0.json
        const name = String(itemId).replace(/[^A-Za-z0-9]/g, "_");
        return path.join(directory, `${name}.json`);
    }
    return {
        async load(itemId: string): Promise<SavedRecord | null> {
            if (backend() === "azure-sql") return sql.readAssessmentRecord(itemId, ownerId);
            try {
                const value: unknown = JSON.parse(await fs.readFile(fileFor(itemId), "utf8"));
                const record = value as Partial<SavedRecord> | null;
                if (!record || typeof record !== "object" || Array.isArray(record) || record.itemId !== itemId ||
                    typeof record.version !== "string" || typeof record.photoFingerprint !== "string") {
                    throw new Error("The saved assessment record does not match this listing.");
                }
                return record as SavedRecord;
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw new StorageUnavailableError("The saved photo assessment could not be read. It was kept; no replacement AI assessment was started.", { cause: error });
            }
        },
        async save(itemId: string, record: SavedRecord): Promise<void> {
            if (backend() === "azure-sql") await sql.writeAssessmentRecord(itemId, record, ownerId);
            else await writeJsonAtomic(fileFor(itemId), record);
        },
    };
}

const assessmentStore = createAssessmentStore();

export async function loadSaved(itemId: string): Promise<SavedRecord | null> {
    return assessmentStore.load(itemId);
}

export async function saveRecord(itemId: string, record: SavedRecord): Promise<void> {
    await assessmentStore.save(itemId, record);
}

// Title text is part of the model input too. Legacy records without that
// context require one new assessment rather than silently assuming it matches.
export function reusableRecord(
    saved: SavedRecord | null,
    { version, fingerprint, title }: { version: string; fingerprint: string; title: string }
): SavedRecord | null {
    if (!saved?.photoCheck?.result) return null;
    if (saved.version !== version) return null;
    if (saved.photoFingerprint !== fingerprint) return null;
    if (saved.reviewContext?.title.trim() !== title.trim()) return null;

    return saved;
}
