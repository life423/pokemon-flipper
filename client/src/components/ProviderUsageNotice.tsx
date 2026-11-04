import type { ProviderUsageSnapshot } from "../../../shared/provider-usage.ts";
import styles from "./ProviderUsageNotice.module.css";

export function ProviderUsageNotice({ usage = [], now = Date.now() }: { usage?: ProviderUsageSnapshot[]; now?: number }) {
    const warnings = usage.filter(item => item.warning !== null && Date.parse(item.resetsAt) > now &&
        Date.parse(item.observedAt) <= now && now - Date.parse(item.observedAt) <= 15 * 60_000);
    if (!warnings.length) return null;
    return <aside className={styles.root} aria-label="Daily API usage warnings">
        {warnings.map(item => {
            const low = item.warning === "LOW" || item.warning === "LOW_AND_FAST";
            const fast = item.warning === "FAST" || item.warning === "LOW_AND_FAST";
            const unit = item.provider === "EBAY" ? "requests" : "credits";
            const minutes = Math.max(1, Math.ceil(item.windowMinutes));
            return <section key={item.provider} className={styles.provider}>
                <strong role="alert">{item.label}: {low && fast ? "daily allowance is low and being used quickly" : low ? "daily allowance is running low" : "daily allowance is being used quickly"}</strong>
                <p>{item.remaining.toLocaleString()} of {item.limit.toLocaleString()} daily {unit} left.
                    {fast && item.usedInWindow !== null ? ` At least ${item.usedInWindow.toLocaleString()} ${unit} used over an observed window of ${minutes} ${minutes === 1 ? "minute" : "minutes"}.` : ""}</p>
                <small>New provider work uses this allowance; saved responses do not. Daily quota protections remain active.</small>
            </section>;
        })}
    </aside>;
}
