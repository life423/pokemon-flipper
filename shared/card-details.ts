import type { Evaluation, ListingSummary } from "./types.ts";
import { finishIn, searchAttributes } from "./search-criteria.ts";

export function cardDetails(listing: ListingSummary, evaluation: Evaluation | null) {
    const listed = listing.listedAttributes ?? searchAttributes(listing.title);
    const namedGrade = (grader: string | null, grade: string | number | null) => grader && grade != null && String(grade).trim() ? `${grader} ${grade}` : grader ? `${grader} · Grade unknown` : grade != null ? `Grade ${grade} · Grader unknown` : "Grade unknown";
    if (!evaluation) return { source: "Listed", grade: listing.isGraded ? namedGrade(listed.grader, listed.grade) : "Raw", finish: finishName(listed.finish) };
    const slab = evaluation.slab;
    const photographed = evaluation.photoCheck?.slab;
    const graded = listing.isGraded || Boolean(photographed?.present) || Boolean(slab);
    const finish = finishIn(evaluation.identity?.finish ?? "") ?? finishIn(evaluation.photoCheck?.cardIdentity?.finish ?? "");
    return {
        source: graded ? slab?.status === "OK" ? "Label checked" : "Review needed" : "Photo assessed",
        grade: graded ? slab?.status === "OK" ? namedGrade(slab.grader, slab.grade) : photographed?.present ? `${namedGrade(photographed.grader, photographed.grade)}${photographed.gradeQualifier ? ` (${photographed.gradeQualifier})` : ""}` : "Grade unreadable" : "Raw",
        finish: finishName(finish),
    };
}
function finishName(finish: string | null): string {
    return finish === "HOLO" ? "Holo" : finish === "REVERSE_HOLO" ? "Reverse holo" : finish === "NON_HOLO" ? "Non-holo" : "Finish unknown";
}
