import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileIdentityReadings } from "../../server/analysis/resolve-evidence.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import type { IdentityPhotoReading } from "../../server/ai/openai.ts";
import type { PhotoCheck } from "../../shared/types.ts";

function base(): PhotoCheck {
    const check = cardEvaluation().photoCheck!;
    check.cardCount = "ONE";
    check.printingMarks = { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT", reprintMark: "NONE_SEEN", evidence: ["Visible artwork"] };
    check.cardIdentity = { name: "Primeape", set: "Aquapolis", cardNumber: "29/147", language: "English", finish: "UNKNOWN", confidence: "HIGH", evidence: ["Name and number readable"] };
    return check;
}
const reading = (check: PhotoCheck): IdentityPhotoReading => ({ cardIdentity: { ...check.cardIdentity!, finish: "REVERSE_HOLO" }, cardCount: "ONE", printedName: "Primeape", printedNumber: "29/147", printingMarks: check.printingMarks, slab: check.slab });
test("unknown finish needs two agreeing focused readings and unchanged assessments retain their evidence", () => {
    const check = base(); const answer = reading(check);
    assert.equal(reconcileIdentityReadings(check, [answer]).confirmation?.finish, undefined);
    assert.equal(reconcileIdentityReadings(check, [answer, structuredClone(answer)]).confirmation?.finish, "REVERSE_HOLO");
    assert.equal(check.cardIdentity!.finish, "UNKNOWN");
    const conflicting = reading(check); conflicting.cardIdentity!.finish = "HOLO";
    const result = reconcileIdentityReadings(check, [answer, conflicting]);
    assert.equal(result.confirmation?.finish, undefined); assert.equal(result.finishConflict, true);
    assert.notEqual(result.check.cardMatch?.verdict, "MISMATCH", "a finish conflict can receive the remaining bounded pass without claiming another card");
});
test("label gaps can recover while qualifiers, case damage and contradictions remain blocking evidence", () => {
    const check = base(); check.holder = "GRADED_SLAB";
    check.slab = { present: true, grader: "PSA", grade: null, gradeQualifier: null, labelText: null, certNumber: null, caseCondition: "INTACT", authenticity: "NONE_SEEN", concerns: [] };
    const answer = reading(check); answer.slab = { ...check.slab, grade: "7", labelText: "PRIMEAPE REVERSE FOIL PSA 7", certNumber: "123" };
    assert.equal(reconcileIdentityReadings(check, [answer]).check.slab?.grade, null);
    const recovered = reconcileIdentityReadings(check, [answer, structuredClone(answer)]);
    assert.equal(recovered.check.slab?.grade, "7"); assert.equal(recovered.confirmation?.finish, "REVERSE_HOLO");
    const concern = structuredClone(answer); concern.slab!.gradeQualifier = "OC"; concern.slab!.caseCondition = "CRACKED";
    const blocked = reconcileIdentityReadings(check, [answer, concern]);
    assert.equal(blocked.check.slab?.gradeQualifier, "OC"); assert.equal(blocked.check.slab?.caseCondition, "CRACKED");
    concern.slab!.grade = "8";
    assert.equal(reconcileIdentityReadings(check, [answer, concern]).check.slab?.authenticity, "POSSIBLE");
});
