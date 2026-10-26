// Concurrent callers share one lookup; completed and failed work is removed.
// Persistent caches still decide whether a later request needs another lookup.
export function createSingleFlight() {
    const pending = new Map<string, Promise<unknown>>();

    return function share<T>(key: string, run: () => Promise<T>): Promise<T> {
        const existing = pending.get(key);
        if (existing) return existing as Promise<T>;

        const request = Promise.resolve().then(run).finally(() => pending.delete(key));
        pending.set(key, request);
        return request;
    };
}
