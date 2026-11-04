// Concurrent consumers share work, but each consumer can stop independently.
// When nobody needs a pending job, stop its future stages. A later consumer
// waits for any accepted paid answer to save before resuming from the cache.
// Already-dispatched provider calls may still finish and save their paid answers.
const activeJobs = new Set<Promise<unknown>>();

// CLI shutdown must wait for the underlying jobs, not their abortable browser
// consumers. This includes accepted-response accounting, SQL claims and caches.
// Waiting never cancels a job, releases a claim or authorizes replacement work.
export async function drainSharedWork({ timeoutMs = 180_000 }: { timeoutMs?: number } = {}): Promise<{ complete: boolean; pending: number }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new RangeError("Shared-work drain needs a nonnegative integer timeout.");
    if (!activeJobs.size) return { complete: true, pending: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    try {
        while (activeJobs.size) {
            const settled = Promise.allSettled([...activeJobs]).then(() => "settled" as const);
            if (await Promise.race([settled, timeout]) === "timeout") return { complete: activeJobs.size === 0, pending: activeJobs.size };
        }
        return { complete: true, pending: 0 };
    } finally { clearTimeout(timer); }
}

export function createSharedWork() {
    interface Job {
        controller: AbortController;
        consumers: Set<object>;
        promise: Promise<unknown>;
        settled: boolean;
    }
    const pending = new Map<string, Job>();

    return function share<T>(key: string, run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (signal?.aborted) return Promise.reject(signal.reason);
        let job = pending.get(key);
        if (!job || job.controller.signal.aborted) {
            const predecessor = job?.promise;
            const controller = new AbortController();
            const created: Job = { controller, consumers: new Set(), promise: Promise.resolve(), settled: false };
            created.promise = Promise.resolve().then(async () => {
                await predecessor?.catch(() => undefined);
                controller.signal.throwIfAborted();
                return run(controller.signal);
            }).finally(() => {
                created.settled = true;
                activeJobs.delete(created.promise);
                if (pending.get(key) === created) pending.delete(key);
            });
            activeJobs.add(created.promise);
            pending.set(key, created);
            job = created;
        }
        const shared = job;
        const consumer = {};
        shared.consumers.add(consumer);
        return new Promise<T>((resolve, reject) => {
            const detach = () => {
                signal?.removeEventListener("abort", stop);
                shared.consumers.delete(consumer);
            };
            const stop = () => {
                detach();
                reject(signal!.reason);
                if (!shared.settled && shared.consumers.size === 0) {
                    shared.controller.abort();
                }
            };
            signal?.addEventListener("abort", stop, { once: true });
            shared.promise.then(value => { detach(); resolve(value as T); }, error => { detach(); reject(error); });
        });
    };
}
