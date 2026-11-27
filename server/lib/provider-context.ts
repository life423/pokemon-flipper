import { AsyncLocalStorage } from "node:async_hooks";

export interface ProviderContext { searchId?: string; listingId?: string; watchBudgetId?: string }
const context = new AsyncLocalStorage<ProviderContext>();

// Nested listing work inherits its search without changing concurrent requests.
export function withProviderContext<T>(value: ProviderContext, run: () => T): T {
    return context.run({ ...context.getStore(), ...value }, run);
}

export function getProviderContext(): ProviderContext {
    return context.getStore() ?? {};
}


// Watched searches keep separate discovery IDs but share the initiating
// search's provider allowances, including nested per-listing work.
export function getBudgetContext(): ProviderContext {
    const { searchId, listingId, watchBudgetId } = getProviderContext();
    return { searchId: watchBudgetId ?? searchId, listingId };
}
