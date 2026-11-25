import { useEffect, useState, type FormEvent } from "react";
import { verifiedSlabMarketKey } from "../../../shared/slab-market.ts";
import { dollars } from "../format";
import type { ListingSummary, SearchIntent } from "../types";
import type { AnalysisState } from "../analysis-state";
import { compareResaleReceipts, readResaleReceipts, receiptKey, receiptPrefix, resaleVenues, validReceipt, type ResaleReceipt } from "../search/resale-receipts";
import styles from "./ResaleReceipts.module.css";

const changed = "flipper-resale-receipts-changed";

function loadReceipts() {
    try { return { sales: readResaleReceipts(window.localStorage), failed: false }; }
    catch { return { sales: [], failed: true }; }
}
function useReceipts() {
    const [state, setState] = useState(loadReceipts);
    useEffect(() => {
        const refresh = () => setState(loadReceipts());
        const onStorage = (event: StorageEvent) => { if (!event.key || event.key.startsWith(receiptPrefix)) refresh(); };
        window.addEventListener(changed, refresh);
        window.addEventListener("storage", onStorage);
        refresh();
        return () => { window.removeEventListener(changed, refresh); window.removeEventListener("storage", onStorage); };
    }, []);
    return state;
}

export function ResaleReceiptPanel({ listing, state, now }: { listing: ListingSummary; state: Extract<AnalysisState, { status: "done" }>; now: number }) {
    const { sales, failed } = useReceipts();
    const [error, setError] = useState("");
    const evaluation = state.evaluation;
    const market = verifiedSlabMarketKey(evaluation);
    const identity = evaluation.identity;
    if (!market || !identity || evaluation.listing.id !== listing.id || listing.buyingOption !== "FIXED_PRICE") return null;
    const matching = sales.filter(sale => sale.market === market).sort((a, b) => b.soldOn.localeCompare(a.soldOn));
    const comparisons = compareResaleReceipts(listing, state, sales, now);
    const today = new Date(now).toISOString().slice(0, 10);

    function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = event.currentTarget;
        const fields = new FormData(form);
        const receipt = { market, venue: fields.get("venue"), reference: String(fields.get("reference") || "").trim(),
            soldOn: fields.get("soldOn"), payout: Number(fields.get("payout")), fulfillment: Number(fields.get("fulfillment")) };
        if (!validReceipt(receipt) || receipt.soldOn > today || fields.get("fulfillment") === "") {
            setError("Enter the sale date, reference, cash payout and fulfillment cost from your completed sale."); return;
        }
        try {
            const key = receiptKey(receipt);
            if (window.localStorage.getItem(key) !== null) { setError("This sale reference is already saved for that venue."); return; }
            window.localStorage.setItem(key, JSON.stringify(receipt));
            window.dispatchEvent(new Event(changed)); setError(""); form.reset();
        } catch { setError("This browser could not save the sale."); }
    }
    function remove(receipt: ResaleReceipt) {
        try { window.localStorage.removeItem(receiptKey(receipt)); window.dispatchEvent(new Event(changed)); setError(""); }
        catch { setError("This browser could not remove the sale."); }
    }
    return <details className={styles.panel}>
        <summary>Compare with your sales on another marketplace</summary>
        {failed ? <p role="alert">Saved sales could not be read in this browser.</p> : <>
            <p>Record a settled US-dollar fixed-price sale of this exact English slab.</p>
            <strong>{identity.name} {identity.cardNumber} · {identity.set} · {identity.printingLabel || identity.printing} · {identity.finish.replaceAll("_", " ")} · {evaluation.slab?.grader} {evaluation.slab?.grade}</strong>
            {comparisons.map(({ receipt, cost, proceeds, margin }) => <p key={receipt.venue}>
                {receipt.venue} · {dollars(proceeds)} net on {receipt.soldOn} · {dollars(cost)} to buy here · <strong>{dollars(margin)} if repeated</strong>
            </p>)}
            {matching.length > 0 && comparisons.length === 0 && <p>A comparison needs a sale from the last 90 days and fresh, matching purchase terms including shipping.</p>}
            {matching.length > 0 && <ul>{matching.map(r => <li key={receiptKey(r)}>{r.venue} · {r.soldOn} · {r.reference} · payout {dollars(r.payout)} less {dollars(r.fulfillment)}
                {" "}<button type="button" onClick={() => remove(r)} aria-label={`Remove sale ${r.reference} on ${r.venue}`}>Remove</button></li>)}</ul>}
            <form className={styles.form} onSubmit={save}>
                <label>Sale venue<select name="venue">{resaleVenues.map(v => <option key={v}>{v}</option>)}</select></label>
                <label>Sale date<input name="soldOn" type="date" max={today} required /></label>
                <label>Sale reference<input name="reference" maxLength={100} required /></label>
                <label>Cash payout after venue fees ($)<input name="payout" type="number" min="0.01" step="0.01" required /></label>
                <label>Postage, supplies and other costs outside payout ($)<input name="fulfillment" type="number" min="0" step="0.01" required /></label>
                <button type="submit">Save completed sale</button>
            </form>
            {error && <p role="alert">{error}</p>}
        </>}
    </details>;
}

export function ResaleReceiptMatches({ listings, analyses, intent, now, onOpen }: { listings: ListingSummary[]; analyses: Record<string, AnalysisState>;
    intent?: SearchIntent | null; now: number; onOpen: (id: string) => void }) {
    const { sales } = useReceipts();
    if (!sales.length) return null;
    const rows = listings.flatMap(listing => compareResaleReceipts(listing, analyses[listing.id], sales, now, intent)
        .map(comparison => ({ ...comparison, listing }))).sort((a, b) => b.margin - a.margin);
    const best = rows[0];
    if (!best) return null;
    return <section className={styles.panel} aria-label="Cross-market resale comparison">
        <h3>Your {best.receipt.venue} resale comparison</h3>
        <p><strong>{best.listing.title}</strong></p>
        <p>You kept {dollars(best.proceeds)} on {best.receipt.soldOn}. This copy costs {dollars(best.cost)} after shipping and estimated tax.
        Compared with that payout, the difference is <strong>{dollars(best.margin)}</strong>.</p>
        <p>{best.count} matching {best.count === 1 ? "sale" : "sales"} you recorded on this venue in 90 days. Based on the latest sale day.</p>
        <button type="button" onClick={() => onOpen(best.listing.id)}>View listing and receipt</button>
    </section>;
}
