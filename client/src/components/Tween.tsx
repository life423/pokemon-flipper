import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../motion";

const DURATION = 300;
const easeOut = (progress: number) => 1 - Math.pow(1 - progress, 3);

// A number that glides to its new value instead of snapping, so a change
// (new targets, a finished analysis, a growing count) reads as a change.
export function useTween(value: number | null | undefined): number | null {
    const target = value ?? null;
    const [shown, setShown] = useState<number | null>(target);
    const current = useRef<number | null>(target);

    useEffect(() => {
        const from = current.current;

        // No glide when motion is reduced, or while the page is hidden (no frames
        // run there), so the number is right the moment you look.
        if (target === null || from === null || from === target || prefersReducedMotion() || document.hidden) {
            current.current = target;
            setShown(target);
            return;
        }

        const began = performance.now();
        let frame = 0;

        const step = (now: number) => {
            const progress = Math.min(1, (now - began) / DURATION);
            current.current = from + (target - from) * easeOut(progress);
            setShown(current.current);

            if (progress < 1) frame = requestAnimationFrame(step);
        };

        frame = requestAnimationFrame(step);

        return () => cancelAnimationFrame(frame);
    }, [target]);

    return shown;
}

export function Tween({ value, format }: { value: number | null | undefined; format: (value: number | null) => string }) {
    return <>{format(useTween(value))}</>;
}

// Counts, shown as whole numbers while they glide.
export function wholeNumber(value: number | null): string {
    return value === null ? "0" : Math.round(value).toLocaleString();
}
