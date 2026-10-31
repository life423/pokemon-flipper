import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../lib/paths.ts";
import type { GradingMode, SavedAssessment, SavedRecord } from "./types.ts";
import { writeJsonAtomic } from "../lib/atomic-json.ts";
import { createKeyedLock } from "../lib/keyed-lock.ts";

export const withAssessmentLock = createKeyedLock();

// Saved model answers, one JSON file per listing in data/evaluations.
// Each file holds the item ID, a fingerprint of the photos, and the
// model's own output. No seller or buyer data.
const STORE_DIR = path.join(DATA_DIR, "evaluations");

// Changes whenever the photos, or their order, change.
export function photoFingerprint(photoUrls: string[]): string {
    return createHash("sha256").update(photoUrls.join(" ")).digest("hex");
}

function fileFor(itemId: string): string {
    // v1|336813300333|0 becomes v1_336813300333_0.json
    const name = String(itemId).replace(/[^A-Za-z0-9]/g, "_");
    return path.join(STORE_DIR, `${name}.json`);
}

export async function loadSaved(itemId: string): Promise<SavedRecord | null> {
    try {
        return JSON.parse(await fs.readFile(fileFor(itemId), "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error("The saved photo assessment could not be read. It was kept; no replacement AI assessment was started.", { cause: error });
    }
}

export async function saveRecord(itemId: string, record: SavedRecord): Promise<void> {
    await writeJsonAtomic(fileFor(itemId), record);
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

// A saved condition answer counts only if it was made in the same
// grading mode, from the same photos, that today's rules pick.
export function assessmentStillFits(
    savedAssessment: SavedAssessment | null,
    mode: GradingMode,
    photoNumbers: number[],
    version?: string
): boolean {
    return (
        savedAssessment !== null &&
        (!version || savedAssessment.version === version && savedAssessment.completedRuns === 2) &&
        savedAssessment.mode === mode &&
        savedAssessment.photoNumbers.join(",") === photoNumbers.join(",")
    );
}
