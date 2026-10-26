import { useEffect, useRef, type RefObject } from "react";
let scrollLocks = 0;
let previousOverflow = "";

// Shared by the settings and analysis dialogs; overlapping dialogs cannot
// accidentally unlock the page while another is still open.
export function useDialog(open: boolean, panel: RefObject<HTMLElement | null>, onClose: () => void) {
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        if (!open) return;
        const opener = document.activeElement as HTMLElement | null;
        if (scrollLocks++ === 0) { previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; }
        panel.current?.querySelector<HTMLElement>("button")?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") { event.preventDefault(); close.current(); }
            if (event.key !== "Tab") return;
            const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), summary, [tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length > 0);
            const first = items[0]; const last = items.at(-1);
            if (!first) return;
            if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
        };
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("keydown", onKey);
            if (--scrollLocks === 0) document.body.style.overflow = previousOverflow;
            if (opener?.isConnected) opener.focus();
        };
    }, [open, panel]);
}
