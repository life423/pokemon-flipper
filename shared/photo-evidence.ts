import { isRawCondition, type RawCondition } from "./conditions.ts";
import { finishClaim } from "./finish.ts";
import { readyForPricing } from "./identity.ts";
import { normalizedPhoto } from "./listing-evidence.ts";
import type { Evaluation, GradeRange, PhotoCheck } from "./types.ts";

const VIEW_NAMES: Record<string, string> = { FRONT: "front", BACK: "back", FRONT_DETAIL: "front close-up", BACK_DETAIL: "back close-up" };

type CardPhotos = Partial<Pick<PhotoCheck, "cardIdentity" | "cardCount" | "images">>;

export function confirmedPhotoCard(check?: CardPhotos | null) {
    const card = check?.cardIdentity;
    return card?.confidence === "HIGH" && check?.cardCount === "ONE" &&
        check.images?.some(image => image.usable && !image.isStockImage && (image.view === "FRONT" || image.view === "FRONT_DETAIL")) ? card : null;
}

export function conflictsWithPhotoFinish(check: CardPhotos | null | undefined, finish: string | null | undefined): boolean {
    const card = confirmedPhotoCard(check);
    if (!card?.evidence?.length || card.finish === "UNKNOWN") return false;
    const claim = finish === "CONFLICTING" ? finish : finishClaim(finish);
    return claim !== "NOT_STATED" && claim !== card.finish;
}

// Holder evidence is independent of readable grades, certificate checks and
// raw condition. Unknown holders and stock-only/multiple-card views prove neither.
export function observedCardKind(evaluation?: Pick<Evaluation, "photoCheck"> | null): "raw" | "graded" | null {
    const check = evaluation?.photoCheck;
    if (check?.cardCount !== "ONE" || !Array.isArray(check.images) || !check.images.some(photo => photo?.usable && !photo.isStockImage &&
        (photo.view === "FRONT" || photo.view === "FRONT_DETAIL"))) return null;
    if (check.holder === "GRADED_SLAB" && check.slab?.present) return "graded";
    if (["NONE", "SLEEVE", "TOPLOADER"].includes(check.holder) && !check.slab?.present) return "raw";
    return null;
}

function reviewedGallery(listing: Partial<Pick<Evaluation["listing"], "photosInListing" | "photos">>, check: PhotoCheck): boolean {
    if (!listing.photosInListing) return false;
    const urls = listing.photos;
    if (urls?.length !== listing.photosInListing) return check.images.length >= listing.photosInListing;
    const remaining = new Set(urls.filter(Boolean).map(normalizedPhoto));
    if (!remaining.size) return false;
    for (const { number } of check.images) {
        const url = urls[number - 1];
        if (url) remaining.delete(normalizedPhoto(url));
    }
    return remaining.size === 0;
}

export function obscuredDisclosedWear({ listing, photoCheck, condition }: {
    listing: Partial<Pick<Evaluation["listing"], "conditionNotes" | "photosInListing" | "photos">>;
    photoCheck?: PhotoCheck | null;
    condition?: Partial<Pick<NonNullable<Evaluation["condition"]>, "corners" | "edges">> | null;
}): string | null {
    if (!photoCheck || !["SLEEVE", "TOPLOADER"].includes(photoCheck.holder) || observedCardKind({ photoCheck }) !== "raw" ||
        !reviewedGallery(listing, photoCheck)) return null;

    const views = photoCheck.images.filter(photo => photo.usable && !photo.isStockImage && photo.view !== "OTHER");
    const allObscured = views.every(photo => photo.obscuresCondition === true);
    const notes = (listing.conditionNotes ?? []).flatMap(note => note.toLowerCase().split(/[.;\n]+/))
        .filter(note => !/\b(?:no|without|free of|none)\b/.test(note));
    const wear = /\b(corners?|edges?)(?:\s*(?:and|&|\/|or)\s*(corners?|edges?))?\s+(?:wear|whitening|chipping|damage)\b/g;
    const areas = notes.flatMap(note => [...note.matchAll(wear)].flatMap(match => [match[1], match[2]].filter(Boolean)));
    const obscured = (["corner", "edge"] as const).filter(area => areas.some(value => value.startsWith(area)) &&
        (condition?.[area === "corner" ? "corners" : "edges"]?.visibility ?? (allObscured ? "NOT_VISIBLE" : "CLEAR")) !== "CLEAR");
    if (!obscured.length) return null;
    return `The seller discloses ${obscured.join(" and ")} wear, and the photos through the holder do not clearly show those areas. Pass unless clear photos outside the holder show the wear.`;
}

export function hasSlabEvidence(evaluation?: Pick<Evaluation, "slab" | "photoCheck"> | null): boolean {
    return Boolean(evaluation?.slab || evaluation?.photoCheck?.holder === "GRADED_SLAB");
}

export function withoutRawSlabAssessment(evaluation: Evaluation): Evaluation {
    if (!hasSlabEvidence(evaluation)) return evaluation;
    const { provisionalGradeRange, conditionVersion, ...slab } = evaluation;
    const gradeStatus = evaluation.slab?.grader && evaluation.slab.grade ? "CERTIFIED_SLAB" : "UNKNOWN_PHOTO_EVIDENCE";
    return { ...slab, condition: null, gradingMode: "BLOCKED", gradeStatus, rawPricing: null, gradedPricing: null };
}

