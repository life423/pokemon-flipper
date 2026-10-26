import { useRef, type ReactNode } from "react";
import { useDialog } from "../useDialog";
import styles from "./Drawer.module.css";

// A panel that slides in from the right, over the page. It closes on
// Escape, a tap outside it, or its close button, and hands focus back to
// whatever opened it.
export function Drawer({
    open,
    onClose,
    title,
    children,
}: {
    open: boolean;
    onClose: () => void;
    title: string;
    children: ReactNode;
}) {
    const panel = useRef<HTMLDivElement>(null);
    useDialog(open, panel, onClose);

    return (
        <div className={`${styles.root} ${open ? styles.open : ""}`} inert={!open} aria-hidden={!open}>
            <div className={styles.backdrop} onClick={onClose} />
            <div ref={panel} className={styles.panel} role="dialog" aria-modal="true" aria-label={title}>
                <div className={styles.head}>
                    <h2>{title}</h2>
                    <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
                        ×
                    </button>
                </div>
                <div className={styles.body}>{children}</div>
            </div>
        </div>
    );
}
