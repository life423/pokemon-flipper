import type { Evaluation, PhotoCheck } from "./types.ts";

const VIEW_NAMES: Record<string, string> = { FRONT: "front", BACK: "back", FRONT_DETAIL: "front close-up", BACK_DETAIL: "back close-up" };

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
    if (evaluation.slab || evaluation.photoCheck?.holder === "GRADED_SLAB") return evaluation.photoCheck?.confidence ?? "UNKNOWN";
    return evaluation.condition?.confidence ?? "UNKNOWN";
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
        : evaluation.condition && !range
          ? requestedGrade > 0 ? `No numeric grade estimate supports your potential ${requestedGrade} target.` : "The photos do not support a numeric grade estimate."
          : "The grade range is a photo estimate, not a guaranteed grading result.";
    return { confidence, coverage, issues, target, optimistic };
}
