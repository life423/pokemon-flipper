import type { CompSummary, Evaluation } from "./types.ts";
import { CONDITION_NAMES } from "./conditions.ts";
import { observedSalesActivity } from "./sales-activity.ts";
import { isUsableRawPrice } from "./money/price-evidence.ts";

export interface ResaleActivity {
    label: string;
    detail: string;
    recentSales: number | null;
    scope?: "MATCHED" | "BROAD";
}

export function matchedSoldActivity(evaluation: Evaluation | null, now = Date.now()) {
    let summary: CompSummary | undefined;
    let sellerCondition = false;
    const best = evaluation?.underwriting?.best;
    if (evaluation?.slab || best?.path === "GRADED_RESALE") summary = evaluation?.slabPricing?.summary;
    else if (best?.path === "GRADE" && best.grader) {
        const grade = evaluation?.condition?.gradeRange?.likely ?? evaluation?.condition?.gradeRange?.low;
        summary = evaluation?.gradedPricing?.[best.grader]?.byGrade?.find(entry => Number(entry.grade) === grade);
    } else if (evaluation?.condition) {
        summary = evaluation.rawPricing?.prices?.find(entry => entry.condition === evaluation.condition?.rawCondition)?.comps
            ?? evaluation.rawPricing?.ebayComps?.find(entry => entry.grade === evaluation.condition?.rawCondition && entry.count > 0);
        const seller = evaluation.rawPricing?.sellerConditionComps;
        if (seller?.grader === "RAW" && seller.grade === evaluation.condition.rawCondition && seller.count > 0) {
            summary = seller; sellerCondition = true;
        }
    }
    if (!summary) return null;
    const activity = observedSalesActivity(summary.activitySales ?? summary.sales, now, { maxDays: summary.windowDays ?? 180, slab: summary.grader !== "RAW" });
    const dates = activity.observations.map(sale => sale.sale.soldAt).sort((a, b) => Date.parse(a) - Date.parse(b));
    return { scope: summary.grader === "RAW" ? `Raw · ${CONDITION_NAMES[summary.grade as keyof typeof CONDITION_NAMES] ?? summary.grade}${sellerCondition ? " · seller-described condition" : ""}` : `${summary.grader} ${summary.grade}`,
        last7: activity.sales7, last30: activity.sales30, last60: activity.sales60, last90: activity.sales90,
        returned: activity.observations.length, windowDays: summary.windowDays ?? 180,
        oldest: dates[0] ?? null, newest: dates.at(-1) ?? null };
}

// Sold-comp frequency is observable; time to sell your copy isn't. Never
// turn a small or capped comp sample into a promised number of days to sell.
export function resaleActivity(evaluation: Evaluation | null, now = Date.now()): ResaleActivity {
    const best = evaluation?.underwriting?.best;
    const volume = evaluation?.marketActivity;
    const matched = matchedSoldActivity(evaluation, now);
    const quoted = evaluation?.rawPricing?.prices?.some(price => price.basis?.startsWith("TCGPLAYER_") && isUsableRawPrice(price));
    if (matched) return { label: matched.last60 >= 10 ? "Frequent recent sales" : matched.last60 >= 3 ? "Some recent sales" : "Sparse recent sales", recentSales: matched.last60, scope: "MATCHED",
        detail: `${matched.scope}: ${matched.last60} observed matching sales in the last 60 days (${matched.last7} / 7 days, ${matched.last30} / 30 days). ${matched.returned} matches in the returned ${matched.windowDays}-day sample.${matched.newest ? ` Latest sale ${matched.newest}.` : ""} This is observed activity, not a required sales quota or a promised resale time.` };
    if (volume?.status === "AVAILABLE") return {
        label: volume.observedSales >= 10 ? "Frequent recorded sales" : volume.observedSales >= 3 ? "Some recorded sales" : "Sparse recorded sales",
        recentSales: volume.observedSales,
        scope: "BROAD",
        detail: `${volume.complete ? "" : "At least "}${volume.observedSales} recorded eBay ${volume.scope === "RAW" ? "raw" : "graded"} sales of ${volume.variant} / 30 days (${volume.dailyAverage.toFixed(volume.dailyAverage < 1 ? 2 : 1)}/day; ${volume.activeDays} active days). ${volume.scope === "RAW" ? "All raw conditions combined" : "All graders and grades combined"}.`,
    };
    return {
        label: "Resale speed unknown",
        detail: best?.path === "RAW"
            ? "The price estimate supplies no matching completed transactions for the rolling 60-day activity view." +
                (quoted ? " TCGplayer offers are competition, not completed sales." : "")
            : "Not enough dated sold comps to assess resale activity.",
        recentSales: null,
    };
}
