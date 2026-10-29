import { useEffect, useRef, type RefObject } from "react";
let scrollLocks = 0;
let previousOverflow = "";
const dialogs: HTMLElement[] = [];

// Shared by the settings and analysis dialogs; overlapping dialogs cannot
// accidentally unlock the page while another is still open.
export function useDialog(open: boolean, panel: RefObject<HTMLElement | null>, onClose: () => void) {
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        if (!open) return;
        const opener = document.activeElement as HTMLElement | null;
        const element = panel.current;
        if (!element) return;
        dialogs.push(element);
        if (scrollLocks++ === 0) { previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; }
        panel.current?.querySelector<HTMLElement>("button")?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (dialogs.at(-1) !== element) return;
            if (event.key === "Escape") { event.preventDefault(); close.current(); }
            if (event.key !== "Tab") return;
            const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), summary, [tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length > 0);
            const first = items[0]; const last = items.at(-1);
            if (!first) return;
            if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
        };
        const containFocus = () => {
            const active = document.activeElement;
            if (element.isConnected && dialogs.at(-1) === element &&
                (!element.contains(active) || active?.matches(":disabled, [hidden], [inert]"))) {
                element.querySelector<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), summary, [tabindex="0"]')?.focus();
            }
        };
        // Refreshing analysis can remove the focused action without emitting
        // focusin. Keep focus in the dialog across loading/result transitions.
        const observer = new MutationObserver(containFocus);
        observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "hidden", "inert"] });
        document.addEventListener("keydown", onKey);
        document.addEventListener("focusin", containFocus);
        return () => {
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("focusin", containFocus);
            observer.disconnect();
            dialogs.splice(dialogs.indexOf(element), 1);
            if (--scrollLocks === 0) document.body.style.overflow = previousOverflow;
            const remaining = dialogs.at(-1);
            if (opener?.isConnected && (!remaining || remaining.contains(opener))) opener.focus();
            else remaining?.querySelector<HTMLElement>("button")?.focus();
        };
    }, [open, panel]);
}
