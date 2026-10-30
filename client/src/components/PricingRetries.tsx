import type { ListingSummary } from "../types";
import { canRetryPricing, PRICING_RETRY_LIMIT } from "../../../shared/pricing-retries.ts";
import { useNow } from "../useNow";
import styles from "./PricingRetries.module.css";
import type { PricingRecoveryProgress } from "../../../shared/pricing-retries.ts";

export function PricingRetries({ listings, analyzed, busy, note, onRetry, onCancel, searching = false, recovery }: {
    listings: ListingSummary[]; analyzed: Set<string>; busy: boolean; note: string;
    onRetry: (tickets: string[]) => void; onCancel: () => void;
    searching?: boolean;
    recovery?: PricingRecoveryProgress | null;
}) {
    const now = useNow(1000);
    const incomplete = listings.filter((listing) => !listing.match && listing.screen?.status === "UNSCREENED" && !analyzed.has(listing.id));
    const eligible = incomplete.filter((listing) => canRetryPricing(listing, now));
    const ready = eligible.filter((listing) => Date.parse(listing.screen!.pricingRetry!.retryAt) <= now).slice(0, PRICING_RETRY_LIMIT);
    const waitingUntil = Math.min(...eligible.map((listing) => Date.parse(listing.screen!.pricingRetry!.retryAt)));
    const seconds = Math.max(0, Math.ceil((waitingUntil - now) / 1000));
    if (!incomplete.length && !note && !busy && !recovery?.note) return null;
    return <section className={styles.panel} aria-label="Incomplete screening">
        {incomplete.length > 0 && <p>{eligible.length > 0 ? `${eligible.length} temporary price ${eligible.length === 1 ? "lookup is" : "lookups are"} ${searching ? "waiting for automatic recovery" : "still unresolved"}. ` : ""}{incomplete.length - eligible.length > 0 ? `${incomplete.length - eligible.length} ${incomplete.length - eligible.length === 1 ? "listing needs" : "listings need"} identity, evidence or price-data review.` : ""}</p>}
        {((eligible.length > 0 && !searching) || busy) && <>
            <div className={styles.actions}>
                <button type="button" onClick={() => onRetry(ready.map((listing) => listing.screen!.pricingRetry!.ticket))} disabled={busy || searching || !ready.length}>{busy ? "Retrying prices…" : searching ? "Retry pricing after search" : ready.length ? `Retry pricing (${ready.length})` : `Retry pricing in ${seconds}s`}</button>
                {busy && <button type="button" onClick={onCancel}>Cancel pricing retries</button>}
            </div>
            {!searching && <p className={styles.hint}>Up to five per batch. Uses saved listing terms and your existing AI limit.</p>}
        </>}
        {note && <p key={note} className={styles.feedback} role="status">{note}</p>}
        {recovery?.note && !note && <p className={styles.hint}>{recovery.note}</p>}
    </section>;
}
