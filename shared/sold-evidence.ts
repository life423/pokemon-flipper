import { isRawCondition } from "./conditions.ts";
import { hasBaseSetFourthPrint } from "./reprint-release.ts";
import { listingDisclosesCardCrease } from "./ebay-condition-notes.ts";
import type { CompSummary, ListingSummary, Printing, ScreeningSoldEvidence, ScreeningSoldReference } from "./types.ts";

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const normalize = (value: unknown) => String(value ?? "").trim().toUpperCase();
export const MIN_MATCHED_SALES = 1;

// Fresh seller details can rule out the grading route on a retained screen.
export function usableGradingLead(listing: ListingSummary) {
    return listing.screen?.gradingLead && !listingDisclosesCardCrease(listing) ? listing.screen.gradingLead : undefined;
}

export function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// The median absolute deviation follows the spread of typical copies while
// allowing 30% either side of the median in a very tightly clustered sample.
export function rawPriceDeviation(prices: number[], middle: number): number {
    if (prices.length < 3) return Infinity;
    return Math.max(middle * 0.30, 3 * 1.4826 * median(prices.map(price => Math.abs(price - middle))));
}

export function typicalSales<T extends { price: number }>(sales: T[]): T[] {
    if (!sales.length) return [];
    const prices = sales.map(sale => sale.price), center = median(prices);
    const bounds = comparablePriceBounds(prices), deviation = rawPriceDeviation(prices, center);
    return sales.filter(({ price }) => price >= bounds.low && price <= bounds.high && Math.abs(price - center) <= deviation);
}

// In a sample of three or more, one unusually high sale cannot establish a
// higher exit price on its own. A second sale at the new level can support it.
export function capAtSecondHighestSale(price: number, sales: readonly { price: number }[]): number {
    if (sales.length < 3) return price;
    const ordered = sales.map(sale => sale.price).sort((a, b) => b - a);
    return Math.min(price, ordered[1]);
}

export function soldMarketPrice(summary: CompSummary): number | null {
    if (!summary.marketEstimate) return positive(summary.median) ? summary.median : null;
    const { price, method } = summary.marketEstimate;
    if (!(positive(price) && (summary.low == null || price >= summary.low) && (summary.high == null || price <= summary.high))) return null;
    return method === "RECENCY_WEIGHTED_MEDIAN" && summary.sales?.length === summary.count
        ? capAtSecondHighestSale(price, summary.sales) : price;
}

// Shared numerical/scope contract for already-matched public sold facts.
// Eligibility of the underlying transactions remains the provider layer's job.
export function usableSoldReference(reference: ScreeningSoldReference, slab: boolean): boolean {
    const { summary } = reference;
    if (!summary || !Number.isInteger(summary.count) || summary.count < MIN_MATCHED_SALES || !positive(summary.median) ||
        soldMarketPrice(summary) === null || !positive(summary.windowDays) || summary.windowDays > 180 ||
        !["HIGH", "MEDIUM", "LOW"].includes(summary.confidence)) return false;
    if (summary.low !== null && (!positive(summary.low) || summary.low > summary.median)) return false;
    if (summary.high !== null && (!positive(summary.high) || summary.high < summary.median)) return false;
    if (!reference.name || !reference.set || !reference.cardNumber ||
        !["FIRST_EDITION", "SHADOWLESS", "UNLIMITED"].includes(reference.printing) ||
        !["HOLO", "NON_HOLO", "REVERSE_HOLO"].includes(reference.finish)) return false;
    if (summary.sales?.some(sale => hasBaseSetFourthPrint(reference.set, sale.title))) return false;
    if (slab) return reference.condition === null && !!normalize(reference.grader) && positive(Number(reference.grade)) &&
        normalize(summary.grader) === normalize(reference.grader) && Number(summary.grade) === Number(reference.grade);
    return reference.grader === null && reference.grade === null && normalize(summary.grader) === "RAW" &&
        (isRawCondition(reference.condition) ? summary.grade === reference.condition :
            reference.condition === null && summary.grade === "UNSPECIFIED");
}

// Condition buckets stay in one raw identity scope; grade/grader, record,
// printing and finish differences remain distinct even when names coincide.
export function soldReferenceScope(reference: ScreeningSoldReference): string {
    return JSON.stringify([reference.recordId, normalize(reference.name), normalize(reference.set), normalize(reference.cardNumber),
        reference.printing, reference.finish, normalize(reference.grader), reference.grade === null ? null : Number(reference.grade)]);
}

// Query-scoped research is not an observed edition. Keep alternative markets
// available for identity research without pricing the live copy against one.
export function hasExactSoldScope(evidence: ScreeningSoldEvidence, printing?: Printing | "UNKNOWN" | null): boolean {
    return evidence.exactScope && evidence.references.length > 0 &&
        new Set(evidence.references.map(soldReferenceScope)).size === 1 &&
        (!printing || printing === "UNKNOWN" || evidence.references.every(reference => reference.printing === printing));
}

// Use the lower observation when a pair is too far apart to establish a typical price.
export function comparablePriceBounds(prices: number[]): { low: number; high: number } {
    const typical = median(prices);
    return prices.length === 2 ? { low: 0, high: Math.min(...prices) * 2.5 } :
        { low: typical / 2.5, high: typical * 2.5 };
}
