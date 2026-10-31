import type { CompSummary, Evaluation } from "./types.ts";
import { CONDITION_NAMES } from "./conditions.ts";

export interface ResaleActivity {
    label: string;
    detail: string;
    recentSales: number | null;
    scope?: "MATCHED" | "BROAD";
}

export function matchedSoldActivity(evaluation: Evaluation | null, now = Date.now()) {
    let summary: CompSummary | undefined;
    const best = evaluation?.underwriting?.best;
    if (evaluation?.slab || best?.path === "GRADED_RESALE") summary = evaluation?.slabPricing?.summary;
    else if (best?.path === "GRADE" && best.grader) {
        const grade = evaluation?.condition?.gradeRange.likely ?? evaluation?.condition?.gradeRange.low;
        summary = evaluation?.gradedPricing?.[best.grader]?.byGrade?.find(entry => Number(entry.grade) === grade);
    } else if (evaluation?.condition) {
        summary = evaluation.rawPricing?.ebayComps?.find(entry => entry.grade === evaluation.condition?.rawCondition)
            ?? evaluation.rawPricing?.prices?.find(entry => entry.condition === evaluation.condition?.rawCondition)?.comps;
    }
    if (!summary) return null;
    const seen = new Set<string>();
    const valid = summary.sales.filter(sale => {
        const age = now - Date.parse(sale.soldAt);
        if (!Number.isFinite(age) || age < 0 || age > (summary.windowDays ?? 180) * 86400000) return false;
        if (sale.url && seen.has(sale.url)) return false;
        if (sale.url) seen.add(sale.url);
        return true;
    });
    const count = (days: number) => valid.filter(sale => now - Date.parse(sale.soldAt) <= days * 86400000).length;
    const dates = valid.map(sale => sale.soldAt).sort((a, b) => Date.parse(a) - Date.parse(b));
    return { scope: summary.grader === "RAW" ? `Raw · ${CONDITION_NAMES[summary.grade as keyof typeof CONDITION_NAMES] ?? summary.grade}` : `${summary.grader} ${summary.grade}`,
        last7: count(7), last30: count(30), last90: count(90), returned: valid.length, windowDays: summary.windowDays ?? 180,
        oldest: dates[0] ?? null, newest: dates.at(-1) ?? null };
}

// Sold-comp frequency is observable; time to sell your copy isn't. Never
// turn a small or capped comp sample into a promised number of days to sell.
export function resaleActivity(evaluation: Evaluation | null, now = Date.now()): ResaleActivity {
    const best = evaluation?.underwriting?.best;
    const volume = evaluation?.marketActivity;
    const matched = matchedSoldActivity(evaluation, now);
    if (matched) return { label: matched.last30 >= 10 ? "Frequent recent sales" : matched.last30 >= 3 ? "Some recent sales" : "Sparse recent sales", recentSales: matched.last30, scope: "MATCHED",
        detail: `${matched.scope}: ${matched.last7} matched sold comps / 7 days, ${matched.last30} / 30 days, ${matched.last90} / 90 days. ${matched.returned} matches in the returned ${matched.windowDays}-day sample.${matched.newest ? ` Latest sale ${matched.newest}.` : ""}` };
    if (volume?.status === "AVAILABLE") return {
        label: volume.observedSales >= 10 ? "Frequent recorded sales" : volume.observedSales >= 3 ? "Some recorded sales" : "Sparse recorded sales",
        recentSales: volume.observedSales,
        scope: "BROAD",
        detail: `${volume.complete ? "" : "At least "}${volume.observedSales} recorded eBay ${volume.scope === "RAW" ? "raw" : "graded"} sales of ${volume.variant} / 30 days (${volume.dailyAverage.toFixed(volume.dailyAverage < 1 ? 2 : 1)}/day; ${volume.activeDays} active days). ${volume.scope === "RAW" ? "All raw conditions combined" : "All graders and grades combined"}. Checked ${volume.checkedAt.slice(0, 10)}.`,
    };
    let summary: CompSummary | undefined;
    if (best?.path === "RAW") summary = evaluation?.rawPricing?.prices?.find(price => price.condition === evaluation?.condition?.rawCondition)?.comps;
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
        scope: "MATCHED",
        detail: `${recent} observed ${summary.grader} ${summary.grade} sales / 30 days, from ${summary.sales.length} returned comps.`,
    };
}
