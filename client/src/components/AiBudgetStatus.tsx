import type { AiSearchBudget } from "../../../shared/ai-usage.ts";
import styles from "./AiBudgetStatus.module.css";

export const aiCents = (usd: number) => `${Number((usd * 100).toFixed(3))}¢`;

export function AiBudgetStatus({ budget, calls }: { budget: AiSearchBudget | undefined; calls: number }) {
    if (!budget?.searchId || budget.capUsd === null) return null;
    return <aside className={styles.root} aria-label="AI spending for this search" role="status">
        <strong>AI budget: {aiCents(budget.capUsd)} maximum</strong>
        <span>Reported cost <b>{aiCents(budget.settledUsd)}</b></span>
        <span>Reserved / unresolved <b>{aiCents(budget.heldUsd)}</b></span>
        <span>Available <b>{aiCents(budget.remainingUsd ?? 0)}</b></span>
        <span>{calls} generation {calls === 1 ? "request" : "requests"}</span>
        <small>Reservations cover maximum output and input charges. Unresolved requests keep their reservation; saved assessments are reused.</small>
    </aside>;
}
