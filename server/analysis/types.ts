import type { Condition, PhotoCheck } from "../../shared/types.ts";

export type GradingMode = "FULL" | "LIMITED" | "BLOCKED";

export interface Usage {
    inputTokens: number | null;
    outputTokens: number | null;
}

// One condition answer kept for a listing, and the others set aside.
export interface SavedAssessment {
    mode: GradingMode;
    photoNumbers: number[];
    result: Condition;
    setAside: Condition[];
}

// The model's answers for one listing, saved so they aren't paid for twice.
export interface SavedRecord {
    itemId: string;
    version: string;
    photoFingerprint: string;
    answeredAt: string | null;
    photoCheck: { result: PhotoCheck; usage: Usage } | null;
    assessment: SavedAssessment | null;
}
