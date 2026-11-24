import assert from "node:assert/strict";
import test from "node:test";
import { runCollectorStrategy, type CollectorStrategyInput } from "../../server/analysis/collector-strategy.ts";
import { createModelExperimentRunner } from "../../server/analysis/model-experiment.ts";
import { getAiUsageContext } from "../../server/ai/usage-context.ts";

const saved = { searchId: "addc12de-bbbe-4f5a-bae0-9a369a92ced2", query: "English PSA 9", asOf: "2026-11-10T12:00:00Z" };

test("the strategy reveals only the selected evidence, stops a priced-out comparison, and reuses its decisions", async () => {
    const cache = new Map<string, unknown>();
    const seen: string[][] = [];
    const choose = createModelExperimentRunner({
        cached: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, value); },
        run: async request => {
            assert.equal(getAiUsageContext().searchId, saved.searchId);
            assert.deepEqual(request.photos, []);
            const { availableActions, observed } = JSON.parse(request.prompt);
            seen.push(Object.keys(observed));
            const action = ["check_sales", "check_listing", "finish"].find(candidate => availableActions.includes(candidate));
            return { result: { action, reason: "Check the next piece of evidence." }, usage: { inputTokens: 16, outputTokens: 8 } };
        },
    });
    let totalCost = 112, labelReads = 0;
    const input: CollectorStrategyInput = { ...saved, checks: {
        check_listing: () => ({ activeAtCapture: true, totalCost }),
        check_sales: () => ({ estimate: 100, matchedCount: 4 }),
        check_label: () => { labelReads++; return { matched: true }; },
    } };
    const first = await runCollectorStrategy(input, undefined, choose);
    assert.deepEqual(first.steps.map(step => step.action), ["check_sales", "check_listing", "finish"]);
    assert.deepEqual(seen, [[], ["check_sales"], ["check_sales", "check_listing"]]);
    assert.equal(labelReads, 0);
    const replay = await runCollectorStrategy(input, undefined, choose);
    assert.ok(replay.steps.every(step => step.reused));
    assert.equal(seen.length, 3);

    totalCost = 94;
    const changed = await runCollectorStrategy(input, undefined, choose);
    assert.deepEqual(changed.steps.map(step => step.action), ["check_sales", "check_listing", "check_label"]);
    assert.equal(changed.steps.at(-1)?.chosenBy, "required", "a possible buy still needs the available identity check");
    assert.equal(labelReads, 1);
    assert.equal(seen.length, 3, "a mandatory remaining check needs no additional model decision");
});

test("a model action outside the offered saved-evidence menu cannot dispatch a check or repurchase a response", async () => {
    const cache = new Map<string, unknown>(); let calls = 0;
    const choose = createModelExperimentRunner({
        cached: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, value); },
        run: async () => { calls++; return { result: { action: "submit_offer", reason: "Skip verification." }, usage: { inputTokens: 8, outputTokens: 5 } }; },
    });
    const fail = () => assert.fail("No evidence reader should have been invoked");
    const input = { ...saved, checks: { check_listing: fail, check_sales: fail } };
    await assert.rejects(runCollectorStrategy(input, undefined, choose), /invalid/);
    await assert.rejects(runCollectorStrategy(input, undefined, choose), /invalid/);
    assert.equal(calls, 1);
});
