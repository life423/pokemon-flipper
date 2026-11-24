import { retargetEvaluation } from "../../shared/money/targets.ts";
import { priceEvidenceHasExpired } from "../../shared/pricing-freshness.ts";
import type { Evaluation, ListingSummary, Targets } from "./types.ts";

export type AnalysisState = (
    | { status: "loading"; startedAt: number }
    | { status: "done"; evaluation: Evaluation; pricingExpired?: true; searchRunId?: string }
    | { status: "inconclusive" | "held" | "error"; message: string }
) & { evidenceKey: string };

export type PriceRefreshState = { evidenceKey: string } & (
    | { status: "loading" }
    | { status: "done" | "error"; message: string }
);

export function displayAnalysis(analysis: AnalysisState, targets: Targets, now: number, listing?: ListingSummary, pricesNeedRefresh = false): AnalysisState {
    if (analysis.status !== "done") return analysis;
    const evaluation = retargetEvaluation(analysis.evaluation, targets, listing);
    const hadPricing = evaluation.slabPricing?.status === "PRICED" || evaluation.rawPricing?.status === "PRICED" ||
        Object.values(evaluation.gradedPricing ?? {}).some(pricing => pricing.status === "PRICED");
    if (!pricesNeedRefresh && (!hadPricing || !priceEvidenceHasExpired(evaluation, now))) return { ...analysis, evaluation };

    // Keep accepted photo findings while dropping time-sensitive purchase advice.
    return { ...analysis, pricingExpired: true, evaluation: { ...evaluation,
        rawPricing: null, gradedPricing: null, slabPricing: null, marketActivity: undefined, rating: null, underwriting: null } };
}
