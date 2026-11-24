import type { Evaluation, ListingSummary, Verdict } from "./types.ts";

export interface ShortlistEntry {
    id: string;
    listing: ListingSummary;
    evaluation: Evaluation | null;
    savedAt: string;
    checkedAt: string | null;
    notes: string;
    ceiling: number | null;
    needsAnalysis: boolean;
    photoChange?: {
        previousPhotos: string[];
        previousVerdict: Verdict | null;
        neededBack: boolean;
        reviewedVerdict?: Verdict;
    };
}
export interface RefreshResult {
    entries: ShortlistEntry[];
    errors: { id: string; message: string }[];
}
export const SHORTLIST_LIMIT = 100;
export const REFRESH_LIMIT = 10;
