import type { Evaluation, ListingSummary, PhotoCheck } from "./types.ts";
import { hasSlabEvidence, missingGalleryViews, obscuredDisclosedWear, photoAssessmentConfidence, photoCoverage, photoIssueNotes } from "./photo-evidence.ts";
import { isRawCondition } from "./conditions.ts";
import { priceEvidenceGap } from "./money/price-evidence.ts";
import { ordinaryBaseSetPokemonNumber, setKey } from "./sets.ts";
import { cardLanguageStatus } from "./card-language.ts";
import { sameCardNumber } from "./card-number.ts";

const DEEP_PHOTO_LIMIT = 6;
export function planDeeperPhotos(check: PhotoCheck | null, photos: string[]) {
    if (!check || check.cardCount !== "ONE") return { photos: [], reason: "A completed photo check of one card is needed first." };
    if (check.holder === "GRADED_SLAB") return { photos: [], reason: "This card already has a certified grade." };
    const seen = new Set<string>();
    const useful = check.images.filter((image) => {
        const url = photos[image.number - 1]?.replace(/\/s-l\d+\./, "/s-l1600.");
        if (!url || !image.usable || image.isStockImage || seen.has(url)) return false;
        seen.add(url); return true;
    });
    if (!useful.some((image) => image.view === "FRONT" && !image.obscuresCondition)) {
        return { photos: [], reason: "A clear, unobscured front photo is needed for a second reading." };
    }
    // Give each useful view a turn before adding more of the same view.
    const selected: typeof useful = [];
    for (const view of ["FRONT", "BACK", "FRONT_DETAIL", "BACK_DETAIL"]) {
        const image = useful.find((entry) => entry.view === view);
        if (image) selected.push(image);
    }
    for (const image of useful) if (!selected.includes(image)) selected.push(image);
    return { photos: selected.slice(0, DEEP_PHOTO_LIMIT).map((image) => ({ number: image.number, view: image.view, url: photos[image.number - 1].replace(/\/s-l\d+\./, "/s-l1600.") })), reason: null };
}

export function deeperPhotoConcerns(evaluation: Pick<Evaluation, "deeperPhotoReview">): string[] {
    return evaluation.deeperPhotoReview?.findings.filter((finding) => finding.impact === "NEW_CONCERN").map((finding) => finding.observation) ?? [];
}

function wholeSideCoverageNote(side: "front" | "back", overviews: number, reviewed: number, total: number): string {
    const unreviewed = Math.max(0, total - reviewed);
    if (!unreviewed) {
        if (!overviews) return `No usable photo shows the whole ${side}.`;
        return overviews === 1 ? `The only usable ${side} overview has limited detail.` : `Every usable whole-${side} photo has obscured detail.`;
    }
    const scope = `among the ${reviewed} reviewed ${reviewed === 1 ? "photo" : "photos"}`;
    const remaining = `${unreviewed} listing ${unreviewed === 1 ? "photo was" : "photos were"} not reviewed.`;
    return overviews
        ? `Every usable whole-${side} view ${scope} has obscured detail; ${remaining}`
        : `No usable whole-${side} view ${scope}; ${remaining}`;
}

const unresolvedPrinting = "The photos don't clearly show which printing this is.";
const baseSetMarks = "The photo review identified the card. That review could not confirm the shadow along the artwork border or the First Edition stamp.";

