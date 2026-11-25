import { CONDITION_NAMES, isRawCondition } from "../../../shared/conditions.ts";
import { displayedRawGrade, observedCardKind } from "../../../shared/photo-evidence.ts";
import type { Evaluation } from "../types";

export function RawCardGrade({ evaluation }: { evaluation: Evaluation }) {
    const estimate = displayedRawGrade(evaluation);
    const condition = evaluation.condition?.rawCondition;
    if (!estimate) return null;
    const grade = estimate.range.likely;
    const playStatus = isRawCondition(condition) ? CONDITION_NAMES[condition] : null;
    if (grade == null && !playStatus) return null;
    const unconfirmed = observedCardKind(evaluation) === null;
    return <p aria-label={unconfirmed ? "Provisional condition assessment" : "Raw card assessment"}>
        {grade != null && <strong>{unconfirmed ? "Provisional grade" : estimate.source === "WEAR" ? "Condition-based grade" : "Estimated grade"} {grade}</strong>}
        {grade != null && playStatus && " · "}{playStatus}
        {grade != null && estimate.confidence === "LOW" && " · Low confidence"}
    </p>;
}
