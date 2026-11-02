// Concurrent consumers share work, but each consumer can stop independently.
// When nobody needs a pending job, stop its future stages. A later consumer
// waits for any accepted paid answer to save before resuming from the cache.
// Already-dispatched provider calls may still finish and save their paid answers.
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
                if (pending.get(key) === created) pending.delete(key);
            });
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
