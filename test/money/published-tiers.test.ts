import { test } from "node:test";
import assert from "node:assert/strict";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";
test("published PSA caps are inclusive and available Standard covers cards through $1000", () => {
    for (const [value, tier, fee] of [[1000, "Standard", 59.99], [1000.01, "Priority", 79.99], [1500, "Priority", 79.99], [1500.01, "Express", 199], [2500, "Express", 199], [2500.01, "Super Express", 349], [5000, "Super Express", 349], [10000, "Premier", 599]] as const) {
        const evaluation = cardEvaluation();
        evaluation.rawPricing = null;
        evaluation.condition!.gradeRange = { low: 7, likely: 7, high: 7 };
        evaluation.gradedPricing = { PSA: { status: "PRICED", byGrade: [salesSummary("PSA", 7, [value, value, value])] } };
        const path = underwrite(evaluation, MONEY_CONFIG).paths.find(p => p.grader === "PSA");
        assert.equal(path?.status, "PRICED");
        if (path?.status === "PRICED") { assert.equal(path.tier, tier); assert.equal(path.gradingFee, fee); }
    }
});