// Search cards and analysis details can both render reasons from older assessments.
// Translate only the known printing templates. Explicit claims, mismatches and
// observations remain available in the underlying assessment.
export function printingReviewReasons(evaluation: Evaluation, reasons: string[]): string[] {
    if (!reasons.some(reason => reason === unresolvedPrinting || reason === baseSetMarks)) return [...new Set(reasons)];
    const identity = evaluation.identity, observed = evaluation.photoCheck?.cardIdentity, marks = evaluation.photoCheck?.printingMarks;
    const set = setKey(identity?.set ?? "");
    let message = unresolvedPrinting;
    if (identity?.status === "NEEDS_REVIEW" && observed?.confidence === "HIGH" && set && setKey(observed.set ?? "") === set) {
        if (set === "base set" && ordinaryBaseSetPokemonNumber(observed.cardNumber) &&
            cardLanguageStatus("", [observed.language, identity.language]) === "ENGLISH" &&
            marks?.artBoxShadow === "CANT_TELL" && marks.firstEditionStamp === "CANT_TELL") {
            message = baseSetMarks;
        } else if (set !== "base set" && identity.hasEditions && !identity.notThisCard && !hasSlabEvidence(evaluation) &&
            evaluation.photoCheck?.cardMatch?.verdict === "MATCH" && !evaluation.photoCheck.cardMatch.problems.length &&
            !marks?.conflicts?.length && marks?.reprintMark === "NONE_SEEN" && sameCardNumber(identity.cardNumber, observed.cardNumber) &&
            identity.name?.toLowerCase() === observed.name?.toLowerCase() && observed.name && observed.cardNumber &&
            identity.printing === "UNKNOWN" && identity.evidence?.title === "NOT_STATED" && identity.evidence.itemSpecifics === "NOT_STATED" &&
            identity.evidence.label === "NOT_STATED" && identity.evidence.photo === "UNKNOWN") {
            message = `The photos identify ${observed.name} ${observed.cardNumber} from ${observed.set}. Use Unlimited as the price reference. A premium edition is unverified.`;
        }
    }
    return [...new Set(reasons.map(reason => reason === unresolvedPrinting || reason === baseSetMarks ? message : reason))];
}

