import type { Evaluation } from "./types.ts";
import { CONDITION_RULES_VERSION, RAW_CONDITIONS, isRawCondition, sellerCreaseOverridesCondition } from "./conditions.ts";
import { hasSpecialSlabTitle } from "./grade-qualifier.ts";
import { hasMismatchedPricePrinting, isRawSoldPrice, isUsableRawPrice } from "./money/price-evidence.ts";
import { hasBaseSetFourthPrint } from "./reprint-release.ts";
import { conflictsWithPhotoFinish } from "./photo-evidence.ts";
import { hasSavedConditionExamples } from "./ebay-condition-notes.ts";

// Pricing changes do not invalidate paid photo/condition assessments.
export const PRICING_VERSION = "condition-resale-19";
export const PREVIOUS_PRICING_VERSION = "ebay-resale-18";
export const PHOTO_REVIEW_REVISION = 10;
// Raw-condition prompting changes do not invalidate historical sold-copy categories.
export const CONDITION_ASSESSMENT_REVISION = 2;
export const BOUNDED_REVIEW_REVISION = 4;
export const BOUNDED_FRONT_REVISION = 2;
export const BOUNDED_REVIEW_REVISIONS = [BOUNDED_REVIEW_REVISION, 3, BOUNDED_FRONT_REVISION, 1] as const;
export const BOUNDED_CONDITION_REVISION = 1;
export const BOUNDED_SLAB_REVIEW_REVISION = 1;
export const maxPriceEvidenceAge = (evaluation: Evaluation) => evaluation.slabPricing?.activeReference ? 2 * 60_000 : 6 * 3_600_000;

// A narrow, tentative grade can guide a buyer facing only a lower raw resale floor.
// It cannot support paying for grading or admitting the card to Deals.
export function provisionalComparisonRange(evaluation: Pick<Evaluation, "condition" | "provisionalGradeRange" | "rawPricing" | "slab">) {
    const range = evaluation.provisionalGradeRange, wear = evaluation.condition?.rawCondition;
    if (evaluation.slab || evaluation.condition?.gradeRange || !isRawCondition(wear) || !range?.likely ||
        ![range.low, range.likely, range.high].every(grade => Number.isInteger(grade) && grade >= 1 && grade <= 10) ||
        range.high - range.low > 2 || range.high === range.low || range.likely < range.low || range.likely > range.high ||
        evaluation.condition?.authenticity.concern !== "NONE_SEEN" || evaluation.condition.creases === "SUSPECTED") return null;
    const prices = evaluation.rawPricing?.prices ?? [];
    const lower = RAW_CONDITIONS.slice(RAW_CONDITIONS.indexOf(wear) + 1);
    if (evaluation.rawPricing?.conditionEvidence !== "AI_PHOTOS" || prices.some(row => row.condition === wear && isRawSoldPrice(row)) ||
        !prices.some(row => isRawCondition(row.condition) && lower.includes(row.condition) && isRawSoldPrice(row))) return null;
    return range;
}

export function priceEvidenceHasExpired(evaluation: Evaluation, now: number): boolean {
    return now - Date.parse(evaluation.pricesCheckedAt ?? "") >= maxPriceEvidenceAge(evaluation);
}

