import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ShortlistEntry } from "../../../shared/shortlist.ts";
import { REFRESH_LIMIT } from "../../../shared/shortlist.ts";
import { currentPriceEvidence } from "../../../shared/pricing-freshness.ts";
import { englishListingEligible } from "../../../shared/card-language.ts";
import { addedPhotoNumbers } from "../../../shared/listing-evidence.ts";
import { needsAddedBackPhoto } from "../../../shared/photo-evidence.ts";
import { withinAutomaticAuctionWindow } from "../../../shared/listing-filters.ts";
import { dollars, VERDICTS } from "../format";
import styles from "./ShortlistView.module.css";

interface Props {
    entries: ShortlistEntry[];
    loading: boolean;
    error: string;
    refreshing: boolean;
    refreshErrors: Record<string, string>;
    onRetry: () => void;
    onRefresh: (ids: string[], reviewNewBack?: boolean) => Promise<void>;
    onRemove: (id: string) => Promise<void>;
    onUpdate: (id: string, notes: string, ceiling: number | null) => Promise<void>;
    renderCard: (entry: ShortlistEntry) => ReactNode;
    now: number;
}
function canWatchBack(entry: ShortlistEntry, now: number) {
    return entry.listing.availability !== "UNAVAILABLE" && (!entry.listing.endTime || Date.parse(entry.listing.endTime) > now) &&
        withinAutomaticAuctionWindow(entry.listing, now) &&
        (needsAddedBackPhoto(entry.evaluation) || Boolean(entry.needsAnalysis && entry.photoChange?.neededBack));
}