export function photoReviewStatus(evaluation: Evaluation | null, listing?: ListingSummary) {
    if (!evaluation?.photoCheck) return {
        title: listing?.screen?.evidence?.mainPhoto === "MATCH" || listing?.mistakes?.length ? "AI preliminary photo check only" : "AI photo review not completed",
        confidence: "UNKNOWN", checked: 0, total: listing?.images?.length ?? 0, reviewedAt: null, reasons: [] as string[], photoNotes: [] as string[], needsYourReview: false,
    };
    const check = evaluation.photoCheck;
    const deferred = evaluation.researchMode === "DEFERRED_LOW_RESALE";
    const confidence = photoAssessmentConfidence(evaluation);
    const newConcerns = deeperPhotoConcerns(evaluation);
    const reasons = [...newConcerns];
    const photoNotes = photoIssueNotes(check);
    const stop = evaluation.frontPhotoStop;
    const verdict = evaluation.underwriting?.verdict;
    if (verdict === "PASS" && obscuredDisclosedWear(evaluation)) return { title: "AI photo review complete", confidence, checked: check.images.length,
        total: evaluation.listing.photosInListing, reviewedAt: evaluation.answeredAt, reasons: [], photoNotes, needsYourReview: false };
    const stopped = stop && verdict === "PASS";
    const pending = (stop === "SLAB_PRICE" || stop === "RAW_PRICE") && verdict === "CANT_PRICE";
    if ((stopped || pending) && !newConcerns.length) {
        if (pending) photoNotes.push("The remaining listing photos have not been checked.");
        return { title: stopped ? "Assessment stopped after the front photo" : "Front photo checked", confidence, checked: check.images.length,
            total: evaluation.listing.photosInListing, reviewedAt: evaluation.answeredAt,
            reasons: [], photoNotes: [...new Set([...(evaluation.underwriting?.reasons ?? []), ...photoNotes])], needsYourReview: false };
    }
    // A readable, accepted label can have informational seller-data notes.
    // The slab validator retains material label/case/authenticity conflicts as
    // review reasons; presentation never discards them by matching their text.
    if (evaluation.slab?.status === "OK") photoNotes.push(...evaluation.slab.concerns);
    if (evaluation.identity?.status !== "IDENTIFIED") reasons.push(...(evaluation.identity?.reasons.length ? evaluation.identity.reasons : ["The exact card identity is uncertain."]));
    if (evaluation.slab?.status !== "OK" && evaluation.slab) reasons.push(...(evaluation.slab.reasons.length ? evaluation.slab.reasons : evaluation.slab.concerns.length ? evaluation.slab.concerns : ["The photos leave the slab label or authenticity uncertain."]));
    if (evaluation.underwriting?.verdict === "NEEDS_REVIEW" && (!deferred || evaluation.condition)) reasons.push(...(evaluation.underwriting.reasons.length ? evaluation.underwriting.reasons : ["The available evidence is too uncertain to recommend buying."]));
    if (!hasSlabEvidence(evaluation)) {
        const coverage = photoCoverage(check);
        const best = evaluation.underwriting?.best;
        const knownRawCondition = evaluation.condition && isRawCondition(evaluation.condition.rawCondition);
        const completedPricePass = evaluation.underwriting?.verdict === "PASS" && best?.status === "PRICED";
        const rawPriceMissing = evaluation.underwriting?.verdict === "CANT_PRICE" && !evaluation.condition?.gradeRange && priceEvidenceGap(evaluation);
        // A useful raw-condition assessment can support as-is resale without
        // proving every grading detail. Keep the exact coverage limitations
        // visible, without making them a grading hold on a raw resale or an
        // already rejected purchase. When grading has no numeric estimate and
        // only a raw sold price is missing, the back view is a note as well.
        const coverageNotes = deferred || knownRawCondition && (best?.path === "RAW" || completedPricePass || rawPriceMissing) ? photoNotes : reasons;
        // A sampled gallery can establish a limitation of the reviewed photos,
        // but cannot establish that the seller omitted that view altogether.
        const reviewed = check.images.length;
        const total = evaluation.listing.photosInListing;
        if (!coverage.clearFronts) coverageNotes.push(wholeSideCoverageNote("front", coverage.fronts, reviewed, total));
        if (!coverage.clearBacks) coverageNotes.push(wholeSideCoverageNote("back", coverage.backs, reviewed, total));
        if (!evaluation.condition && !deferred) reasons.push("AI could not support a raw-condition or grade estimate.");
        else if (evaluation.condition?.rawCondition === "UNKNOWN") reasons.push("AI could not support a raw-condition estimate.");
        const authenticity = evaluation.condition?.authenticity;
        if (authenticity && authenticity.concern !== "NONE_SEEN") reasons.push(...(authenticity.reasons.length ? authenticity.reasons : ["The photos raise an authenticity question."]));
        const grading = evaluation.underwriting?.best?.path === "GRADE";
        if (evaluation.condition && !evaluation.condition.gradeRange) {
            (grading ? reasons : photoNotes).push("The photos do not support using a grade for pricing.");
        } else if (evaluation.condition?.gradeRange?.likely === null) {
            (grading ? reasons : photoNotes).push("The photos do not support a single likely grade.");
        }
        if (confidence === "LOW") (grading ? reasons : photoNotes).push("Photo assessment confidence is low.");
        // A cropped or glared close-up describes that image, not every view of
        // the card. Requested extra views remain visible without replacing the
        // whole-side coverage or the model's completed condition assessment.
        photoNotes.push(...missingGalleryViews(check).map(view => `Additional view requested by AI: ${view}`));
        photoNotes.push(...evaluation.modeReasons.map(reason => `Assessment note: ${reason}`));
    }
    const concerns = reasons.length > 0;
    return { title: evaluation.frontPhotoStop ? "Front photo checked" : deferred && !evaluation.condition ? "AI identity check complete" : "AI photo review complete", confidence, checked: check.images.length,
        total: evaluation.listing.photosInListing, reviewedAt: evaluation.answeredAt,
        reasons: printingReviewReasons(evaluation, reasons), photoNotes: [...new Set(photoNotes)], needsYourReview: concerns };
}

export function isResearchDeferred(evaluation: Evaluation | null): boolean {
    return Boolean(evaluation && (evaluation.researchMode === "DEFERRED_LOW_RESALE" || priceEvidenceGap(evaluation)) &&
        evaluation.listing.availability !== "UNAVAILABLE" && !photoReviewStatus(evaluation).needsYourReview);
}
