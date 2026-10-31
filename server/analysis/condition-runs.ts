import type { Condition } from "../../shared/types.ts";
import type { Usage } from "./types.ts";
import { evaluationFailure } from "./failure.ts";
export interface ConditionRun { index: number; result: Condition; usage: Usage }

// A failed second opinion must not discard the first paid answer. Retry only
// missing transient work once, checkpointing successful answers before waiting.
export async function completeConditionRuns({ existing = [], run, checkpoint, wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }: {
    existing?: ConditionRun[];
    run: (index: number) => Promise<{ result: Condition; usage: Usage }>;
    checkpoint: (answers: ConditionRun[]) => Promise<void>;
    wait?: (ms: number) => Promise<void>;
}): Promise<ConditionRun[]> {
    const answers = [...existing]; let lastError: unknown;
    for (let round = 0; round < 2; round++) {
        const missing = [0, 1].filter(index => !answers.some(answer => answer.index === index));
        if (!missing.length) break;
        const results = await Promise.allSettled(missing.map(async index => ({ index, ...await run(index) })));
        let pause = 0; let retry = false;
        for (const result of results) {
            if (result.status === "fulfilled") answers.push(result.value);
            else { lastError = result.reason; const failure = evaluationFailure(result.reason); if (failure.retryable) { retry = true; pause = Math.max(pause, failure.retryAfterMs ?? 3000); } }
        }
        await checkpoint(answers);
        if (round > 0 || !retry || pause > 90_000 || answers.length === 2) break;
        await wait(pause);
    }
    if (!answers.length && lastError) throw lastError;
    return answers;
}
