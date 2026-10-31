import { useState, type ReactNode } from "react";
import type { ShortlistEntry } from "../../../shared/shortlist.ts";
import { REFRESH_LIMIT } from "../../../shared/shortlist.ts";
import { currentPriceEvidence } from "../../../shared/pricing-freshness.ts";
import { dollars } from "../format";
import styles from "./ShortlistView.module.css";

interface Props {
    entries: ShortlistEntry[];
    loading: boolean;
    error: string;
    refreshing: boolean;
    refreshErrors: Record<string, string>;
    onRetry: () => void;
    onRefresh: (ids: string[]) => Promise<void>;
    onRemove: (id: string) => Promise<void>;
    onUpdate: (id: string, notes: string, ceiling: number | null) => Promise<void>;
    renderCard: (entry: ShortlistEntry) => ReactNode;
    now: number;
}
export function ShortlistView({ entries, loading, error, refreshing, refreshErrors, onRetry, onRefresh, onRemove, onUpdate, renderCard, now }: Props) {
    const [selected, setSelected] = useState<string[]>([]);
    const selection = selected.filter((id) => entries.some((entry) => entry.id === id));
    return <section className={styles.root} aria-labelledby="shortlist-heading">
        <header className={styles.head}><div><h2 id="shortlist-heading" tabIndex={-1}>Your shortlist</h2><p>Saved in this app. Refresh selected listings to check their current terms.</p></div>
            <button type="button" disabled={refreshing || !selection.length} onClick={() => void onRefresh(selection)}>{refreshing ? "Refreshing…" : `Refresh selected${selection.length ? ` (${selection.length})` : ""}`}</button>
        </header>
        <p className={styles.small}>Select up to {REFRESH_LIMIT}. Refresh checks eBay terms and photos; it does not start paid AI analysis. Successful checks are reused for one minute.</p>
        {error && <p role="alert" className={styles.error}>{error} <button type="button" onClick={onRetry}>Retry loading shortlist</button></p>}
        {loading ? <p role="status">Loading saved listings…</p> : !entries.length && !error ? <div className={styles.empty}><h3>Keep promising cards here</h3><p>Use Save on a search result or inside its analysis. Add notes and your own bid ceiling here.</p></div> : null}
        <div className={styles.grid}>{entries.map((entry) => {
            const ended = entry.listing.availability === "UNAVAILABLE" || Boolean(entry.listing.endTime && Date.parse(entry.listing.endTime) <= now);
            return <section key={entry.id} className={styles.item} aria-label={`Saved ${entry.listing.title}`}>
                <div className={styles.itemHead}><label className={styles.select}><input type="checkbox" checked={selection.includes(entry.id)} disabled={!selection.includes(entry.id) && selection.length >= REFRESH_LIMIT} onChange={(event) => setSelected((previous) => event.target.checked ? [...previous, entry.id] : previous.filter((id) => id !== entry.id))} />Select for refresh</label>
                    <button type="button" disabled={refreshing} onClick={() => void onRefresh([entry.id])}>Refresh</button></div>
                <p className={styles.small}>{entry.checkedAt ? `Last checked ${new Date(entry.checkedAt).toLocaleString()}` : `Saved ${new Date(entry.savedAt).toLocaleString()} · not refreshed`}</p>
                {ended && <p className={styles.warning}>Unavailable or ended. Saved figures are historical.</p>}
                {!ended && entry.needsAnalysis && <p className={styles.warning}>A current photo assessment is needed. Open analysis to review the listing.</p>}
                {!ended && entry.evaluation && !currentPriceEvidence(entry.evaluation, now) && <p className={styles.warning}>Prices need an update. Open analysis to refresh; unchanged photo assessments can be reused.</p>}
                {entry.checkedAt && entry.listing.availability === "UNKNOWN" && !ended && <p className={styles.small}>Availability was not confirmed. Check the listing on eBay.</p>}
                {entry.ceiling !== null && entry.listing.currentPrice !== null && entry.listing.currentPrice > entry.ceiling && <p className={styles.warning}>Above your {dollars(entry.ceiling)} ceiling.</p>}
                {refreshErrors[entry.id] && <p role="alert" className={styles.error}>{refreshErrors[entry.id]} Previous snapshot kept.</p>}
                {renderCard(entry)}
                <SavedNotes entry={entry} onUpdate={onUpdate} onRemove={onRemove} />
            </section>;
        })}</div>
    </section>;
}
function SavedNotes({ entry, onUpdate, onRemove }: { entry: ShortlistEntry; onUpdate: Props["onUpdate"]; onRemove: Props["onRemove"] }) {
    const [notes, setNotes] = useState(entry.notes);
    const [ceiling, setCeiling] = useState(entry.ceiling === null ? "" : String(entry.ceiling));
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const dirty = notes !== entry.notes || ceiling !== (entry.ceiling === null ? "" : String(entry.ceiling));
    return <details className={styles.notes}><summary>Notes and my ceiling{entry.notes ? " · notes saved" : ""}</summary>
        <form onSubmit={async (event) => {
            event.preventDefault(); if (busy) return;
            const value = ceiling.trim() === "" ? null : Number(ceiling);
            if (value !== null && (!Number.isFinite(value) || value < 0)) { setMessage("Enter a valid ceiling or leave it blank."); return; }
            setBusy(true); setMessage("Saving…");
            try { await onUpdate(entry.id, notes, value); setCeiling(value === null ? "" : String(value)); setMessage("Saved."); } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
        }}>
            <label>My bid / purchase ceiling ($)<input type="number" min="0" step="0.01" inputMode="decimal" placeholder="Use app guidance" value={ceiling} readOnly={busy} onChange={(event) => { setCeiling(event.target.value); setMessage(""); }} /></label>
            <label>Notes<textarea aria-label="Notes" maxLength={2000} rows={3} value={notes} readOnly={busy} onChange={(event) => { setNotes(event.target.value); setMessage(""); }} /></label>
            <div className={styles.noteActions}><button type="submit" aria-disabled={busy || !dirty} onClick={(event) => { if (busy || !dirty) event.preventDefault(); }}>{busy ? "Saving…" : "Save notes"}</button>
                <button type="button" aria-disabled={busy} onClick={async () => { if (busy) return; setBusy(true); try { await onRemove(entry.id); } catch (error) { setMessage((error as Error).message); setBusy(false); } }}>Remove</button></div>
            <p role="status" className={styles.small}>{message}</p>
        </form>
    </details>;
}
