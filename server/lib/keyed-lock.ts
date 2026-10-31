// Serialize related read/paid-work/write operations, not merely the final write.
// Failed work releases its slot; unrelated listings can proceed concurrently.
export function createKeyedLock() {
    const tails = new Map<string, Promise<void>>();
    return function locked<T>(key: string, run: () => Promise<T>): Promise<T> {
        const result = (tails.get(key) ?? Promise.resolve()).then(run);
        const tail = result.then(() => {}, () => {});
        tails.set(key, tail);
        return result.finally(() => { if (tails.get(key) === tail) tails.delete(key); });
    };
}
