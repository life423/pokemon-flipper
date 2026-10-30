import { applyPricingRetry, canRetryPricing, PRICING_RETRY_LIMIT, type PricingRecoveryProgress } from "../../shared/pricing-retries.ts";
import type { ListingSummary, Targets } from "../../shared/types.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { pricingRetries } from "./pricing-retries.ts";

export const RECOVERY_LISTING_LIMIT = 300;
export const RECOVERY_ATTEMPTS = 2;
export const RECOVERY_WINDOW_MS = 20 * 60_000;

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Search stopped")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
        signal?.addEventListener("abort", abort, { once: true });
    });
}

// Recovery belongs to the user's cancellable search. It uses only trusted
// pricing tickets: no extra eBay search, photos, title reads or AI comp checks.
export async function recoverSearchPricing(
    listings: ListingSummary[],
    options: { signal?: AbortSignal; targets?: Targets; includeOffers?: boolean;
        onListing?: (listing: ListingSummary, snapshotKey: string) => void; onProgress?: (progress: PricingRecoveryProgress) => void } = {},
    deps = { retry: pricingRetries.retry, now: () => Date.now(), wait: waitFor }
): Promise<void> {
    const available = [...new Map(listings.filter((listing) => canRetryPricing(listing, deps.now())).map((listing) => [listing.id, listing])).values()];
    if (!available.length) return;
    const selected = available.slice(0, RECOVERY_LISTING_LIMIT);
    const snapshots = new Map(selected.map((listing) => [listing.id, listing]));
    const attempts = new Map<string, number>();
    const checked = new Set<string>();
    const priced = new Set<string>();
    const deadline = deps.now() + RECOVERY_WINDOW_MS;
    let nextBatchAt = deps.now();
    let batches = 0;
    let note: string | undefined;
    const remaining = () => [...snapshots.values()].filter((listing) => canRetryPricing(listing, deps.now()) && (attempts.get(listing.id) ?? 0) < RECOVERY_ATTEMPTS);
    const progress = (status: PricingRecoveryProgress["status"], retryAt: number | null) => options.onProgress?.({ status,
        total: available.length, pending: [...snapshots.values()].filter((listing) => canRetryPricing(listing, deps.now())).length + available.length - selected.length,
        checked: checked.size, priced: priced.size, retryAt: retryAt === null ? null : new Date(retryAt).toISOString(), note });
    while (remaining().length && deps.now() < deadline && batches < RECOVERY_LISTING_LIMIT * RECOVERY_ATTEMPTS) {
        options.signal?.throwIfAborted();
        const pending = remaining().sort((a, b) => Date.parse(a.screen!.pricingRetry!.retryAt) - Date.parse(b.screen!.pricingRetry!.retryAt));
        const readyAt = Math.max(nextBatchAt, Date.parse(pending[0].screen!.pricingRetry!.retryAt));
        if (readyAt >= deadline) { note = "The provider needs more time than this search's recovery window. Existing results are kept."; break; }
        progress("checking", readyAt);
        if (readyAt > deps.now()) await deps.wait(readyAt - deps.now(), options.signal);
        options.signal?.throwIfAborted();
        const ready = remaining().filter((listing) => Date.parse(listing.screen!.pricingRetry!.retryAt) <= deps.now()).slice(0, PRICING_RETRY_LIMIT);
        if (!ready.length) continue;
        batches++;
        try {
            const response = await deps.retry(ready.map((listing) => listing.screen!.pricingRetry!.ticket), options.targets ?? MONEY_CONFIG.targets, options.includeOffers ?? false, options.signal);
            options.signal?.throwIfAborted();
            for (const result of response.results) {
                const previous = snapshots.get(result.id);
                if (!previous || !ready.some((listing) => listing.id === result.id)) continue;
                const updated = applyPricingRetry(previous, result);
                if (updated === previous) continue;
                snapshots.set(result.id, updated);
                const deferred = updated.screen?.pricingRetry?.attemptsLeft === previous.screen?.pricingRetry?.attemptsLeft;
                if (!deferred || !canRetryPricing(updated, deps.now())) {
                    attempts.set(result.id, (attempts.get(result.id) ?? 0) + 1);
                    checked.add(result.id);
                }
                if (!updated.match && updated.screen?.status !== "UNSCREENED") priced.add(result.id);
                options.onListing?.(updated, result.snapshotKey);
            }
            note = response.note ?? undefined;
            nextBatchAt = deps.now() + 5_000;
        } catch (error) {
            options.signal?.throwIfAborted();
            // A shared busy queue or transport problem gets bounded backoff,
            // not a burst of requests or a failed whole search.
            note = error instanceof Error ? error.message : "Pricing recovery is temporarily unavailable.";
            for (const listing of ready) attempts.set(listing.id, (attempts.get(listing.id) ?? 0) + 1);
            nextBatchAt = deps.now() + 30_000;
        }
    }
    const unresolved = [...snapshots.values()].some((listing) => canRetryPricing(listing, deps.now()));
    if (unresolved || available.length > selected.length) note ??= "Automatic pricing recovery reached its limit for this search. Remaining prices are unresolved; existing results are kept.";
    progress("done", null);
}
