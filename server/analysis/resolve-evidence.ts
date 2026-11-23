import type { PhotoCheck, PrintingMarks, SlabReading } from "../../shared/types.ts";
import type { IdentityPhotoReading } from "./legacy-evidence.ts";
import { normalizeWords, reprintMarkCode, sameCardNumber, sameSetFamily, type PhotoConfirmation } from "../identity/card-identity.ts";
import { confirmPhotoIdentity } from "../identity/photo-confirmation.ts";
import { normalizeSlabReading } from "../identity/slab-check.ts";
import { cleanPhotoCard } from "../ai/photo-card-schema.ts";

export function printingMarkConflicts(readings: readonly (PrintingMarks | undefined)[]): NonNullable<PrintingMarks["conflicts"]> {
    const conflicts = new Set(readings.flatMap(marks => marks?.conflicts ?? []));
    for (const [field, present, absent] of [["firstEditionStamp", "VISIBLE", "NOT_PRESENT"], ["artBoxShadow", "PRESENT", "ABSENT"]] as const) {
        if (readings.some(marks => marks?.[field] === present) && readings.some(marks => marks?.[field] === absent)) conflicts.add(field);
    }
    const reprints = new Set(readings.map(marks => reprintMarkCode(marks?.reprintMark)).filter(Boolean));
    if (reprints.size > 1) conflicts.add("reprintMark");
    return [...conflicts];
}

export function visibleReprintReading(readings: readonly (PrintingMarks | undefined)[]): string | undefined {
    return readings.map(marks => marks?.reprintMark).find(mark => reprintMarkCode(mark));
}

// Two independent, agreeing readings can fill a gap. Repetition never votes
// away a known disagreement, qualified label, crack or authenticity concern.
export function reconcileIdentityReadings(base: PhotoCheck, passes: IdentityPhotoReading[]): { check: PhotoCheck; confirmation: PhotoConfirmation | undefined; finishConflict: boolean } {
    const readings = [base, ...passes].map(reading => ({ ...reading, slab: normalizeSlabReading(reading.slab), cardIdentity: reading.cardIdentity ? cleanPhotoCard(reading.cardIdentity) : undefined }));
    const merged: PhotoCheck = structuredClone(base);
    merged.slab = normalizeSlabReading(base.slab);
    const slabReadings = readings.map(reading => reading.slab).filter((slab): slab is SlabReading => Boolean(slab?.present));
    if (base.holder === "GRADED_SLAB" && slabReadings.length >= 2) {
        const slab = merged.slab ?? structuredClone(slabReadings[0]);
        for (const field of ["grader", "grade", "certNumber", "gradeQualifier"] as const) {
            const values = slabReadings.map(value => value[field]).filter((value): value is string => Boolean(value));
            const same = values.length >= 2 && values.every(value => normalizeWords(value) === normalizeWords(values[0]));
            if (!slab[field] && same) slab[field] = values[0];
            if (new Set(values.map(normalizeWords)).size > 1) slab.concerns = [...slab.concerns, `Independent label readings disagree on ${field}.`];
        }
        // A newly observed qualifier must never disappear merely because the
        // first reading missed it. Unpriced special labels remain blocked.
        slab.gradeQualifier ??= slabReadings.find(value => value.gradeQualifier)?.gradeQualifier ?? null;
        // Any newly visible risk survives; absent evidence never clears one.
        if (slabReadings.some(value => value.caseCondition === "CRACKED")) slab.caseCondition = "CRACKED";
        if (slabReadings.some(value => value.authenticity === "LIKELY_FAKE")) slab.authenticity = "LIKELY_FAKE";
        else if (slabReadings.some(value => value.authenticity === "POSSIBLE")) slab.authenticity = "POSSIBLE";
        if (slab.concerns.some(value => value.startsWith("Independent label readings disagree"))) slab.authenticity = slab.authenticity === "LIKELY_FAKE" ? "LIKELY_FAKE" : "POSSIBLE";
        if (!slab.labelText && slab.grader && slab.grade) slab.labelText = slabReadings.find(value => value.labelText && value.grader === slab.grader && value.grade === slab.grade)?.labelText ?? null;
        merged.slab = slab;
    }
    if (merged.printingMarks) {
        const marks = readings.map(value => value.printingMarks);
        const conflicts = printingMarkConflicts(marks);
        if (conflicts.length) merged.printingMarks.conflicts = conflicts;
        for (const field of ["firstEditionStamp", "artBoxShadow"] as const) {
            const values = readings.map(value => value.printingMarks?.[field]).filter((value): value is string => Boolean(value && value !== "CANT_TELL"));
            if (merged.printingMarks[field] === "CANT_TELL" && values.length >= 2 && values.every(value => value === values[0])) merged.printingMarks[field] = values[0];
        }
        merged.printingMarks.reprintMark = visibleReprintReading(marks) ??
            marks.map(value => value?.reprintMark).find(mark => mark && mark !== "NONE_SEEN" && mark !== "CANT_TELL") ??
            merged.printingMarks.reprintMark;
    }
    const cards = readings.map(reading => reading.cardIdentity).filter(card => card?.confidence === "HIGH" && card.name && card.set && card.cardNumber);
    const card = cards[0];
    if (!card || cards.length < 2) return { check: merged, confirmation: undefined, finishConflict: false };
    const disagreement = !cards.every(value => value && normalizeWords(value.name) === normalizeWords(card.name) && sameSetFamily(value.set, card.set) && sameCardNumber(value.cardNumber, card.cardNumber));
    const knownFinishes = cards.map(value => value!.finish).filter(value => value !== "UNKNOWN");
    if (disagreement) {
        merged.cardMatch = { verdict: "MISMATCH", problems: [...(base.cardMatch?.problems ?? []), "Independent photo readings disagree about the card identity."] };
        return { check: merged, confirmation: undefined, finishConflict: false };
    }
    const finishConflict = new Set(knownFinishes).size > 1;
    const finish = knownFinishes.length >= 2 && knownFinishes.every(value => value === knownFinishes[0]) ? knownFinishes[0] : "UNKNOWN";
    merged.cardIdentity = { ...card, finish, evidence: [...new Set(cards.flatMap(value => value!.evidence))] };
    merged.printedName = card.name; merged.printedNumber = card.cardNumber;
    const independent = readings.slice(1).find(value => value.cardIdentity?.confidence === "HIGH" && value.cardCount === "ONE" && (finish === "UNKNOWN" || value.cardIdentity.finish === finish));
    const confirmation = independent ? confirmPhotoIdentity({ card: independent.cardIdentity!, cardCount: 1, isStockImage: false, printingMarks: independent.printingMarks!, shows: "Focused independent metadata reading" }, merged, base.holder === "GRADED_SLAB") : undefined;
    return { check: merged, confirmation, finishConflict };
}