export function currentPriceEvidence(evaluation: Evaluation, now = Date.now()): boolean {
    const quote = evaluation.rawPricing?.prices?.find(row => row.condition === evaluation.condition?.rawCondition && isUsableRawPrice(row))?.offers;
    if (quote && (!(now - Date.parse(quote.checkedAt) >= 0) || now - Date.parse(quote.checkedAt) >= 6 * 3_600_000 ||
        quote.method === "LOWEST_DELIVERED_COMPETITION" && !(now - Date.parse(quote.snapshotAt) >= 0 && now - Date.parse(quote.snapshotAt) < 86_400_000))) return false;
    if (!evaluation.slab && hasSavedConditionExamples(evaluation.listing)) return false;
    if (hasMismatchedPricePrinting(evaluation) || conflictsWithPhotoFinish(evaluation.photoCheck, evaluation.identity?.finish)) return false;
    const condition = evaluation.condition?.rawCondition;
    // Previous assessments could have researched grades and cleaner raw copies
    // even though a disclosed crease requires a Damaged resale comparison.
    if (!evaluation.slab && condition && evaluation.gradedPricing && sellerCreaseOverridesCondition(condition, evaluation.listing.conditionNotes) &&
        !evaluation.rawPricing?.prices?.some(price => price.condition === "DAMAGED" && isUsableRawPrice(price))) return false;
    if (evaluation.pricingVersion !== PRICING_VERSION) {
        if (evaluation.pricingVersion !== PREVIOUS_PRICING_VERSION && evaluation.pricingVersion !== "ebay-resale-17") return false;
        // Raw valuations now consult condition-matched TCGplayer prices.
        // Reuse accepted physical findings, but refresh older raw economics.
        if (!evaluation.slab && !evaluation.underwriting?.verdict.startsWith("BUY")) return false;
        // v17 did not consider paying for a sold copy explicitly described as worse.
        // Refresh only the unresolved raw valuations where that could add evidence.
        const raw = evaluation.rawPricing, verdict = evaluation.underwriting?.verdict;
        if (!evaluation.slab && evaluation.identity?.status === "IDENTIFIED" && (verdict === "CANT_PRICE" || verdict === "PASS") &&
            isRawCondition(condition) && condition !== "DAMAGED" && evaluation.condition?.creases !== "SUSPECTED" &&
            evaluation.condition?.authenticity.concern === "NONE_SEEN" && raw?.status === "PRICE_UNAVAILABLE" &&
            raw.conditionEvidence === "AI_PHOTOS" && (raw.sampledSoldCopies ?? 0) > (raw.reviewedSoldCopies ?? 0)) return false;
    }
    // Earlier prices sometimes held only a lower-condition floor. Refresh that
    // price gap once. Already matched photo sales supply the preferred comparison.
    if (evaluation.rawPricing?.conditionEvidence === "AI_PHOTOS" && isRawCondition(condition) &&
        evaluation.rawPricing.sellerConditionComps === undefined &&
        !evaluation.rawPricing.prices?.some(price => price.condition === condition && price.comps?.count && isRawSoldPrice(price))) return false;
    // Older prices may have accepted a title-only special tier as a plain
    // grade. Reprice those retained sales without expiring unrelated prices
    // or changing the accepted photo/condition versions.
    const gradedSummaries = [evaluation.slabPricing?.summary,
        ...Object.values(evaluation.gradedPricing ?? {}).flatMap(pricing =>
            [...(pricing.byGrade ?? []), pricing.referenceGradeComps, ...(pricing.referenceByGrade ?? [])])];
    if (gradedSummaries.some(summary => summary?.sales?.some(sale => hasSpecialSlabTitle(sale.title)))) return false;
    const raw = evaluation.rawPricing?.prices;
    const soldSummaries = [...gradedSummaries, evaluation.rawPricing?.sellerConditionComps, evaluation.rawPricing?.cleanerSellerConditionComps,
        ...(evaluation.rawPricing?.ebayComps ?? []), ...(raw ?? []).map(price => price.comps)];
    if (soldSummaries.some(summary => summary?.sales?.some(sale => hasBaseSetFourthPrint(evaluation.identity?.set, sale.title)))) return false;
    if (raw?.some(price => !isUsableRawPrice(price)) && !raw.some(isUsableRawPrice) &&
        !Object.values(evaluation.gradedPricing ?? {}).some(pricing => pricing.status === "PRICED")) return false;
    const age = now - Date.parse(evaluation.pricesCheckedAt ?? "");
    const bounded = BOUNDED_REVIEW_REVISIONS.some(revision => evaluation.assessmentVersion?.endsWith(`/bounded-prompts-${revision}`)) ||
        evaluation.assessmentVersion?.endsWith(`/bounded-slab-label-prompts-${BOUNDED_SLAB_REVIEW_REVISION}`) === true;
    const assessmentCurrent = bounded || evaluation.assessmentVersion?.endsWith(`/prompts-${PHOTO_REVIEW_REVISION}`) === true;
    const conditionCurrent = !evaluation.condition || evaluation.conditionVersion?.endsWith(bounded
        ? `/bounded-condition-${CONDITION_RULES_VERSION}/prompts-${BOUNDED_CONDITION_REVISION}`
        : `/condition-${CONDITION_RULES_VERSION}/prompts-${CONDITION_ASSESSMENT_REVISION}`) === true;
    return assessmentCurrent && conditionCurrent && Number.isFinite(age) && age >= 0 && age < maxPriceEvidenceAge(evaluation);
}
