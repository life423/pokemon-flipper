import { analysisConcurrency, canAutoAnalyze } from "../../shared/analysis.ts";
import { compareAnalysisPriority } from "../../shared/analysis-priority.ts";
import { englishListingEligible } from "../../shared/card-language.ts";
import { matchesListingFilters, type ListingFilters } from "../../shared/listing-filters.ts";
import { BOUNDED_AUTO_CONCURRENCY } from "../../shared/research-policy.ts";
import type { Evaluation, ListingSummary, Targets } from "../../shared/types.ts";

export interface BenchmarkFailure { code?: string; error: string; retryable?: boolean }
export interface BenchmarkQueueResult {
    admitted: string[];
    evaluations: Record<string, Evaluation>;
    errors: Record<string, string>;
    failures: Record<string, BenchmarkFailure>;
    otherLanguage: string[];
    stopped: BenchmarkFailure | null;
    waiting: string[];
}

// Diagnostic reproduction of the client queue, with no automatic network
// retry. The production evaluator still owns caching, reservations and pricing.
// Keep accepted in-flight work on budget denial; never restart with a new ID.
export async function runBenchmarkQueue(listings: ListingSummary[], {
    filters, targets, signal, evaluate, failureOf, assertTransport, onUpdate,
}: {
    filters: ListingFilters;
    targets: Targets;
    signal: AbortSignal;
    evaluate: (listing: ListingSummary, signal: AbortSignal) => Promise<Evaluation>;
    failureOf: (error: unknown) => BenchmarkFailure;
    assertTransport: () => void;
    onUpdate?: (result: BenchmarkQueueResult) => Promise<void>;
}): Promise<BenchmarkQueueResult> {
    const waiting = listings.filter(listing => englishListingEligible(listing) && matchesListingFilters(listing, filters) && canAutoAnalyze(listing))
        .sort((a, b) => compareAnalysisPriority(a, b, targets));
    const result: BenchmarkQueueResult = { admitted: [], evaluations: {}, errors: {}, failures: {}, otherLanguage: [], stopped: null, waiting: waiting.map(listing => listing.id) };
    const active = new Set<Promise<void>>();
    const controllers = new Set<AbortController>();
    const outcomes: boolean[] = [];
    let next = 0;
    const checkTransport = () => {
        try { assertTransport(); }
        catch (error) { result.stopped ??= { code: "DIAGNOSTIC_TRANSPORT_LIMIT", error: error instanceof Error ? error.message : "Diagnostic transport stopped." }; }
    };
    const start = (listing: ListingSummary) => {
        const controller = new AbortController();
        controllers.add(controller);
        const workSignal = AbortSignal.any([signal, controller.signal]);
        result.admitted.push(listing.id);
        const work = (async () => {
            try {
                workSignal.throwIfAborted();
                result.evaluations[listing.id] = await evaluate(listing, workSignal);
                outcomes.push(true);
            } catch (error) {
                const failure = failureOf(error);
                result.failures[listing.id] = failure;
                const wideStop = ["AI_BUDGET", "AI_PAUSED", "AI_CREDITS", "STORAGE_UNAVAILABLE"].includes(failure.code ?? "");
                if (failure.code === "OTHER_LANGUAGE") result.otherLanguage.push(listing.id);
                else if (!wideStop && !workSignal.aborted) { result.errors[listing.id] = failure.error; outcomes.push(false); }
                if (wideStop) {
                    result.stopped ??= failure;
                    if (failure.code !== "AI_BUDGET") for (const other of controllers) if (other !== controller) other.abort();
                }
            } finally {
                controllers.delete(controller);
                outcomes.splice(0, Math.max(0, outcomes.length - 8));
                checkTransport();
            }
        })();
        active.add(work);
        void work.then(() => active.delete(work));
    };
    while (active.size || next < waiting.length && !result.stopped && !signal.aborted) {
        checkTransport();
        const slots = Math.min(BOUNDED_AUTO_CONCURRENCY, analysisConcurrency(waiting.length - next + active.size, outcomes));
        while (!result.stopped && !signal.aborted && next < waiting.length && active.size < slots) start(waiting[next++]);
        if (!active.size) break;
        await Promise.race(active);
        result.waiting = waiting.slice(next).map(listing => listing.id);
        await onUpdate?.(result);
    }
    if (signal.aborted) result.stopped ??= { code: "DIAGNOSTIC_CANCELLED", error: "The diagnostic deadline or Stop prevented new work." };
    result.waiting = waiting.slice(next).map(listing => listing.id);
    return result;
}
