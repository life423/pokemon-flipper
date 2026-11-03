import type { PricingResearchUsage } from "../../../shared/pricing-usage.ts";
import styles from "./AiBudgetStatus.module.css";

export function PriceResearchStatus({ usage }: { usage?: PricingResearchUsage | null }) {
    if (!usage) return null;
    const missing = usage.unreportedCreditAttempts;
    const allUnknown = usage.used > 0 && missing === usage.used;
    return <aside className={styles.root} aria-label="Price research for this search" role="status">
        <strong>Price research</strong>
        <span><b>{usage.used} / {usage.limit}</b> requests</span>
        <span>Reported credits <b>{allUnknown ? "Not reported" : usage.reportedCredits.toLocaleString()}</b>{missing > 0 && !allUnknown ? " + unknown" : ""}</span>
        {usage.provider?.remaining != null && <span>Last provider report: <b>{usage.provider.remaining.toLocaleString()}</b> daily credits left</span>}
        {usage.pending + usage.unresolved > 0 && <span><b>{usage.pending + usage.unresolved}</b> requests awaiting full accounting</span>}
        <small>Shared saved responses use no new requests. Credits use your price-data allowance, separately from the 2¢ OpenAI cap.
            {missing > 0 ? ` Credit usage is incomplete for ${missing} ${missing === 1 ? "request" : "requests"}.` : ""}</small>
    </aside>;
}
