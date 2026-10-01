// Collects single requests into batches: up to maxSize at a time, or
// whatever has arrived after maxWaitMs. Each caller gets its own answer.
export function createBatcher<K, V>(
    run: (keys: K[]) => Promise<V[]>,
    { maxSize, maxWaitMs }: { maxSize: number; maxWaitMs: number }
): (key: K) => Promise<V> {
    let pending: { key: K; resolve: (value: V) => void; reject: (error: unknown) => void }[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
        if (timer) clearTimeout(timer);
        timer = null;

        const batch = pending;
        pending = [];

        if (batch.length === 0) return;

        run(batch.map((item) => item.key)).then(
            (values) => batch.forEach((item, index) => item.resolve(values[index])),
            (error) => batch.forEach((item) => item.reject(error))
        );
    };

    return (key: K) =>
        new Promise<V>((resolve, reject) => {
            pending.push({ key, resolve, reject });

            if (pending.length >= maxSize) flush();
            else timer ??= setTimeout(flush, maxWaitMs);
        });
}
