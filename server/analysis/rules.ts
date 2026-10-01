import { CONDITION_AREAS as AREAS, RAW_CONDITIONS } from "../../shared/conditions.ts";
import type { Condition, PhotoCheck, PhotoReport, SetAsideAnswer } from "../../shared/types.ts";
import type { GradingMode } from "./types.ts";

// Code-enforced rules on the model's answers. The model reports what it
// sees; these decide how much grading the evidence allows, and anything
// missing or unexpected fails closed.


// Risk order for picking the more cautious answer. Anything the
// table doesn't know ranks as the riskiest, so surprises fail closed.
const AUTHENTICITY_RISK = ["NONE_SEEN", "POSSIBLE", "LIKELY_FAKE"];
const CREASE_RISK = ["NONE_SEEN", "SUSPECTED", "PRESENT"];
const RAW_CONDITION_RISK = [...RAW_CONDITIONS, "UNKNOWN"];

function riskOf(order: readonly string[], value: string): number {
    const index = order.indexOf(value);
    return index === -1 ? order.length : index;
}

// Returns the more cautious of two condition answers. A red flag in
// either one wins first (authenticity, then creases), then the lower
// grade range, then the worse raw condition. Ties keep the first.
export function moreCautious(a: Condition, b: Condition): Condition {
    const likelyOf = (answer: Condition) => answer.gradeRange.likely ?? 0;

    const comparisons = [
        riskOf(AUTHENTICITY_RISK, b.authenticity.concern) -
            riskOf(AUTHENTICITY_RISK, a.authenticity.concern),
        riskOf(CREASE_RISK, b.creases) - riskOf(CREASE_RISK, a.creases),
        a.gradeRange.low - b.gradeRange.low,
        likelyOf(a) - likelyOf(b),
        a.gradeRange.high - b.gradeRange.high,
        riskOf(RAW_CONDITION_RISK, b.rawCondition) -
            riskOf(RAW_CONDITION_RISK, a.rawCondition),
    ];

    for (const difference of comparisons) {
        if (difference > 0) return b;
        if (difference < 0) return a;
    }

    return a;
}

export function summarizeAnswer(answer: Condition): SetAsideAnswer {
    return {
        gradeRange: answer.gradeRange,
        rawCondition: answer.rawCondition,
        authenticity: answer.authenticity.concern,
    };
}

const CLOSE_UP_VIEWS = ["FRONT_DETAIL", "BACK_DETAIL"];

const NO_CLOSE_UPS =
    "No close-up photos, so fine surface flaws like holo scratches can't be ruled out.";

export function isClearPhoto(photo: PhotoReport): boolean {
    return photo.usable && !photo.isStockImage;
}

export function hasCloseUps(photoCheck: Pick<PhotoCheck, "images">): boolean {
    return photoCheck.images.some(
        (photo) => isClearPhoto(photo) && CLOSE_UP_VIEWS.includes(photo.view)
    );
}

// Code-enforced rules on the photo check. Drops reports for photos
// that don't exist or were already reported, and never allows high
// confidence without a close-up.
export function applyPhotoCheckRules(photoCheck: PhotoCheck, photoCount: number): PhotoCheck {
    const seen = new Set<number>();

    const images = photoCheck.images.filter((photo) => {
        const valid =
            Number.isInteger(photo.number) &&
            photo.number >= 1 &&
            photo.number <= photoCount &&
            !seen.has(photo.number);

        seen.add(photo.number);
        return valid;
    });

    const checked = { ...photoCheck, images };

    if (!hasCloseUps(checked) && checked.confidence === "HIGH") {
        checked.confidence = "MEDIUM";
    }

    return checked;
}

// The model reports what it sees. These rules, not the model,
// decide how much grading the evidence allows. Anything missing
// or unexpected fails closed.
export function getGradingMode(photoCheck: PhotoCheck): { mode: GradingMode; reasons: string[] } {
    const clearPhotos = photoCheck.images.filter(isClearPhoto);
    const hasView = (view: string) => clearPhotos.some((photo) => photo.view === view);

    const blockedReasons: string[] = [];

    if (photoCheck.cardCount !== "ONE") {
        blockedReasons.push("The listing doesn't show exactly one card.");
    }
    if (photoCheck.holder === "GRADED_SLAB") {
        blockedReasons.push("The card is already graded.");
    }
    if (!hasView("FRONT")) {
        blockedReasons.push("No usable photo shows the front.");
    }
    // The model's overall verdict only counts when it rules the
    // photos out. "Partial" is a borderline call that flips between
    // runs, so full versus limited comes from the concrete facts below.
    if (!["SUFFICIENT", "PARTIAL"].includes(photoCheck.photoSufficiency)) {
        blockedReasons.push("The photos aren't good enough to judge condition.");
    }

    if (blockedReasons.length > 0) {
        return { mode: "BLOCKED", reasons: blockedReasons };
    }

    const limitedReasons: string[] = [];

    if (!hasView("BACK")) {
        limitedReasons.push("No usable photo shows the back.");
    }
    if (photoCheck.confidence === "LOW") {
        limitedReasons.push("The photo check has low confidence.");
    }
    if (photoCheck.images.some((photo) => photo.isStockImage)) {
        limitedReasons.push("Some photos are stock images, not this copy.");
    }
    if (photoCheck.holder !== "NONE") {
        limitedReasons.push("A sleeve or holder may hide edges and surface.");
    }

    const mode: GradingMode = limitedReasons.length > 0 ? "LIMITED" : "FULL";

    // A note, not a downgrade: front and back photos alone still
    // get graded, just without a clean bill for the surface.
    const notes = hasCloseUps(photoCheck) ? [] : [NO_CLOSE_UPS];

    return { mode, reasons: [...limitedReasons, ...notes] };
}

function isGrade(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10;
}

// Code-enforced rules on the condition report. Returns null when
// the grade range is broken, since there's no safe way to repair it.
export function applyConditionRules(
    assessment: Condition,
    gradingMode: GradingMode,
    { closeUps = false }: { closeUps?: boolean } = {}
): Condition | null {
    const condition = structuredClone(assessment);

    // Whole-card photos can show a surface flaw, but they can't
    // prove there isn't one. A visible defect still counts.
    if (!closeUps) {
        if (condition.surface.visibility === "CLEAR") {
            condition.surface.visibility = "PARTIAL";
        }
        if (condition.surface.severity === "NONE") {
            condition.surface.severity = "UNKNOWN";
        }
        condition.limitations = [...condition.limitations, NO_CLOSE_UPS];
    }

    // An area no photo shows has unknown severity, whatever the model said.
    for (const area of AREAS) {
        if (condition[area].visibility === "NOT_VISIBLE") {
            condition[area].severity = "UNKNOWN";
        }
    }

    const { low, likely, high } = condition.gradeRange;

    const validRange =
        isGrade(low) &&
        isGrade(high) &&
        low <= high &&
        (likely === null || (isGrade(likely) && low <= likely && likely <= high));

    if (!validRange) {
        return null;
    }

    // Limited evidence never names a single grade or claims confidence.
    if (gradingMode === "LIMITED") {
        condition.gradeRange.likely = null;
        condition.confidence = "LOW";
    }

    // High confidence needs every area clearly visible.
    const allClear = AREAS.every(
        (area) => condition[area].visibility === "CLEAR"
    );

    if (!allClear && condition.confidence === "HIGH") {
        condition.confidence = "MEDIUM";
    }

    return condition;
}
