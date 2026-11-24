import { RAW_CONDITIONS } from "../../shared/conditions.ts";
import type { BoundedReading } from "../ai/bounded-assessment.ts";
import { StorageUnavailableError } from "../storage/config.ts";
import type { BoundedAssessmentMode } from "./bounded-plan.ts";
import { applyConditionRules } from "./rules.ts";

const hasStrings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 8 && value.every(note => typeof note === "string" && note.length <= 1200);
export const invalidReadingMessage = "The bounded photo assessment is incomplete or invalid. Saved evidence was kept; no automatic replacement assessment was authorized.";
export class InvalidBoundedReading extends StorageUnavailableError {
    constructor(readonly reason?: string) { super(invalidReadingMessage); }
}
export function invalidReading(reason?: string): never { throw new InvalidBoundedReading(reason); }
export function validateBoundedReading(value: unknown, photoCount: number, mode: BoundedAssessmentMode = "RAW"): BoundedReading {
    const reading = value as BoundedReading | null;
    const check = reading?.photoCheck;
    if (!reading || !check || !["ONE", "MULTIPLE", "UNKNOWN"].includes(check.cardCount) || !["HIGH", "MEDIUM", "LOW"].includes(check.confidence) ||
        !["SUFFICIENT", "PARTIAL", "INSUFFICIENT"].includes(check.photoSufficiency) || !["NONE", "SLEEVE", "TOPLOADER", "GRADED_SLAB", "OTHER", "UNKNOWN"].includes(check.holder) ||
        !hasStrings(check.missingViews) || !hasStrings(check.problems)) return invalidReading("The response could not establish usable photo coverage for this card.");
    if (!Array.isArray(check.images) || check.images.length !== photoCount) return invalidReading("The response did not account for each supplied photo.");
    if (check.images.some(image => !image || !Number.isInteger(image.number) || image.number < 1 || image.number > photoCount || !["FRONT", "BACK", "FRONT_DETAIL", "BACK_DETAIL", "OTHER"].includes(image.view) ||
        typeof image.usable !== "boolean" || typeof image.isStockImage !== "boolean" || typeof image.obscuresCondition !== "boolean" || !hasStrings(image.issues)) || new Set(check.images.map(image => image.number)).size !== photoCount) return invalidReading("The observations could not be matched to individual photos.");
    const card = check.cardIdentity;
    if (!card || !["HIGH", "MEDIUM", "LOW"].includes(card.confidence) || !["HOLO", "REVERSE_HOLO", "NON_HOLO", "UNKNOWN"].includes(card.finish) ||
        [card.name, card.set, card.cardNumber, card.language].some(value => value !== null && typeof value !== "string") || !hasStrings(card.evidence) || card.confidence === "HIGH" && !card.evidence.length || !check.printingMarks ||
        !["VISIBLE", "NOT_PRESENT", "CANT_TELL"].includes(check.printingMarks.firstEditionStamp) || !["PRESENT", "ABSENT", "CANT_TELL"].includes(check.printingMarks.artBoxShadow) || typeof check.printingMarks.reprintMark !== "string" || !hasStrings(check.printingMarks.evidence) ||
        !check.cardMatch || !["MATCH", "MISMATCH", "CANT_TELL"].includes(check.cardMatch.verdict) || !hasStrings(check.cardMatch.problems)) return invalidReading("The response contained incomplete identity or printing observations.");
    if (check.slab && (typeof check.slab.present !== "boolean" || [check.slab.grader, check.slab.grade, check.slab.gradeQualifier, check.slab.certNumber, check.slab.labelText].some(value => value !== null && typeof value !== "string") ||
        !["INTACT", "SCRATCHED", "CRACKED", "NOT_VISIBLE"].includes(check.slab.caseCondition) || !["NONE_SEEN", "POSSIBLE", "LIKELY_FAKE"].includes(check.slab.authenticity) || !hasStrings(check.slab.concerns) || !hasStrings(check.slab.authenticityEvidence))) return invalidReading("The response contained incomplete observations of the grading label or holder.");
    if (check.holder === "GRADED_SLAB" && !check.slab?.present) return invalidReading("The holder and slab-label observations disagree about whether this card is graded.");
    const condition = reading.condition;
    if (mode === "SLAB_LABEL" && condition !== null) return invalidReading("The slab-label response included a raw grading assessment.");
    if (condition !== null) {
        if (!condition || typeof condition.summary !== "string" || !hasStrings(condition.limitations) || ![...RAW_CONDITIONS, "UNKNOWN"].includes(condition.rawCondition) ||
            !["LOW", "MEDIUM", "HIGH"].includes(condition.confidence) || !["NONE_SEEN", "SUSPECTED", "PRESENT"].includes(condition.creases)) return invalidReading("The response contained incomplete condition or wear observations.");
        for (const area of [condition.centering, condition.corners, condition.edges, condition.surface]) if (!area || !["CLEAR", "PARTIAL", "NOT_VISIBLE"].includes(area.visibility) || !["NONE", "MINOR", "MODERATE", "SEVERE", "UNKNOWN"].includes(area.severity) || !hasStrings(area.observations)) return invalidReading("The response contained incomplete observations of centering, corners, edges or surface wear.");
        const range = condition.gradeRange;
        if (range !== null && (!range || !Number.isInteger(range.low) || !Number.isInteger(range.high) || range.low < 1 || range.high > 10 || range.high < range.low ||
            range.likely !== null && (!Number.isInteger(range.likely) || range.likely < range.low || range.likely > range.high))) return invalidReading("The reported grade and its range must be ordered on the 1–10 scale.");
        if (!condition.authenticity || !hasStrings(condition.authenticity.reasons) || !hasStrings(condition.authenticity.limitations) || !Array.isArray(condition.authenticity.observations) ||
            !applyConditionRules(condition, "FULL", { closeUps: true, photoCount })) return invalidReading("The authenticity assessment could not be reconciled with the observations in the supplied photos.");
    }
    const accepted = structuredClone(reading);
    const binder = accepted.condition?.binderAppearance;
    if (accepted.condition && binder !== undefined && (!binder || ![binder.front, binder.back].every(side => ["CLEAN", "WORN", "UNCLEAR"].includes(side)) ||
        ![binder.frontEvidence, binder.backEvidence].every(note => typeof note === "string" && note.trim().length > 0 && note.length <= 1200))) {
        delete accepted.condition.binderAppearance;
    }
    return accepted;
}
