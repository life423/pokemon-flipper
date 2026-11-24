import { RAW_CONDITIONS } from "../../shared/conditions.ts";
import type { BoundedReading } from "../ai/bounded-assessment.ts";
import { StorageUnavailableError } from "../storage/config.ts";
import type { BoundedAssessmentMode } from "./bounded-plan.ts";
import { applyConditionRules } from "./rules.ts";

const hasStrings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 8 && value.every(note => typeof note === "string" && note.length <= 1200);
export function invalidReading(): never { throw new StorageUnavailableError("The bounded photo assessment is incomplete or invalid. Saved evidence was kept; no automatic replacement assessment was authorized."); }
export function validateBoundedReading(value: unknown, photoCount: number, mode: BoundedAssessmentMode | "CAMERA" = "RAW"): BoundedReading {
    const reading = value as BoundedReading | null;
    const check = reading?.photoCheck;
    if (!reading || !check || !["ONE", "MULTIPLE", "UNKNOWN"].includes(check.cardCount) || !["HIGH", "MEDIUM", "LOW"].includes(check.confidence) ||
        !["SUFFICIENT", "PARTIAL", "INSUFFICIENT"].includes(check.photoSufficiency) || !["NONE", "SLEEVE", "TOPLOADER", "GRADED_SLAB", "OTHER", "UNKNOWN"].includes(check.holder) ||
        !Array.isArray(check.images) || check.images.length !== photoCount || !hasStrings(check.missingViews) || !hasStrings(check.problems)) return invalidReading();
    if (check.images.some(image => !image || !Number.isInteger(image.number) || image.number < 1 || image.number > photoCount || !["FRONT", "BACK", "FRONT_DETAIL", "BACK_DETAIL", "OTHER"].includes(image.view) ||
        typeof image.usable !== "boolean" || typeof image.isStockImage !== "boolean" || typeof image.obscuresCondition !== "boolean" || !hasStrings(image.issues)) || new Set(check.images.map(image => image.number)).size !== photoCount) return invalidReading();
    const card = check.cardIdentity;
    if (!card || !["HIGH", "MEDIUM", "LOW"].includes(card.confidence) || !["HOLO", "REVERSE_HOLO", "NON_HOLO", "UNKNOWN"].includes(card.finish) ||
        [card.name, card.set, card.cardNumber, card.language].some(value => value !== null && typeof value !== "string") || !hasStrings(card.evidence) || card.confidence === "HIGH" && !card.evidence.length || !check.printingMarks ||
        !["VISIBLE", "NOT_PRESENT", "CANT_TELL"].includes(check.printingMarks.firstEditionStamp) || !["PRESENT", "ABSENT", "CANT_TELL"].includes(check.printingMarks.artBoxShadow) || typeof check.printingMarks.reprintMark !== "string" || !hasStrings(check.printingMarks.evidence) ||
        !check.cardMatch || !["MATCH", "MISMATCH", "CANT_TELL"].includes(check.cardMatch.verdict) || !hasStrings(check.cardMatch.problems)) return invalidReading();
    if (check.slab && (typeof check.slab.present !== "boolean" || [check.slab.grader, check.slab.grade, check.slab.gradeQualifier, check.slab.certNumber, check.slab.labelText].some(value => value !== null && typeof value !== "string") ||
        !["INTACT", "SCRATCHED", "CRACKED", "NOT_VISIBLE"].includes(check.slab.caseCondition) || !["NONE_SEEN", "POSSIBLE", "LIKELY_FAKE"].includes(check.slab.authenticity) || !hasStrings(check.slab.concerns) || !hasStrings(check.slab.authenticityEvidence))) return invalidReading();
    if (check.holder === "GRADED_SLAB" && !check.slab?.present) return invalidReading();
    const condition = reading.condition;
    if (mode === "SLAB_LABEL" && condition !== null) return invalidReading();
    if (condition !== null) {
        if (!condition || typeof condition.summary !== "string" || !hasStrings(condition.limitations) || ![...RAW_CONDITIONS, "UNKNOWN"].includes(condition.rawCondition) ||
            !["LOW", "MEDIUM", "HIGH"].includes(condition.confidence) || !["NONE_SEEN", "SUSPECTED", "PRESENT"].includes(condition.creases)) return invalidReading();
        for (const area of [condition.centering, condition.corners, condition.edges, condition.surface]) if (!area || !["CLEAR", "PARTIAL", "NOT_VISIBLE"].includes(area.visibility) || !["NONE", "MINOR", "MODERATE", "SEVERE", "UNKNOWN"].includes(area.severity) || !hasStrings(area.observations)) return invalidReading();
        const range = condition.gradeRange;
        if (range !== null && (!range || !Number.isInteger(range.low) || !Number.isInteger(range.high) || range.low < 1 || range.high > 10 || range.high < range.low || (mode !== "CAMERA" && range.high - range.low > 2) ||
            range.likely !== null && (!Number.isInteger(range.likely) || range.likely < range.low || range.likely > range.high))) return invalidReading();
        if (!condition.authenticity || !hasStrings(condition.authenticity.reasons) || !hasStrings(condition.authenticity.limitations) || !Array.isArray(condition.authenticity.observations) ||
            !applyConditionRules(condition, "FULL", { closeUps: true, photoCount })) return invalidReading();
    }
    return structuredClone(reading);
}
