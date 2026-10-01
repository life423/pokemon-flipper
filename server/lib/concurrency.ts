// Runs async jobs with at most `max` in flight; the rest wait in line.
export function createLimiter(max: number) {
    let active = 0;
    const waiting: (() => void)[] = [];

    return async function limit<T>(job: () => Promise<T>): Promise<T> {
        if (active < max) {
            active += 1;
        } else {
            // A finishing job hands its slot straight to the next in line.
            await new Promise<void>((resolve) => waiting.push(resolve));
        }

        try {
            return await job();
        } finally {
            const next = waiting.shift();

            if (next) next();
            else active -= 1;
        }
    };
}

// items.map(fn), with at most `max` running at once. Results keep order.
export function mapLimit<T, R>(items: T[], max: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const limit = createLimiter(max);

    return Promise.all(items.map((item) => limit(() => fn(item))));
}
