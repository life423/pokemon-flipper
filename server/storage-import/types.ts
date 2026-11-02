import type { SavedRecord } from "../analysis/types.ts";

export interface LegacyCacheEntry { key: string; savedAt: string; data: unknown }
export interface LegacyAssessmentEntry { itemId: string; record: SavedRecord; savedAt: string }
export interface ImportCounts { imported: number; keptNewer: number }
export interface ImportTarget {
    importCacheEntries(entries: LegacyCacheEntry[]): Promise<ImportCounts>;
    importAssessmentRecords(entries: LegacyAssessmentEntry[], ownerId?: string): Promise<ImportCounts>;
    readCacheEntries(keys: string[]): Promise<LegacyCacheEntry[]>;
    readAssessmentRecords(ids: string[], ownerId?: string): Promise<LegacyAssessmentEntry[]>;
}
export interface SourceFile {
    kind: "cache" | "assessment";
    path: string;
    id: string;
    sha256: string;
    bytes: number;
    savedAt: string;
}
export interface ImportManifest {
    version: 1;
    id: string;
    sourceDirectory: string;
    ownerId: string;
    createdAt: string;
    files: SourceFile[];
}
export interface ImportSummary { cacheEntries: number; assessments: number; bytes: number }
export interface ImportCheckpoint {
    version: 1;
    manifestId: string;
    targetId: string;
    processed: number;
    imported: number;
    keptNewer: number;
    complete: boolean;
    updatedAt: string;
}
export interface VerifySummary { matched: number; keptNewer: number; missing: number; mismatched: number }
export class DataImportError extends Error {
    constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "DataImportError"; }
}
