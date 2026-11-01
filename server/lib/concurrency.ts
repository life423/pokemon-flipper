// Runs async jobs with at most `max` in flight; the rest wait in line.
export function createLimiter(max: number) {
    let active = 0;
    const waiting: { resume: () => void; priority: number }[] = [];

    return async function limit<T>(job: () => Promise<T>, priority = 0): Promise<T> {
        if (active < max) {
            active += 1;
        } else {
            // A finishing job hands its slot straight to the next in line.
            await new Promise<void>((resume) => waiting.push({ resume, priority }));
        }

        try {
            return await job();
        } finally {
            // Equal priorities retain arrival order. Live-listing work can
            // move ahead of historical evidence without exceeding the ceiling.
            const nextIndex = waiting.reduce((best, item, index) => item.priority > waiting[best].priority ? index : best, 0);
            const next = waiting.splice(nextIndex, 1)[0];

            if (next) next.resume();
            else active -= 1;
        }
    };
}

// items.map(fn), with at most `max` running at once. Results keep order.
export function mapLimit<T, R>(items: T[], max: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const limit = createLimiter(max);

    return Promise.all(items.map((item) => limit(() => fn(item))));
}
