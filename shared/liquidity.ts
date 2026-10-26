import type { CompSummary, Evaluation } from "./types.ts";

export interface ResaleActivity {
    label: string;
    detail: string;
    recentSales: number | null;
}

// Sold-comp frequency is observable; time to sell your copy isn't. Never
// turn a small or capped comp sample into a promised number of days to sell.
export function resaleActivity(evaluation: Evaluation | null, now = Date.now()): ResaleActivity {
    const best = evaluation?.underwriting?.best;
    let summary: CompSummary | undefined;
    if (best?.path === "GRADED_RESALE") summary = evaluation?.slabPricing?.summary;
    if (best?.path === "GRADE" && best.grader) {
        const grade = evaluation?.condition?.gradeRange.likely ?? evaluation?.condition?.gradeRange.low;
        const outcome = best.outlook?.find((entry) => entry.grade === grade);
        const pricedGrade = outcome?.filledFrom ?? grade;
        summary = evaluation?.gradedPricing?.[best.grader]?.byGrade?.find((entry) => Number(entry.grade) === pricedGrade);
    }
    if (!summary?.sales.length) return {
        label: "Resale speed unknown",
        detail: best?.path === "RAW"
            ? "The raw price feed does not include turnover data. A market price alone cannot tell us how quickly this copy will sell."
            : "Not enough dated sold comps to assess resale activity.",
        recentSales: null,
    };
    const recent = summary.sales.filter((sale) => {
        const age = now - Date.parse(sale.soldAt);
        return Number.isFinite(age) && age >= 0 && age <= 30 * 86400000;
    }).length;
    return {
        label: recent >= 10 ? "Frequent recent sales" : recent >= 3 ? "Some recent sales" : "Sparse recent sales",
        recentSales: recent,
        detail: `${recent} observed ${summary.grader} ${summary.grade} sales in the last 30 days, from ${summary.sales.length} returned comps. This is a limited sales sample, not sell-through or a guarantee of how quickly your copy will sell.`,
    };
}
