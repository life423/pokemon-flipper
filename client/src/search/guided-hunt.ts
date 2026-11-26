import { ApiRequestError } from "../api";
import type { BuyingOption } from "../../../shared/types.ts";

export interface GuidedHuntLeg { id: string; format: BuyingOption; started: number }

// A temporary failure of one independent leg does not discard the other leg.
// Authority, storage and unknown paid outcomes still stop the whole operation.
export function independentHuntFailure(error: unknown): error is ApiRequestError {
    return error instanceof ApiRequestError && error.retryable && error.failureScope !== "search" &&
        (!error.code || ["PROVIDER_TEMPORARY", "PRICE_RESEARCH_UNAVAILABLE", "REVIEW_UNAVAILABLE"].includes(error.code));
}

export async function runGuidedHuntLegs<T>({ legs, signal, run, onResult, onFailure, isOpportunity }: {
    legs: readonly GuidedHuntLeg[];
    signal: AbortSignal;
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
                group.signal.throwIfAborted();
                const result = await run(leg, group.signal);
                group.signal.throwIfAborted();
                onResult(leg, result);
                if (isOpportunity(result)) {
                    found = true;
                    group.abort(new DOMException("A verified flip was found.", "AbortError"));
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
