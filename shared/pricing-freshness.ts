import type { Evaluation } from "./types.ts";
import { CONDITION_RULES_VERSION } from "./conditions.ts";
import { hasSpecialSlabTitle } from "./grade-qualifier.ts";
import { isRawSoldPrice } from "./money/price-evidence.ts";

// Pricing changes do not invalidate paid photo/condition assessments.
export const PRICING_VERSION = "ebay-resale-15";
export const PHOTO_REVIEW_REVISION = 10;
// Raw-condition prompting changes do not invalidate historical sold-copy categories.
export const CONDITION_ASSESSMENT_REVISION = 2;
export const BOUNDED_REVIEW_REVISION = 1;
export const BOUNDED_CONDITION_REVISION = 1;
export const BOUNDED_SLAB_REVIEW_REVISION = 1;
export function currentPriceEvidence(evaluation: Evaluation, now = Date.now()): boolean {
    // Older prices may have accepted a title-only special tier as a plain
    // grade. Reprice those retained sales without expiring unrelated prices
    // or changing the accepted photo/condition versions.
    const gradedSummaries = [evaluation.slabPricing?.summary,
        ...Object.values(evaluation.gradedPricing ?? {}).flatMap(pricing => pricing.byGrade ?? [])];
    if (gradedSummaries.some(summary => summary?.sales?.some(sale => hasSpecialSlabTitle(sale.title)))) return false;
    const raw = evaluation.rawPricing?.prices;
    if (raw?.some(price => !isRawSoldPrice(price)) && !raw.some(isRawSoldPrice) &&
        !Object.values(evaluation.gradedPricing ?? {}).some(pricing => pricing.status === "PRICED")) return false;
    const age = now - Date.parse(evaluation.pricesCheckedAt ?? "");
    const bounded = evaluation.assessmentVersion?.endsWith(`/bounded-prompts-${BOUNDED_REVIEW_REVISION}`) === true ||
        evaluation.assessmentVersion?.endsWith(`/bounded-slab-label-prompts-${BOUNDED_SLAB_REVIEW_REVISION}`) === true;
    const assessmentCurrent = bounded || evaluation.assessmentVersion?.endsWith(`/prompts-${PHOTO_REVIEW_REVISION}`) === true;
    const conditionCurrent = !evaluation.condition || evaluation.conditionVersion?.endsWith(bounded
        ? `/bounded-condition-${CONDITION_RULES_VERSION}/prompts-${BOUNDED_CONDITION_REVISION}`
        : `/condition-${CONDITION_RULES_VERSION}/prompts-${CONDITION_ASSESSMENT_REVISION}`) === true;
    return evaluation.pricingVersion === PRICING_VERSION && assessmentCurrent && conditionCurrent && Number.isFinite(age) && age >= 0 && age < (evaluation.slabPricing?.activeReference ? 2 * 60000 : 6 * 3600000);
}
