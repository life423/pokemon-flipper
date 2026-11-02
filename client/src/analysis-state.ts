import type { Evaluation } from "./types";

export type AnalysisState = (
    | { status: "loading"; startedAt: number }
    | { status: "done"; evaluation: Evaluation }
    | { status: "error"; message: string }
) & { evidenceKey: string };
