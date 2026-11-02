import type { ReactNode } from "react";
import styles from "../DetailPanel.module.css";

export function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{title}</h3>
            {children}
        </section>
    );
}

export function Pairs({ rows }: { rows: [string, ReactNode][] }) {
    return (
        <dl className={styles.pairs}>
            {rows.map(([key, value]) => (
                <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                </div>
            ))}
        </dl>
    );
}

export function Notes({ items, tone }: { items: string[]; tone?: "good" | "bad" | "muted" }) {
    if (items.length === 0) return null;

    return (
        <ul className={`${styles.notes} ${tone ? styles[tone] : ""}`}>
            {items.map((item) => (
                <li key={item}>{item}</li>
            ))}
        </ul>
    );
}
