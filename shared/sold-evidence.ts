import { isRawCondition } from "./conditions.ts";
import type { ScreeningSoldReference } from "./types.ts";

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const normalize = (value: unknown) => String(value ?? "").trim().toUpperCase();
export const MIN_MATCHED_SALES = 1;

// Shared numerical/scope contract for already-matched public sold facts.
// Eligibility of the underlying transactions remains the provider layer's job.
export function usableSoldReference(reference: ScreeningSoldReference, slab: boolean): boolean {
    const { summary } = reference;
    if (!summary || !Number.isInteger(summary.count) || summary.count < MIN_MATCHED_SALES || !positive(summary.median) ||
        !positive(summary.windowDays) || summary.windowDays > 180 ||
        !["HIGH", "MEDIUM", "LOW"].includes(summary.confidence)) return false;
    if (summary.low !== null && (!positive(summary.low) || summary.low > summary.median)) return false;
    if (summary.high !== null && (!positive(summary.high) || summary.high < summary.median)) return false;
    if (!reference.name || !reference.set || !reference.cardNumber ||
        !["FIRST_EDITION", "SHADOWLESS", "UNLIMITED"].includes(reference.printing) ||
        !["HOLO", "NON_HOLO", "REVERSE_HOLO"].includes(reference.finish)) return false;
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
