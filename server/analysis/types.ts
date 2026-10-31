import type { Condition, DeeperPhotoReview, PhotoCheck, Evaluation } from "../../shared/types.ts";

export type GradingMode = "FULL" | "LIMITED" | "BLOCKED";

export interface Usage {
    inputTokens: number | null;
    outputTokens: number | null;
}

// One condition answer kept for a listing, and the others set aside.
export interface SavedAssessment {
    version?: string;
    completedRuns?: number;
    mode: GradingMode;
    photoNumbers: number[];
    result: Condition;
    setAside: Condition[];
}

// The model's answers for one listing, saved so they aren't paid for twice.
export interface SavedRecord {
    conditionRuns?: { version: string; mode: GradingMode; photoNumbers: number[]; answers: import("./condition-runs.ts").ConditionRun[] };
    identityPasses?: { result: import("../ai/openai.ts").IdentityPhotoReading; usage: Usage }[];
    latestEvaluation?: { evidenceKey: string; evaluation: Evaluation };
    reviewContext?: { title: string; photos: string[] };
    deeperPhotoReview?: DeeperPhotoReview;
    itemId: string;
    version: string;
    photoFingerprint: string;
    answeredAt: string | null;
    photoCheck: { result: PhotoCheck; usage: Usage } | null;
    assessment: SavedAssessment | null;
}
