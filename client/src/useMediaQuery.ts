import { useCallback, useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
    const subscribe = useCallback((changed: () => void) => {
        const media = window.matchMedia(query);
        media.addEventListener("change", changed);
        return () => media.removeEventListener("change", changed);
    }, [query]);
    const snapshot = useCallback(() => window.matchMedia(query).matches, [query]);
    return useSyncExternalStore(subscribe, snapshot, () => false);
}
