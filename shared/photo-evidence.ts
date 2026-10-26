import type { Evaluation } from "./types.ts";

export function photoAssessmentConfidence(evaluation: Evaluation) {
    return evaluation.condition?.confidence ?? (evaluation.slab?.status === "OK" ? evaluation.photoCheck?.confidence : undefined) ?? "UNKNOWN";
}

export function photoEvidence(evaluation: Evaluation, requestedGrade = 0) {
    const photos = evaluation.photoCheck?.images ?? [];
    const usable = photos.filter((photo) => photo.usable && !photo.isStockImage);
    const fronts = usable.filter((photo) => photo.view === "FRONT").length;
    const backs = usable.filter((photo) => photo.view === "BACK").length;
    const closeUps = usable.filter((photo) => photo.view === "FRONT_DETAIL" || photo.view === "BACK_DETAIL").length;
    const confidence = photoAssessmentConfidence(evaluation);
    const coverage = `${usable.length} usable photos: ${fronts} front, ${backs} back, ${closeUps} close-ups`;
    const issues = [...new Set(photos.flatMap((photo) => photo.issues))];
    const range = evaluation.condition?.gradeRange;
    const optimistic = Boolean(range && requestedGrade > 0 && requestedGrade <= range.high &&
        (range.likely === null || requestedGrade > range.likely));
    const target = requestedGrade > 0 && range
        ? requestedGrade > range.high
          ? `The upper estimate ${range.high} does not meet your potential ${requestedGrade} target.`
          : optimistic
            ? `${requestedGrade} is an upper-end possibility in the ${range.low}–${range.high} range${range.likely !== null ? `; ${range.likely} is the likely estimate` : "; no likely grade is supported"}.`
            : `${requestedGrade} is within the estimated ${range.low}–${range.high} range.`
        : "The grade range is a photo estimate, not a guaranteed grading result.";
    return { confidence, coverage, issues, target, optimistic };
}
