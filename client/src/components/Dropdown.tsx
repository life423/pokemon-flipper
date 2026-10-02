import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronIcon } from "./Icons";
import styles from "./Dropdown.module.css";

// A labeled control that opens a small menu below it: "Min profit $70".
// The menu closes on a pick (through close), Escape, or a click outside.
export function Dropdown({
    icon,
    label,
    value,
    children,
}: {
    icon: ReactNode;
    label: string;
    value: string;
    children: (close: () => void) => ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;

        const onPointer = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setOpen(false);
        };

        document.addEventListener("pointerdown", onPointer);
        document.addEventListener("keydown", onKey);

        return () => {
            document.removeEventListener("pointerdown", onPointer);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    return (
        <div ref={root} className={styles.root}>
            <button type="button" className={styles.trigger} aria-expanded={open} onClick={() => setOpen((now) => !now)}>
                <span className={styles.icon}>{icon}</span>
                <span className={styles.text}>
                    <span className={styles.label}>{label}</span>
                    <span className={styles.value}>{value}</span>
                </span>
                <ChevronIcon className={styles.chevron} />
            </button>
            <div className={`${styles.menu} ${open ? styles.open : ""}`} inert={!open}>
                {children(() => setOpen(false))}
            </div>
        </div>
    );
}
