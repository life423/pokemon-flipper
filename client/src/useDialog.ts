import { useEffect, useRef, type RefObject } from "react";
let scrollLocks = 0;
let previousOverflow = "";
const dialogs: { element: HTMLElement; modal: { current: boolean } }[] = [];

// Settings, photos and analysis share dismissal order. Only modal entries own
// scroll locks and focus containment; the desktop inspector stays interactive.
export function useDialog(open: boolean, panel: RefObject<HTMLElement | null>, onClose: () => void,
    { modal = true, returnFocus }: { modal?: boolean; returnFocus?: RefObject<HTMLElement | null> } = {}) {
    const close = useRef(onClose);
    close.current = onClose;
    const mode = useRef(modal);
    mode.current = modal;
    const focusTarget = useRef(returnFocus);
    focusTarget.current = returnFocus;
    // Registration stays stable when a docked inspector becomes a mobile modal.
    // Settings and expanded photos must keep their place above that inspector.
    useEffect(() => {
        if (!open) return;
        const opener = document.activeElement as HTMLElement | null;
        const element = panel.current;
        if (!element) return;
        const entry = { element, modal: mode };
        dialogs.push(entry);
        if (!mode.current) element.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
        const onKey = (event: KeyboardEvent) => {
            if (dialogs.at(-1)?.element !== element) return;
            if (event.key === "Escape") { event.preventDefault(); close.current(); }
            if (!mode.current || event.key !== "Tab") return;
            const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), summary, [tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length > 0);
            const first = items[0]; const last = items.at(-1);
            if (!first) return;
            if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
        };
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("keydown", onKey);
            const restore = mode.current || element.contains(document.activeElement) || document.activeElement === document.body;
            dialogs.splice(dialogs.indexOf(entry), 1);
            if (!restore) return;
            const remaining = dialogs.at(-1);
            const target = focusTarget.current?.current ?? opener;
            if (target?.isConnected && (!remaining?.modal.current || remaining.element.contains(target))) target.focus({ preventScroll: true });
            else remaining?.element.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
        };
    }, [open, panel]);

    useEffect(() => {
        if (!open || !modal) return;
        const element = panel.current;
        if (!element) return;
        if (scrollLocks++ === 0) { previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; }
        if (dialogs.at(-1)?.element === element) element.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
        const containFocus = () => {
            const active = document.activeElement;
            if (element.isConnected && dialogs.at(-1)?.element === element &&
                (!element.contains(active) || active?.matches(":disabled, [hidden], [inert]"))) {
                element.querySelector<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), summary, [tabindex="0"]')?.focus({ preventScroll: true });
            }
        };
        // Refreshing analysis can remove the focused action without emitting
        // focusin. Keep focus in the dialog across loading/result transitions.
        const observer = new MutationObserver(containFocus);
        observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "hidden", "inert"] });
        document.addEventListener("focusin", containFocus);
        return () => {
            document.removeEventListener("focusin", containFocus);
            observer.disconnect();
            if (--scrollLocks === 0) document.body.style.overflow = previousOverflow;
        };
    }, [open, panel, modal]);
}
