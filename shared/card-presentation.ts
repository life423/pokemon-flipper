import { MONEY_CONFIG } from "./money/config.ts";
import { pathNumbers } from "./money/underwriting.ts";
import { deeperPhotoConcerns } from "./photo-review.ts";
import type { Evaluation, Grader, PricedPath, Targets } from "./types.ts";

export function returnText(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return "—";
    const percent = value * 100;
    if (percent !== 0 && Math.abs(percent) < 0.01) return `${percent < 0 ? "−" : ""}<0.01%`;
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(percent)}%`;
}

export function scenarioAt(path: PricedPath, price: number) {
    const numbers = pathNumbers({ expectedNet: path.expectedNet, fixedCosts: path.fixedCosts, shipping: path.shipping, price }, MONEY_CONFIG);
    return { price, cost: numbers.cost, profit: numbers.profit, roi: numbers.cost > 0 ? numbers.profit / numbers.cost : null };
}

export function auctionDecision(evaluation: Evaluation, targets: Targets = MONEY_CONFIG.targets, now = Date.now()) {
    const best = evaluation.underwriting?.best;
    const current = evaluation.listing.price;
    const ceiling = best && Number.isFinite(best.maxBid) && best.maxBid > 0 ? best.maxBid : null;
    const provisional = deeperPhotoConcerns(evaluation).length > 0 || evaluation.identity?.status !== "IDENTIFIED" || (evaluation.slab
        ? evaluation.slab.status !== "OK"
        : !evaluation.condition || evaluation.condition.confidence === "LOW" || evaluation.condition.rawCondition === "UNKNOWN" || evaluation.condition.gradeRange.likely === null);
    const ended = Boolean(evaluation.listing.endTime && Date.parse(evaluation.listing.endTime) <= now);
    const overLimit = ceiling !== null && current !== null && current > ceiling;
    const status = ended ? "ENDED" : ceiling === null ? "UNPRICED" : overLimit ? "OVER_LIMIT" : provisional ? "PROVISIONAL" : "WITHIN_LIMIT";
    const breakEven = targets.minProfit === 0 && targets.minRoi === 0;
    // A graded resale price cannot predict the closing price of a raw card.
    const raw = evaluation.underwriting?.paths.find((path) => path.path === "RAW" && path.status === "PRICED");
    const summary = evaluation.slab?.status === "OK" && evaluation.slabPricing?.status === "PRICED" ? evaluation.slabPricing.summary : null;
    const dated = (summary?.sales ?? []).filter((sale) => {
        const age = now - Date.parse(sale.soldAt);
        return Number.isFinite(age) && age >= 0 && age <= 180 * 86400000 && sale.price > 0;
    });
    const sorted = dated.map((sale) => sale.price).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const benchmark = sorted.length ? {
        price: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
        low: sorted[0], high: sorted.at(-1)!, count: sorted.length, source: "Dated sold comps",
    } : !evaluation.slab && evaluation.identity?.status === "IDENTIFIED" && evaluation.condition && evaluation.condition.confidence !== "LOW" && evaluation.condition.authenticity.concern === "NONE_SEEN" && raw?.status === "PRICED" && raw.salePrice && evaluation.condition.rawCondition !== "UNKNOWN" ? {
        price: raw.salePrice, low: null, high: null, count: null, source: `Raw market quote${raw.priceCondition ? ` · ${raw.priceCondition.toLowerCase().replaceAll("_", " ")}` : ""}`,
    } : null;
    return { ceiling, provisional, ended, overLimit, status, breakEven, benchmark,
        atCurrent: best && current !== null ? scenarioAt(best, current) : null,
        atCeiling: best && ceiling !== null ? scenarioAt(best, ceiling) : null,
        atBenchmark: best && benchmark ? scenarioAt(best, benchmark.price) : null,
        label: breakEven ? "Break-even bid ceiling" : "Max snipe bid",
    };
}

export function gradingRoutes(evaluation: Evaluation) {
    if (evaluation.slab) return [];
    return (["PSA", "CGC"] as Grader[]).map((grader) => {
        const path = evaluation.underwriting?.paths.find((entry) => entry.path === "GRADE" && entry.grader === grader);
        return { grader, range: evaluation.condition?.gradeRange ?? null,
            priced: path?.status === "PRICED" ? path : null,
            reason: path?.status === "UNAVAILABLE" ? path.reason : "Awaiting photo assessment and verified prices.",
        };
    });
}
