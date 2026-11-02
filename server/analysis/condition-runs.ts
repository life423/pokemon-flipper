import { setTimeout as delay } from "node:timers/promises";
import type { Condition } from "../../shared/types.ts";
import type { Usage } from "./types.ts";
import { evaluationFailure } from "./failure.ts";
export interface ConditionRun { index: number; result: Condition; usage: Usage }

// Save each paid answer as it finishes, even while its sibling is pending or
// work was stopped. Only missing transient opinions can start another request.
export async function completeConditionRuns({ existing = [], run, checkpoint, signal,
    wait = (ms: number) => delay(ms, undefined, { signal }) }: {
    existing?: ConditionRun[];
    run: (index: number) => Promise<{ result: Condition; usage: Usage }>;
    checkpoint: (answers: ConditionRun[]) => Promise<void>;
    signal?: AbortSignal;
    wait?: (ms: number) => Promise<void>;
}): Promise<ConditionRun[]> {
    const answers = [...existing]; let lastError: unknown;
    for (let round = 0; round < 2; round++) {
        signal?.throwIfAborted();
        const missing = [0, 1].filter(index => !answers.some(answer => answer.index === index));
        if (!missing.length) break;
        let checkpointError: unknown;
        let saves = Promise.resolve();
        const results = await Promise.allSettled(missing.map(async index => {
            signal?.throwIfAborted();
            const answer = { index, ...await run(index) };
            answers.push(answer);
            answers.sort((a, b) => a.index - b.index);
            const snapshot = [...answers];
            // Two simultaneous completions must not overwrite a newer checkpoint.
            const saved = saves.then(() => checkpoint(snapshot));
            saves = saved.catch(error => { checkpointError = error; });
            await saved;
            return answer;
        }));
        await saves;
        if (checkpointError) throw checkpointError;
        // All started calls have now had a chance to save before cancellation
        // releases the assessment lock. Never start a retry after Stop.
        signal?.throwIfAborted();
        let pause = 0; let retry = false;
        for (const result of results) {
            if (result.status === "rejected") {
                lastError = result.reason;
                const failure = evaluationFailure(result.reason);
                if (failure.retryable) { retry = true; pause = Math.max(pause, failure.retryAfterMs ?? 3000); }
            }
        }
        if (round > 0 || !retry || pause > 90_000 || answers.length === 2) break;
        await wait(pause);
    }
    if (!answers.length && lastError) throw lastError;
    return answers;
}