export function ShortlistView({ entries, loading, error, refreshing, refreshErrors, onRetry, onRefresh, onRemove, onUpdate, renderCard, now }: Props) {
    const [selected, setSelected] = useState<string[]>([]);
    const eligible = entries.filter(entry => englishListingEligible(entry.listing, entry.evaluation));
    const excluded = entries.filter(entry => !englishListingEligible(entry.listing, entry.evaluation));
    const [watching, setWatching] = useState<string[]>([]);
    const watchState = useRef({ eligible, onRefresh, refreshing });
    useEffect(() => { watchState.current = { eligible, onRefresh, refreshing }; });
    useEffect(() => {
        if (!watching.length) return;
        let cancelled = false;
        const check = async () => {
            for (const id of watching) {
                const state = watchState.current;
                if (cancelled || document.visibilityState !== "visible" || state.refreshing) return;
                const entry = state.eligible.find(value => value.id === id);
                if (entry && canWatchBack(entry, Date.now())) await state.onRefresh([id], true);
            }
        };
        const timer = window.setInterval(() => void check(), 15 * 60_000);
        return () => { cancelled = true; window.clearInterval(timer); };
    }, [watching]);
    const selection = selected.filter((id) => eligible.some((entry) => entry.id === id));
    return <section className={styles.root} aria-labelledby="shortlist-heading">
        <header className={styles.head}><div><h2 id="shortlist-heading" tabIndex={-1}>Your shortlist</h2><p>English cards only. Saved in this app. Refresh selected listings to check their current terms.</p></div>
            <button type="button" disabled={refreshing || !selection.length} onClick={() => void onRefresh(selection)}>{refreshing ? "Refreshing…" : `Refresh selected${selection.length ? ` (${selection.length})` : ""}`}</button>
        </header>
        <p className={styles.small}>Select up to {REFRESH_LIMIT}. Refresh checks eBay terms and photos. “Check for a new back photo” also runs AI if the gallery gains photos.</p>
        {error && <p role="alert" className={styles.error}>{error} <button type="button" onClick={onRetry}>Retry loading shortlist</button></p>}
        {loading ? <p role="status">Loading saved listings…</p> : !entries.length && !error ? <div className={styles.empty}><h3>Keep promising cards here</h3><p>Use Save on a search result or inside its analysis. Add notes and your own bid ceiling here.</p></div> : null}
        {excluded.length > 0 && <details className={styles.notes}>
            <summary>{excluded.length} saved {excluded.length === 1 ? "listing" : "listings"} outside the English-only scope</summary>
            <p className={styles.small}>These saved entries are kept, but their cards, prices and analysis are hidden.</p>
            {excluded.map(entry => <ExcludedSavedEntry key={entry.id} entry={entry} onRemove={onRemove} />)}
        </details>}
        <div className={styles.grid}>{eligible.map((entry) => {
            const ended = entry.listing.availability === "UNAVAILABLE" || Boolean(entry.listing.endTime && Date.parse(entry.listing.endTime) <= now);
            const changed = entry.photoChange;
            const added = changed ? addedPhotoNumbers(changed.previousPhotos, entry.listing.images) : [];
            const addedViews = entry.evaluation?.photoCheck?.images.filter(image => added.includes(image.number)) ?? [];
            const wholeBack = addedViews.find(image => image.view === "BACK" && image.usable && !image.isStockImage);
            const finding = addedViews.find(image => image.issues.length);
            const checkBack = canWatchBack(entry, now);
            return <section key={entry.id} className={styles.item} aria-label={`Saved ${entry.listing.title}`}>
                <div className={styles.itemHead}><label className={styles.select}><input type="checkbox" checked={selection.includes(entry.id)} disabled={!selection.includes(entry.id) && selection.length >= REFRESH_LIMIT} onChange={(event) => setSelected((previous) => event.target.checked ? [...previous, entry.id] : previous.filter((id) => id !== entry.id))} />Select for refresh</label>
                    <button type="button" disabled={refreshing} onClick={() => void onRefresh([entry.id], Boolean(checkBack))}>
                        {checkBack ? "Check for a new back photo" : "Refresh"}
                    </button></div>
                {checkBack && <label className={styles.select}><input type="checkbox" checked={watching.includes(entry.id)}
                    onChange={event => setWatching(previous => event.target.checked ? [...previous, entry.id] : previous.filter(id => id !== entry.id))} />
                    Watch every 15 minutes while this shortlist is visible</label>}
                {ended && <p className={styles.warning}>Unavailable or ended. Saved figures are historical.</p>}
                {added.length > 0 && changed && <p role="status" className={changed.reviewedVerdict ? styles.small : styles.warning}>
                    Seller added {added.length === 1 ? "photo" : "photos"} {added.join(", ")}.
                    {changed.reviewedVerdict ? <> {changed.neededBack && (wholeBack ? `Photo ${wholeBack.number} shows the whole back. ` : "The added views still leave the whole back unverified. ")}
                        {finding && `Photo ${finding.number}: ${finding.issues[0]} `}
                        {changed.previousVerdict && <>Previous verdict: {VERDICTS[changed.previousVerdict].label}. </>}
                        After photo review: {VERDICTS[changed.reviewedVerdict].label}.</> :
                        entry.needsAnalysis && changed.neededBack ? " The previous assessment was missing a whole back view." : ""}
                </p>}
                {!ended && !added.length && entry.needsAnalysis && <p className={styles.warning}>A current photo assessment is needed. Open analysis to review the listing.</p>}
                {!ended && entry.evaluation && !currentPriceEvidence(entry.evaluation, now) && <p className={styles.warning}>Prices need an update. Open analysis to refresh prices.</p>}
                {entry.checkedAt && entry.listing.availability === "UNKNOWN" && !ended && <p className={styles.small}>Availability was not confirmed. Check the listing on eBay.</p>}
                {entry.ceiling !== null && entry.listing.currentPrice !== null && entry.listing.currentPrice > entry.ceiling && <p className={styles.warning}>Above your {dollars(entry.ceiling)} ceiling.</p>}
                {refreshErrors[entry.id] && <p role="alert" className={styles.error}>{refreshErrors[entry.id]} Previous snapshot kept.</p>}
                {renderCard(entry)}
                <SavedNotes entry={entry} onUpdate={onUpdate} onRemove={onRemove} />
            </section>;
        })}</div>
    </section>;
}
function ExcludedSavedEntry({ entry, onRemove }: { entry: ShortlistEntry; onRemove: Props["onRemove"] }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    return <div className={styles.noteActions}>
        <span>{entry.listing.title}</span>
        <button type="button" disabled={busy} onClick={async () => {
            if (busy) return;
            setBusy(true); setError("");
            try { await onRemove(entry.id); } catch (error) { setError((error as Error).message); setBusy(false); }
        }}>{busy ? "Removing…" : "Remove saved entry"}</button>
        {error && <p role="alert" className={styles.error}>{error}</p>}
    </div>;
}
function SavedNotes({ entry, onUpdate, onRemove }: { entry: ShortlistEntry; onUpdate: Props["onUpdate"]; onRemove: Props["onRemove"] }) {
    const [notesDraft, setNotesDraft] = useState<string | null>(null);
    const [ceilingDraft, setCeilingDraft] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const savedCeiling = entry.ceiling === null ? "" : String(entry.ceiling);
    const notes = notesDraft ?? entry.notes;
    const ceiling = ceilingDraft ?? savedCeiling;
    const dirty = notes !== entry.notes || ceiling !== savedCeiling;
    return <details className={styles.notes}><summary>Notes and my ceiling{entry.notes ? " · notes saved" : ""}</summary>
        <form onSubmit={async (event) => {
            event.preventDefault(); if (busy || !dirty) return;
            const value = ceiling.trim() === "" ? null : Number(ceiling);
            if (value !== null && (!Number.isFinite(value) || value < 0)) { setMessage("Enter a valid ceiling or leave it blank."); return; }
            setBusy(true); setMessage("Saving…");
            try { await onUpdate(entry.id, notes, value); setNotesDraft(null); setCeilingDraft(null); setMessage("Saved."); } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
        }}>
            <label>My bid / purchase ceiling ($)<input type="number" min="0" step="0.01" inputMode="decimal" placeholder="Use app guidance" value={ceiling} readOnly={busy} onChange={(event) => { const value = event.target.value; setCeilingDraft(value === savedCeiling ? null : value); setMessage(""); }} /></label>
            <label>Notes<textarea aria-label="Notes" maxLength={2000} rows={3} value={notes} readOnly={busy} onChange={(event) => { const value = event.target.value; setNotesDraft(value === entry.notes ? null : value); setMessage(""); }} /></label>
            <div className={styles.noteActions}><button type="submit" aria-disabled={busy || !dirty} onClick={(event) => { if (busy || !dirty) event.preventDefault(); }}>{busy ? "Saving…" : "Save notes"}</button>
                <button type="button" aria-disabled={busy} onClick={async () => { if (busy) return; setBusy(true); try { await onRemove(entry.id); } catch (error) { setMessage((error as Error).message); setBusy(false); } }}>Remove</button></div>
            <p role="status" className={styles.small}>{message}</p>
        </form>
    </details>;
}
