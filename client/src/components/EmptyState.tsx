import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";

// Before the first search: what the app is for, and where to start.
export function EmptyState({
    title = "Find your next flip",
    text = "Search for a card above to scan eBay for profitable listings.",
    framed = false,
    children,
}: {
    title?: string;
    text?: string;
    // In a card of its own, among other cards.
    framed?: boolean;
    // What to do next, under the text.
    children?: ReactNode;
}) {
    return (
        <div className={`${styles.empty} ${framed ? styles.framed : ""}`}>

            <h2>{title}</h2>
            <p>{text}</p>
            {children}
        </div>
    );
}
