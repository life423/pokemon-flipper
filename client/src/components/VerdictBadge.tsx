import type { RatingLevel, Verdict } from "../types";
import { VERDICTS } from "../format";
import styles from "./VerdictBadge.module.css";

export function VerdictBadge({ verdict, large = false }: { verdict: Verdict; large?: boolean }) {
    const { label, tone } = VERDICTS[verdict];

    return (
        <span className={`${styles.badge} ${styles[tone]} ${large ? styles.large : ""}`}>{label}</span>
    );
}

const RATINGS: Record<RatingLevel, { label: string; className: string }> = {
    STRONG: { label: "Strong deal", className: styles.strong },
    GOOD: { label: "Good deal", className: styles.buy },
    THIN: { label: "Thin deal", className: styles.review },
};

export function RatingBadge({ level, large = false }: { level: RatingLevel; large?: boolean }) {
    const { label, className } = RATINGS[level];

    return <span className={`${styles.badge} ${className} ${large ? styles.large : ""}`}>{label}</span>;
}
