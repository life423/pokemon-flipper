import { useEffect, useState } from "react";
import type { AuctionTrackingResults, TrackedAuction } from "../../../shared/auction-tracking.ts";
import { fetchAuctionTracking, recheckAuctionClose } from "../api";
import { dollars } from "../format";
import styles from "./CompetingAuctions.module.css";

function outcome(row: TrackedAuction) {
    if (row.closingPrice !== undefined)
        return `Closed at ${dollars(row.closingPrice)} · ${row.status === "WITHIN_LIMIT" ? "within" : "above"} your original limit.`;
    return row.note;
}

export function AuctionTracking() {
    const [data, setData] = useState<AuctionTrackingResults | null>(null);
    const [error, setError] = useState("");
    const [checking, setChecking] = useState<string | null>(null);
    async function recheck(id: string) {
        setChecking(id);
        try { setData(await recheckAuctionClose(id)); setError(""); }
        catch (err) { setError(err instanceof Error ? err.message : "Could not check the closing price."); }
        finally { setChecking(null); }
    }
    useEffect(() => {
        const controller = new AbortController();
        const announced = new Map<string, string>();
        let pending = false;
        async function load() {
            if (pending || document.visibilityState !== "visible") return;
            pending = true;
            try {
                const result = await fetchAuctionTracking(controller.signal);
                if (controller.signal.aborted) return;
                setData(result); setError("");
                for (const row of result.auctions) {
                    const stamp = JSON.stringify([row.checkedAt, row.status, row.nextBid, row.shipping]);
                    if (announced.get(row.listingId) !== stamp) {
                        window.dispatchEvent(new CustomEvent("pokemon-auction-terms-changed", { detail: { listingId: row.listingId, checkedAt: row.checkedAt } }));
                    }
                    announced.set(row.listingId, stamp);
                }
            } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Auction history could not be read."); }
            finally { pending = false; }
        }
        void load();
        const timer = setInterval(() => void load(), 30_000);
        document.addEventListener("visibilitychange", load);
        return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", load); };
    }, []);
    if (!data?.auctions.length && !error) return null;
    return <details className={styles.panel}>
        <summary>Tracked auction outcomes{data && ` (${data.auctions.length})`}</summary>
        {error && <p role="status">{error}</p>}
        {data && <>
            <p>{data.confirmed ? `${data.withinLimit} of ${data.confirmed} confirmed sales closed within your original bid limit.` :
                "Closing prices appear when a matching auction sale is reported."}{data.awaiting > 0 && ` ${data.awaiting} ended without a confirmed price so far.`}</p>
            {data.auctions.map(row => <article className={styles.group} key={row.listingId}>
                <h3><a href={row.url} target="_blank" rel="noreferrer">{row.title}</a></h3>
                <p>Original item-bid limit {dollars(row.originalMaxBid)} · {outcome(row)}</p>
                <small>At alert · auction price {dollars(row.initialBid)} · estimated market value {dollars(row.marketValue)}</small>
                {!!row.bidHistory?.length && <details><summary>Bid updates ({row.bidHistory.length})</summary>
                    <ul>{row.bidHistory.map(quote => <li key={quote.checkedAt}>
                        {new Date(quote.checkedAt).toLocaleTimeString()} · {quote.currentBid === null ? "No confirmed current bid" : dollars(quote.currentBid) + " current bid"}
                        {quote.minimumBid !== null && " · " + dollars(quote.minimumBid) + " next bid"}
                        {quote.shipping !== null && " · " + dollars(quote.shipping) + " shipping"}
                    </li>)}</ul>
                </details>}
                {row.recheckAfter && Date.parse(row.recheckAfter) <= Date.now() &&
                    <button type="button" disabled={checking !== null} onClick={() => void recheck(row.listingId)}>
                        {checking === row.listingId ? "Checking sale…" : "Check for a reported sale"}
                    </button>}
                {row.soldAt && <small>Reported sale on {row.soldAt.slice(0, 10)}.</small>}
            </article>)}
        </>}
    </details>;
}
