import { useEffect, useState } from "react";

// The current time, refreshed on an interval, for countdowns.
export function useNow(intervalMs: number, deadline?: number): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const id = window.setInterval(() => setNow(Date.now()), intervalMs);
        return () => window.clearInterval(id);
    }, [intervalMs]);

    useEffect(() => {
        if (deadline === undefined) return;
        const id = window.setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now()));
        return () => window.clearTimeout(id);
    }, [deadline]);

    return now;
}
