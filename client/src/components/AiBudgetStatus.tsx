import type { AiSearchBudget } from "../../../shared/ai-usage.ts";
import styles from "./AiBudgetStatus.module.css";

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 5 });
export const formatAiCost = (usd: number) => usd >= 1 ? dollars.format(usd) : `${Number((usd * 100).toFixed(3))}¢`;

export function AiBudgetStatus({ budget, calls }: { budget: AiSearchBudget | undefined; calls: number }) {
    if (!budget?.searchId || (!budget.configured && budget.capUsd === null)) return null;
    const cap = budget.capUsd;
    return <aside className={styles.root} aria-label="AI spending for this search" role="status">
        <strong>{cap === null ? (budget.paused ? "AI spending · Paused" : "AI spending · Uncapped") : `AI budget: ${formatAiCost(cap)} maximum`}</strong>
        <span>Reported cost <b>{formatAiCost(budget.settledUsd)}</b></span>
        <span>Reserved / unresolved <b>{formatAiCost(budget.heldUsd)}</b></span>
        {cap !== null && <span>Available <b>{formatAiCost(budget.remainingUsd ?? 0)}</b></span>}
        <span>{calls} generation {calls === 1 ? "request" : "requests"}</span>
        <small>Reservations cover maximum output and input charges. Unresolved requests keep their reservation.</small>
    </aside>;
}
