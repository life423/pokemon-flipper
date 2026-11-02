import { setTimeout as delay } from "node:timers/promises";
import { pricingIssue } from "./errors.ts";

export const ASSESSMENT_PRICE_WAIT_MS = 90_000;

// Resume only the failed price stage, not the paid photo/condition assessment.
// A missing comp is a normal result; only typed temporary failures are retried.
export async function withPricingRecovery<T>(
    work: () => Promise<T>,
    { now = () => Date.now(), signal, wait = (ms: number) => delay(ms, undefined, { signal }) }: {
        now?: () => number; signal?: AbortSignal; wait?: (ms: number) => Promise<void>;
    } = {}
): Promise<T> {
    signal?.throwIfAborted();
    try { return await work(); }
    catch (error) {
        signal?.throwIfAborted();
        const issue = pricingIssue(error, now());
        if (!issue || !["RATE_LIMIT", "TEMPORARY"].includes(issue.kind)) throw error;
        const retryAt = Date.parse(issue.retryAt ?? "");
        const delay = Number.isFinite(retryAt) ? Math.max(1000, retryAt - now()) : 30_000;
        if (delay > ASSESSMENT_PRICE_WAIT_MS) throw error;
        await wait(delay);
        signal?.throwIfAborted();
        return work();
    }
}
