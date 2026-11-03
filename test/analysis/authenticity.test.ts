import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAuthenticity } from "../../server/analysis/authenticity.ts";
import { applyConditionRules } from "../../server/analysis/rules.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import type { Authenticity, Condition } from "../../shared/types.ts";

const limitation = { photoNumber: 1, feature: "PRINTING" as const, observation: "Sleeve glare hides fine text.", expected: "Readable fine text for comparison.", judgment: "PHOTO_LIMITATION" as const };
const suspicious = { photoNumber: 2, feature: "FONTS" as const, observation: "Legible printed name is misspelled in two sharp views.", expected: "The correctly spelled card name.", judgment: "SUSPICIOUS" as const };
function auth(overrides: Partial<Authenticity> = {}): Authenticity { return { concern: "NONE_SEEN", reasons: [], observations: [], limitations: [], ...overrides }; }
function condition(authenticity = auth(), grade = 7): Condition {
    const area = { visibility: "CLEAR" as const, severity: "MINOR" as const, observations: [] };
    return { centering: { ...area }, corners: { ...area }, edges: { ...area }, surface: { ...area }, creases: "NONE_SEEN", rawCondition: "LIGHTLY_PLAYED", gradeRange: { low: grade - 1, likely: grade, high: grade + 1 }, authenticity, confidence: "MEDIUM", limitations: [], summary: "Visible wear." };
}
test("explicit photo limitations are not counterfeit evidence and cannot improve grade coverage", () => {
    const input = condition(auth({ concern: "POSSIBLE", reasons: ["Glare prevents close inspection."], observations: [limitation] }));
    const output = applyConditionRules(input, "LIMITED", { photoCount: 2, closeUps: true })!;
    assert.equal(output.authenticity.concern, "NONE_SEEN");
    assert.deepEqual(output.authenticity.reasons, []);
    assert.ok(output.limitations.includes(limitation.observation));
    assert.equal(output.gradeRange.likely, null);
    assert.equal(output.confidence, "LOW");
    assert.equal(output.rawCondition, input.rawCondition);
    assert.equal(input.authenticity.concern, "POSSIBLE", "saved input is not mutated");
});
test("ordinary wear, normal evolution text and overlays remain separate from suspicious manufacture", () => {
    for (const judgment of ["NORMAL_FEATURE", "CONDITION_DAMAGE", "IDENTITY_DIFFERENCE"] as const) {
        const result = normalizeAuthenticity(auth({ concern: "POSSIBLE", observations: [{ ...limitation, judgment }] }), 2)!;
        assert.equal(result.concern, "NONE_SEEN");
        assert.equal(result.observations![0].judgment, judgment);
    }
});
test("a concrete anomaly remains blocking even when the model's headline says none", () => {
    const output = normalizeAuthenticity(auth({ observations: [suspicious] }), 2)!;
    assert.equal(output.concern, "POSSIBLE");
    assert.match(output.reasons[0], /misspelled.*Expected:/);
    assert.equal(normalizeAuthenticity(auth({ concern: "LIKELY_FAKE", observations: [suspicious] }), 2)!.concern, "LIKELY_FAKE");
});
test("unsupported alerts and invalid photo references are retried rather than silently cleared", () => {
    for (const concern of ["POSSIBLE", "LIKELY_FAKE"] as const) assert.equal(normalizeAuthenticity(auth({ concern, reasons: ["A concern with no supporting observation."] })), null);
    for (const photoNumber of [0, 3, 1.5]) assert.equal(normalizeAuthenticity(auth({ observations: [{ ...suspicious, photoNumber }] }), 2), null);
    assert.equal(normalizeAuthenticity(auth({ observations: [{ ...suspicious, expected: " " }] }), 2), null);
});
test("old reports retain their concern until a new condition assessment supplies structured evidence", () => {
    const legacy: Authenticity = { concern: "POSSIBLE", reasons: ["Cannot inspect stock."] };
    assert.deepEqual(normalizeAuthenticity(legacy), legacy);
});
test("normalization is stable across repeated condition validation", () => {
    const first = applyConditionRules(condition(), "FULL", { photoCount: 2 })!;
    assert.deepEqual(applyConditionRules(first, "FULL", { photoCount: 2 }), first);
});

test("clearing an unsupported authenticity concern never clears a separate identity conflict", () => {
    const e = cardEvaluation();
    e.identity!.status = "NEEDS_REVIEW";
    e.identity!.reasons = ["The title and item details name different releases."];
    e.condition = applyConditionRules(condition(auth({ concern: "POSSIBLE", observations: [{ ...limitation, judgment: "IDENTITY_DIFFERENCE" }] })), "FULL", { closeUps: true, photoCount: 2 });
    assert.equal(e.condition!.authenticity.concern, "NONE_SEEN");
    assert.equal(underwrite(e).verdict, "NEEDS_REVIEW");
});
