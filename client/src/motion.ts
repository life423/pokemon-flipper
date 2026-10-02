import { flushSync } from "react-dom";

// Motion in this app is short and only explains a change. People who ask
// their system for less motion get none.
export function prefersReducedMotion(): boolean {
    return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// A change you asked for (a sort, a filter), with the cards gliding to their
// new places where the browser supports view transitions.
export function withViewTransition(update: () => void): void {
    const doc = document as Document & { startViewTransition?: (callback: () => void) => unknown };

    if (!doc.startViewTransition || prefersReducedMotion()) {
        update();
        return;
    }

    doc.startViewTransition(() => flushSync(update));
}

// A name the browser can follow across a view transition.
export function transitionName(id: string): string {
    return `card-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