export function photoIssueNotes(check: PhotoCheck | null) {
    return [...new Set((check?.images ?? []).flatMap((photo, index) => {
        const number = Number.isInteger(photo.number) && photo.number > 0 ? photo.number : index + 1;
        const view = VIEW_NAMES[photo.view] ?? photo.view.toLowerCase().replaceAll("_", " ");
        return photo.issues.map(issue => `Photo ${number} (${view}): ${issue}`);
    }))];
}

export function photoCoverage(check: PhotoCheck | null) {
    const usable = (check?.images ?? []).filter(photo => photo.usable && !photo.isStockImage);
    const fronts = usable.filter(photo => photo.view === "FRONT");
    const backs = usable.filter(photo => photo.view === "BACK");
    return { usable: usable.length, fronts: fronts.length, backs: backs.length,
        closeUps: usable.filter(photo => photo.view === "FRONT_DETAIL" || photo.view === "BACK_DETAIL").length,
        clearFronts: fronts.filter(photo => !photo.obscuresCondition).length,
        clearBacks: backs.filter(photo => !photo.obscuresCondition).length };
}

export function photoAssessmentConfidence(evaluation: Evaluation) {
    // Reading a certified label does not produce a raw-condition estimate.
    // A separate price/certificate/authenticity hold must not erase the photo
    // reader's confidence; those concerns remain in the review reasons.
    if (hasSlabEvidence(evaluation)) return evaluation.photoCheck?.confidence ?? "UNKNOWN";
    return evaluation.condition?.confidence ?? "UNKNOWN";
}

export function slabLabelConfidence(evaluation: Evaluation): "HIGH" | null {
    const { identity, photoCheck, slab } = evaluation;
    const label = photoCheck?.slab;
    const identityConcern = evaluation.deeperPhotoReview?.findings.some(finding => finding.area === "IDENTITY" && finding.impact === "NEW_CONCERN");
    return slab?.status === "OK" && slab.grader && slab.grade &&
        readyForPricing(identity) && identity?.name && !identity.notThisCard && !identityConcern &&
        observedCardKind(evaluation) === "graded" && label?.authenticity === "NONE_SEEN" &&
        label.grader === slab.grader && label.grade === slab.grade ? "HIGH" : null;
}

// A rough reference for older readings that only described visible wear.
// These ranges are for display and never enter purchase math or grade filters.
export const gradesFromWear: Readonly<Record<RawCondition, GradeRange>> = {
    MINT: { low: 8, likely: 9, high: 10 },
    NEAR_MINT: { low: 7, likely: 8, high: 9 },
    LIGHTLY_PLAYED: { low: 5, likely: 6, high: 7 },
    MODERATELY_PLAYED: { low: 3, likely: 4, high: 5 },
    HEAVILY_PLAYED: { low: 1, likely: 2, high: 3 },
    DAMAGED: { low: 1, likely: 1, high: 3 },
};

export function displayedRawGrade(evaluation: Evaluation) {
    const kind = observedCardKind(evaluation);
    if (hasSlabEvidence(evaluation)) return null;
    const condition = evaluation.condition;
    if (condition?.gradeRange) return { range: condition.gradeRange, confidence: condition.confidence, source: "PHOTO" } as const;
    if (kind !== "raw") return null;
    if (evaluation.provisionalGradeRange) return { range: evaluation.provisionalGradeRange, confidence: "LOW", source: "PROVISIONAL" } as const;
    if (condition && isRawCondition(condition.rawCondition)) return { range: gradesFromWear[condition.rawCondition], confidence: "LOW", source: "WEAR" } as const;
    return { range: { low: 1, likely: null, high: 10 }, confidence: "UNKNOWN", source: "UNRESOLVED" } as const;
}

export function photoEvidence(evaluation: Evaluation, requestedGrade = 0) {
    const photos = photoCoverage(evaluation.photoCheck);
    const confidence = photoAssessmentConfidence(evaluation);
    const coverage = `${photos.usable} usable photos: ${photos.fronts} front, ${photos.backs} back, ${photos.closeUps} close-ups`;
    const issues = photoIssueNotes(evaluation.photoCheck);
    const range = evaluation.condition?.gradeRange;
    const optimistic = Boolean(range && requestedGrade > 0 && requestedGrade <= range.high &&
        (range.likely === null || requestedGrade > range.likely));
    const target = requestedGrade > 0 && range
        ? requestedGrade > range.high
          ? `The upper estimate ${range.high} does not meet your potential ${requestedGrade} target.`
          : optimistic
            ? `${requestedGrade} is an upper-end possibility in the ${range.low}–${range.high} range${range.likely !== null ? `; ${range.likely} is the likely estimate` : "; no likely grade is supported"}.`
            : `${requestedGrade} is within the estimated ${range.low}–${range.high} range.`
        : displayedRawGrade(evaluation) || evaluation.condition
          ? requestedGrade > 0 ? `The photos do not establish whether this card meets your potential ${requestedGrade} target.` : "The photos do not support using a grade for pricing."
          : "The grade range is a photo estimate, not a guaranteed grading result.";
    return { confidence, coverage, issues, target, optimistic };
}
