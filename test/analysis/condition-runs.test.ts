import { test } from "node:test";
import assert from "node:assert/strict";
import { completeConditionRuns } from "../../server/analysis/condition-runs.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { ProviderError } from "../../server/lib/http.ts";
import { evaluationFailure } from "../../server/analysis/failure.ts";

test("a transient failed opinion retries only its missing slot after saving the successful paid answer", async () => {
    const calls: number[] = [], checkpoints: number[][] = []; const waits: number[] = [];
    const results = await completeConditionRuns({ run: async index => { calls.push(index); if (index === 1 && calls.filter(value => value === 1).length === 1) throw new ProviderError("network timeout"); return { result: cardEvaluation().condition!, usage: { inputTokens: 1, outputTokens: 1 } }; },
        checkpoint: async answers => { checkpoints.push(answers.map(answer => answer.index)); }, wait: async ms => { waits.push(ms); } });
    assert.deepEqual(calls, [0, 1, 1]); assert.deepEqual(checkpoints[0], [0]); assert.equal(results.length, 2); assert.equal(waits.length, 1);
});
test("a saved partial assessment resumes the missing opinion; permanent failures retain the completed opinion", async () => {
    const existing = [{ index: 0, result: cardEvaluation().condition!, usage: { inputTokens: 1, outputTokens: 1 } }]; let calls = 0;
    const results = await completeConditionRuns({ existing, run: async index => { calls++; assert.equal(index, 1); throw Object.assign(new Error("invalid key"), { status: 401 }); }, checkpoint: async () => {} });
    assert.equal(results.length, 1); assert.equal(calls, 1); assert.equal(evaluationFailure(Object.assign(new Error("key"), { status: 401 })).retryable, false);
});


test("each successful opinion checkpoints before its sibling finishes; final order stays stable", async () => {
    let finish!: () => void, saved!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const firstSaved = new Promise<void>(resolve => { saved = resolve; });
    const checkpoints: number[][] = [];
    const result = completeConditionRuns({ run: async index => {
        if (index === 0) await pending;
        return { result: cardEvaluation().condition!, usage: { inputTokens: 1, outputTokens: 1 } };
    }, checkpoint: async answers => { checkpoints.push(answers.map(answer => answer.index)); saved(); } });
    await firstSaved;
    assert.deepEqual(checkpoints, [[1]], "the already paid answer saves while the other call is pending");
    finish();
    assert.deepEqual((await result).map(answer => answer.index), [0, 1]);
    assert.deepEqual(checkpoints, [[1], [0, 1]]);
});

test("Stop keeps accepted condition answers and prevents a missing-opinion retry", async () => {
    const stopped = new AbortController(); const calls: number[] = [], checkpoints: number[][] = [];
    let finish!: () => void, saved!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const firstSaved = new Promise<void>(resolve => { saved = resolve; });
    const result = completeConditionRuns({ signal: stopped.signal,
        run: async index => {
            calls.push(index);
            if (index === 1) { await pending; throw new ProviderError("network timeout"); }
            return { result: cardEvaluation().condition!, usage: { inputTokens: 1, outputTokens: 1 } };
        }, checkpoint: async answers => { checkpoints.push(answers.map(answer => answer.index)); saved(); },
        wait: async () => { assert.fail("a stopped assessment must not wait to retry"); },
    });
    await firstSaved;
    stopped.abort(); finish();
    await assert.rejects(result, { name: "AbortError" });
    assert.deepEqual(calls, [0, 1]); assert.deepEqual(checkpoints, [[0]]);
});
