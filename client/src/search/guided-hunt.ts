import { ApiRequestError, retryDelay } from "../api";
import { HUNT_RECHECK_MS, type DealHuntResponse } from "../../../shared/deal-hunt.ts";
import type { BuyingOption } from "../../../shared/types.ts";

export interface GuidedHuntLeg { id: string; format: BuyingOption; started: number }

// A temporary failure of one independent leg does not discard the other leg.
// Authority, storage and unknown paid outcomes still stop the whole operation.
export function independentHuntFailure(error: unknown): error is ApiRequestError {
    return error instanceof ApiRequestError && error.retryable && error.failureScope !== "search" &&
        (!error.code || ["PROVIDER_TEMPORARY", "PRICE_RESEARCH_UNAVAILABLE", "REVIEW_UNAVAILABLE", "FLIP_CONNECTION", "FLIP_RUN_ACTIVE"].includes(error.code));
}

export async function runGuidedHuntLegs<T extends DealHuntResponse>({ legs, signal, run, onResult, onWaiting, isOpportunity }: {
    legs: readonly GuidedHuntLeg[];
    signal: AbortSignal;
    run: (leg: GuidedHuntLeg, signal: AbortSignal) => Promise<T>;
    onResult: (leg: GuidedHuntLeg, result: T) => void;
    onWaiting: (leg: GuidedHuntLeg, at: number, reason: string) => void;
    isOpportunity: (result: T) => boolean;
}): Promise<T> {
    signal.throwIfAborted();
    if (!legs.length) throw new Error("Choose a listing format.");
    const group = new AbortController();
    const cancel = () => group.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    try {
        return await Promise.race(legs.map(async leg => {
            let reconnectDelay = 2000;
            while (true) {
                group.signal.throwIfAborted();
                let result: T;
                try {
                    result = await run(leg, group.signal);
                } catch (error) {
                    group.signal.throwIfAborted();
                    if (!independentHuntFailure(error)) throw error;
                    const reconnect = error.code === "FLIP_CONNECTION" || error.code === "FLIP_RUN_ACTIVE";
                    const now = Date.now();
                    const next = Math.max(now + (reconnect ? reconnectDelay : HUNT_RECHECK_MS), error.retryAt ?? 0, now + error.retryAfterMs);
                    reconnectDelay = reconnect ? Math.min(60_000, reconnectDelay * 2) : 2000;
                    onWaiting(leg, next, reconnect ? "Reconnecting to the same search." : error.message);
                    await retryDelay(next - Date.now(), group.signal);
                    continue;
                }
                group.signal.throwIfAborted();
                reconnectDelay = 2000;
                onResult(leg, result);
                if (isOpportunity(result)) return result;
                if (result.report.needsAttention) throw new Error(result.report.reason);
                const now = Date.now();
                const next = Number.isSafeInteger(result.nextCheckAt) && result.nextCheckAt! > now
                    ? result.nextCheckAt! : now + HUNT_RECHECK_MS;
                onWaiting(leg, next, result.waitingForQuota ? "Waiting for eBay’s daily allowance." : "No verified flip yet.");
                await retryDelay(next - now, group.signal);
            }
        }));
    } finally {
        group.abort();
        signal.removeEventListener("abort", cancel);
    }
}
