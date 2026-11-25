import type { Evaluation, ListingSummary } from "./types.ts";
import { finishIn, searchAttributes } from "./search-criteria.ts";
import { observedCardKind } from "./photo-evidence.ts";

export function cardDetails(listing: ListingSummary, evaluation: Evaluation | null) {
    const listed = listing.listedAttributes ?? searchAttributes(listing.title);
    const namedGrade = (grader: string | null, grade: string | number | null) => grader && grade != null && String(grade).trim() ? `${grader} ${grade}` : grader ? `${grader} · Grade unknown` : grade != null ? `Grade ${grade} · Grader unknown` : "Grade unknown";
    const listedDetails = { source: "Listed", grade: listing.isGraded ? namedGrade(listed.grader, listed.grade) : "Raw", finish: finishName(listed.finish) };
    if (!evaluation) return listedDetails;
    const slab = evaluation.slab;
    const photographed = evaluation.photoCheck?.slab;
    const observed = observedCardKind(evaluation);
    const finish = finishName(finishIn(evaluation.identity?.finish ?? "") ?? finishIn(evaluation.photoCheck?.cardIdentity?.finish ?? ""));
    if (observed === "raw") return { source: "Photo assessed", grade: "Raw", finish };
    if (observed === "graded" && slab?.status === "OK") return { source: "Label checked", grade: namedGrade(slab.grader, slab.grade), finish };
    if (observed === "graded" || photographed?.present || slab) {
        const grade = photographed?.present ? `${namedGrade(photographed.grader, photographed.grade)}${photographed.gradeQualifier ? ` (${photographed.gradeQualifier})` : ""}` : "Grade unreadable";
        return { source: "Slab label unverified", grade, finish };
    }
    return evaluation.photoCheck ? { source: "Photos checked", grade: "Holder unconfirmed", finish } : listedDetails;
}
function finishName(finish: string | null): string {
    return finish === "HOLO" ? "Holo" : finish === "REVERSE_HOLO" ? "Reverse holo" : finish === "NON_HOLO" ? "Non-holo" : "Finish unknown";
}
