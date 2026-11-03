import type { Condition, DeeperPhotoReview, PhotoCheck, Evaluation } from "../../shared/types.ts";

export type GradingMode = "FULL" | "LIMITED" | "BLOCKED";

// Current purchase terms supplied by the browser; photo evidence is reused
// independently from these changing listing facts.
export interface CurrentState {
    title?: string;
    images?: string[];
    price: number | null;
    shipping: number | null;
    bids: number;
    endTime: string | null;
}

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
    conditionRuns?: { version: string; mode: GradingMode; photoNumbers: number[]; answers: { index: number; result: Condition; usage: Usage }[] };
    identityPasses?: { result: import("./legacy-evidence.ts").IdentityPhotoReading; usage: Usage }[];
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
