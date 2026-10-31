import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeVolume } from "../../server/pricing/activity.ts";
import { resaleActivity } from "../../shared/liquidity.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
const now = Date.parse("2026-10-30T18:00:00Z");
const row = { date: "2026-10-29", currency: "USD", variant: "Unlimited Holofoil", graded: false, sales: 6 };
test("observed sales volume stays scoped by printing, currency, raw/graded and the 30-day window", () => {
    const volume = summarizeVolume([row, row, { ...row, date: "2026-10-28", sales: 3 }, { ...row, variant: null }, { ...row, currency: "EUR" }, { ...row, graded: true }, { ...row, date: "2026-01-01" }, { ...row, date: "2027-01-01" }, { ...row, sales: -1 }], row.variant, false, true, now);
    assert.equal(volume.observedSales, 9);
    assert.equal(volume.dailyAverage, .3);
    assert.equal(volume.activeDays, 2);
    const evaluation = { ...cardEvaluation(), marketActivity: volume };
    evaluation.underwriting = null;
    assert.equal(resaleActivity(evaluation, now).recentSales, 9);
    assert.match(resaleActivity(evaluation, now).detail, /All raw conditions combined/);
    assert.equal(resaleActivity(evaluation, now).scope, "BROAD");
});
test("an incomplete page is a lower bound, and no recorded trades is not proof nothing sold", () => {
    const volume = summarizeVolume([], row.variant, true, false, now);
    assert.equal(volume.complete, false);
    assert.match(resaleActivity({ ...cardEvaluation(), underwriting: null, marketActivity: volume }, now).detail, /At least 0/);
});
