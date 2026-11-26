import { HUNT_RECHECK_MS } from "../../../shared/deal-hunt.ts";
import { ApiRequestError, retryDelay } from "../api";
import type { BuyingOption } from "../../../shared/types.ts";

export interface GuidedHuntLeg { id: string; format: BuyingOption; started: number }

// A temporary failure of one independent leg does not discard the other leg.
// Authority, storage and unknown paid outcomes still stop the whole operation.
export function independentHuntFailure(error: unknown): error is ApiRequestError {
    return error instanceof ApiRequestError && error.retryable && error.failureScope !== "search" &&
        (!error.code || ["PROVIDER_TEMPORARY", "PRICE_RESEARCH_UNAVAILABLE", "REVIEW_UNAVAILABLE"].includes(error.code));
}

export async function runGuidedHuntLegs<T>({ legs, signal, run, onResult, onFailure, isOpportunity, continuation }: {
    legs: readonly GuidedHuntLeg[];
    signal: AbortSignal;
    continuation?: {
        next: (result: T) => { at: number; reason: string } | undefined;
        waiting: (leg: GuidedHuntLeg, at: number, reason: string) => void;
        sleep?: typeof retryDelay;
    };
    run: (leg: GuidedHuntLeg, signal: AbortSignal) => Promise<T>;
    onResult: (leg: GuidedHuntLeg, result: T) => void;
    onFailure: (leg: GuidedHuntLeg, error: ApiRequestError) => void;
    isOpportunity: (result: T) => boolean;
}): Promise<{ found: boolean }> {
    signal.throwIfAborted();
    const group = new AbortController();
    const cancel = () => group.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    let found = false;
    let failed = false;
    let failure: unknown;
    try {
        await Promise.all(legs.map(async leg => {
            try {
                while (!group.signal.aborted) {
                    let next: { at: number; reason: string } | undefined;
                    try {
                        const result = await run(leg, group.signal);
                        group.signal.throwIfAborted();
                        onResult(leg, result);
                        if (isOpportunity(result)) {
                            found = true;
                            group.abort(new DOMException("A verified flip was found.", "AbortError"));
                            return;
                        }
                        next = continuation?.next(result);
                    } catch (error) {
                        if (!continuation || !independentHuntFailure(error)) throw error;
                        next = { at: error.retryAt ?? Date.now() + Math.max(error.retryAfterMs, HUNT_RECHECK_MS),
                            reason: "Waiting for the pricing or listings provider" };
                    }
                    if (!next || !continuation) return;
                    continuation.waiting(leg, next.at, next.reason);
                    await (continuation.sleep ?? retryDelay)(Math.max(1000, next.at - Date.now()), group.signal);
                }
            } catch (error) {
                if (group.signal.aborted) return;
                if (independentHuntFailure(error)) onFailure(leg, error);
                else {
                    failed = true;
                    failure = error;
                    group.abort(error);
                }
            }
        }));
        signal.throwIfAborted();
        if (failed) throw failure;
        return { found };
    } finally {
        signal.removeEventListener("abort", cancel);
    }
}
