import { useEffect, useMemo, useRef, useState } from "react";
import { CONDITION_NAMES } from "../../../shared/conditions.ts";
import { cents } from "../../../shared/money/cents.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../../shared/search-diagnostic.ts";
import type { ListingSummary, SearchIntent } from "../../../shared/types.ts";
import type { AnalysisState } from "../analysis-state.ts";
import { resolveListingLink } from "../api";
import { dollars } from "../format";
import { artworkCounterpart, binderFind, cheaperArtwork, collectorCopies, comparableArtwork, refreshedCollectorQuote, type CollectorCopy } from "../search/collector-finds.ts";
import styles from "./BestCurrentBuy.module.css";

function description(copy: CollectorCopy) {
    const card = copy.identity;
    const printing = card.printingLabel || card.printing.toLowerCase().replaceAll("_", " ");
    const condition = copy.rawCondition ? CONDITION_NAMES[copy.rawCondition] : copy.quality;
    return `${card.name} · ${card.set} ${card.cardNumber} · ${printing} · ${condition}`;
}

export function CollectorFinds({ listings, analyses, intent, now, ready, searchRunId, searchQuery, onOpen, onSearch }: {
    listings: ListingSummary[]; analyses: Record<string, AnalysisState>; intent?: SearchIntent | null;
    searchRunId?: string | null; searchQuery?: string;
    now: number; ready: boolean; onOpen: (id: string) => void; onSearch: (query: string) => void;
}) {
    const [selection, setSelection] = useState<{ original: CollectorCopy; query: string } | null>(null);
    const [quoteIssue, setQuoteIssue] = useState("");
    const attemptedRun = useRef<string | null>(null);
    const comparison = selection && selection.query === searchQuery ? selection.original : null;
    const copies = useMemo(() => ready ? collectorCopies(listings, analyses, intent, now) : [], [ready, listings, analyses, intent, now]);
    const binder = binderFind(copies);
    const anchor = comparison ?? copies.find(copy => artworkCounterpart(copy.identity));
    const other = anchor && artworkCounterpart(anchor.identity);
    const alternative = comparison && cheaperArtwork(comparison, copies, now);
    const expired = comparison && now - Date.parse(comparison.checkedAt) >= BEST_BUY_TERMS_MAX_AGE_MS;
    const matched = !!(comparison && comparableArtwork(comparison, copies));
    const refreshKey = expired && matched && ready && comparison && searchRunId ? searchRunId + comparison.id : null;

    useEffect(() => {
        if (selection && selection.query !== searchQuery) setSelection(null);
    }, [selection, searchQuery]);

    useEffect(() => {
        if (!refreshKey || !comparison || !searchRunId || attemptedRun.current === refreshKey) return;
        const controller = new AbortController();
        void Promise.resolve().then(async () => {
            if (controller.signal.aborted) return;
            attemptedRun.current = refreshKey;
            try {
                const listing = await resolveListingLink(comparison.id, controller.signal, searchRunId, true);
                if (controller.signal.aborted) return;
                const original = refreshedCollectorQuote(comparison, listing, Date.now());
                if (original) {
                    setSelection(prev => prev?.original === comparison ? { ...prev, original } : prev);
                    setQuoteIssue("The refreshed quote has expired.");
                } else setQuoteIssue("The original listing changed or its delivered price is unavailable.");
            } catch {
                if (!controller.signal.aborted) setQuoteIssue("The original delivered price could not be refreshed.");
            }
        });
        return () => controller.abort();
    }, [refreshKey, comparison, searchRunId]);

    if (!binder && !other) return null;

    return <>
        {binder && <section className={styles.card} aria-label="Binder copy comparison">
            <div className={styles.heading}><h2>Clean-front binder copy</h2><span className={styles.badge}>Save {dollars(binder.saving)}</span></div>
            <h3>{description(binder.candidate)}</h3>
            <p>{dollars(binder.candidate.total)} including shipping and estimated tax. The lowest checked cleaner copy of this printing is {dollars(binder.cleaner.total)}.</p>
            <div className={styles.binderPhotos}>
                <figure><img src={binder.candidate.front} alt="Seller’s photo of the card front" loading="lazy" />
                    <figcaption><strong>Front</strong> {binder.candidate.binder!.frontEvidence}</figcaption></figure>
                <figure><img src={binder.candidate.back} alt="Seller’s photo of the card back" loading="lazy" />
                    <figcaption><strong>Back</strong> {binder.candidate.binder!.backEvidence}</figcaption></figure>
            </div>
            <div className={styles.actions}><button type="button" onClick={() => onOpen(binder.candidate.id)}>Inspect binder copy</button>
                <button type="button" onClick={() => onOpen(binder.cleaner.id)}>Inspect cleaner copy</button></div>
        </section>}
        {anchor && other && <section className={styles.card} aria-label="Same artwork comparison">
            <h2>Same artwork for less</h2>
            {comparison ? <>
                <p>Original checked copy · {description(comparison)} · {dollars(comparison.total)} including shipping and estimated tax.</p>
                {!ready ? <p role="status">Checking {other.set} {other.number} copies.</p>
                    : expired && matched ? <p role="status">{quoteIssue || (refreshKey ? "Refreshing the original delivered price." : "A current original quote is unavailable.")}</p>
                    : alternative ? <><p><strong>Save {dollars((cents(comparison.total) - cents(alternative.total)) / 100)}</strong> with {description(alternative)} at {dollars(alternative.total)} including shipping and estimated tax.</p>
                        <div className={styles.actions}><button type="button" onClick={() => onOpen(alternative.id)}>Inspect alternative</button></div></>
                    : <p>No cheaper verified {other.set} {other.number} copy with comparable condition and confirmed shipping among the checked listings.</p>}
                <div className={styles.upgrade}><button type="button" onClick={() => setSelection(null)}>Close artwork comparison</button></div>
            </> : <>
                <p>Compare {description(anchor)} at {dollars(anchor.total)} with the {other.set} {other.number} release. Both feature the same illustration with different foil patterns.</p>
                <div className={styles.actions}><button type="button" onClick={() => {
                    const query = `${other.name} ${other.set} ${other.number} holo ${anchor.rawCondition ? "raw" : anchor.quality}`;
                    setQuoteIssue("");
                    attemptedRun.current = null;
                    setSelection({ original: anchor, query });
                    onSearch(query);
                }}>Search the other release</button></div>
            </>}
        </section>}
    </>;
}
