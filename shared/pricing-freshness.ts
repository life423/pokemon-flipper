import type { Evaluation } from "./types.ts";
import { CONDITION_RULES_VERSION } from "./conditions.ts";

// Pricing changes do not invalidate paid photo/condition assessments.
export const PRICING_VERSION = "ebay-resale-6";
export const PHOTO_REVIEW_REVISION = 10;
export function currentPriceEvidence(evaluation: Evaluation, now = Date.now()): boolean {
    const age = now - Date.parse(evaluation.pricesCheckedAt ?? "");
    return evaluation.pricingVersion === PRICING_VERSION && evaluation.assessmentVersion?.endsWith(`/prompts-${PHOTO_REVIEW_REVISION}`) === true &&
        (!evaluation.condition || evaluation.conditionVersion?.endsWith(`/condition-${CONDITION_RULES_VERSION}`) === true) && Number.isFinite(age) && age >= 0 && age < (evaluation.slabPricing?.activeReference ? 2 * 60000 : 6 * 3600000);
}
