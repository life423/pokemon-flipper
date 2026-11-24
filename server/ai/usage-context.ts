import { AsyncLocalStorage } from "node:async_hooks";

export interface AiUsageContext { searchId?: string; listingId?: string; watchBudgetId?: string }
const context = new AsyncLocalStorage<AiUsageContext>();

// Nested listing work inherits its search without changing concurrent requests.
export function withAiUsageContext<T>(value: AiUsageContext, run: () => T): T {
    return context.run({ ...context.getStore(), ...value }, run);
}

export function getAiUsageContext(): AiUsageContext {
    return context.getStore() ?? {};
}


// Watched searches keep separate discovery IDs but share the initiating
// search's provider allowances, including nested per-listing work.
export function getBudgetContext(): AiUsageContext {
    const { searchId, listingId, watchBudgetId } = getAiUsageContext();
    return { searchId: watchBudgetId ?? searchId, listingId };
}

// Dispatch-only cancellation is separate from usage attribution: AbortSignals
// must never enter persisted telemetry or cancel an accepted paid response.
const dispatchContext = new AsyncLocalStorage<AbortSignal | undefined>();
export function withAiDispatchSignal<T>(signal: AbortSignal | undefined, run: () => T): T {
    return dispatchContext.run(signal, run);
}
export function getAiDispatchSignal(): AbortSignal | undefined {
    return dispatchContext.getStore();
}
