import type { RawCondition } from "./conditions.ts";

export interface CameraGradeResult {
    status: "graded" | "retake" | "slab";
    cardName: string | null;
    grade: number | null;
    condition: RawCondition | "UNKNOWN" | null;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    observations: string[];
    guidance: string[];
}
