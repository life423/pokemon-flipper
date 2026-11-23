import type { Evaluation } from "./types.ts";
import { CONDITION_RULES_VERSION } from "./conditions.ts";
import { hasSpecialSlabTitle } from "./grade-qualifier.ts";
import { hasMismatchedPricePrinting, isRawSoldPrice } from "./money/price-evidence.ts";
import { hasBaseSetFourthPrint } from "./reprint-release.ts";
import { conflictsWithPhotoFinish } from "./photo-evidence.ts";

// Pricing changes do not invalidate paid photo/condition assessments.
export const PRICING_VERSION = "ebay-resale-17";
export const PHOTO_REVIEW_REVISION = 10;
// Raw-condition prompting changes do not invalidate historical sold-copy categories.
export const CONDITION_ASSESSMENT_REVISION = 2;
export const BOUNDED_REVIEW_REVISION = 3;
export const PREVIOUS_BOUNDED_REVIEW_REVISION = 2;
export const BOUNDED_REVIEW_REVISIONS = [BOUNDED_REVIEW_REVISION, PREVIOUS_BOUNDED_REVIEW_REVISION, 1] as const;
export const BOUNDED_CONDITION_REVISION = 1;
export const BOUNDED_SLAB_REVIEW_REVISION = 1;
const maxPriceEvidenceAge = (evaluation: Evaluation) => evaluation.slabPricing?.activeReference ? 2 * 60_000 : 6 * 3_600_000;

export function priceEvidenceHasExpired(evaluation: Evaluation, now: number): boolean {
    return now - Date.parse(evaluation.pricesCheckedAt ?? "") >= maxPriceEvidenceAge(evaluation);
}

export function currentPriceEvidence(evaluation: Evaluation, now = Date.now()): boolean {
    if (hasMismatchedPricePrinting(evaluation) || conflictsWithPhotoFinish(evaluation.photoCheck, evaluation.identity?.finish)) return false;
    // Older prices may have accepted a title-only special tier as a plain
    // grade. Reprice those retained sales without expiring unrelated prices
    // or changing the accepted photo/condition versions.
    const gradedSummaries = [evaluation.slabPricing?.summary,
        ...Object.values(evaluation.gradedPricing ?? {}).flatMap(pricing => pricing.byGrade ?? [])];
    if (gradedSummaries.some(summary => summary?.sales?.some(sale => hasSpecialSlabTitle(sale.title)))) return false;
    const raw = evaluation.rawPricing?.prices;
    const soldSummaries = [...gradedSummaries, ...(evaluation.rawPricing?.ebayComps ?? []), ...(raw ?? []).map(price => price.comps)];
    if (soldSummaries.some(summary => summary?.sales?.some(sale => hasBaseSetFourthPrint(evaluation.identity?.set, sale.title)))) return false;
    if (raw?.some(price => !isRawSoldPrice(price)) && !raw.some(isRawSoldPrice) &&
        !Object.values(evaluation.gradedPricing ?? {}).some(pricing => pricing.status === "PRICED")) return false;
    const age = now - Date.parse(evaluation.pricesCheckedAt ?? "");
    const bounded = BOUNDED_REVIEW_REVISIONS.some(revision => evaluation.assessmentVersion?.endsWith(`/bounded-prompts-${revision}`)) ||
        evaluation.assessmentVersion?.endsWith(`/bounded-slab-label-prompts-${BOUNDED_SLAB_REVIEW_REVISION}`) === true;
    const assessmentCurrent = bounded || evaluation.assessmentVersion?.endsWith(`/prompts-${PHOTO_REVIEW_REVISION}`) === true;
    const conditionCurrent = !evaluation.condition || evaluation.conditionVersion?.endsWith(bounded
        ? `/bounded-condition-${CONDITION_RULES_VERSION}/prompts-${BOUNDED_CONDITION_REVISION}`
        : `/condition-${CONDITION_RULES_VERSION}/prompts-${CONDITION_ASSESSMENT_REVISION}`) === true;
    return evaluation.pricingVersion === PRICING_VERSION && assessmentCurrent && conditionCurrent && Number.isFinite(age) && age >= 0 && age < maxPriceEvidenceAge(evaluation);
}
