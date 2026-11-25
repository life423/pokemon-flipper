import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CollectorStep, CollectorStrategyState, LiveCollectorReport } from "../../../shared/collector-strategy.ts";
import { readCollectorStrategy, readLiveCollectorStrategy, startCollectorStrategy, startLiveCollectorStrategy } from "../api";
import { dollars } from "../format";
import styles from "./BestCurrentBuy.module.css";

const checkNames: Record<CollectorStep["action"], string> = {
    check_listing: "Check the listing and shipping", check_sales: "Compare exact sold copies",
    check_label: "Check the slab label", finish: "Finish the guide",
};

function LiveListings({ sourceSearchId, target, query, children }: { sourceSearchId: string; target: number; query: string; children: ReactNode }) {
    const [live, setLive] = useState<LiveCollectorReport | null>(null);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const pending = useRef<AbortController | null>(null);
    const runId = useRef<string | null>(null);
    const pendingKey = `collector-live-run:${sourceSearchId}:${target}`;
    useEffect(() => {
        const controller = new AbortController();
        readLiveCollectorStrategy(sourceSearchId, controller.signal).then(({ report }) => {
            if (controller.signal.aborted) return;
            try {
                const savedId = sessionStorage.getItem(pendingKey);
                if (savedId && savedId === report?.runId) sessionStorage.removeItem(pendingKey);
                else runId.current = savedId;
            } catch { /* In-memory retries remain available. */ }
            setLive(report);
            setReady(true);
        }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
        return () => { controller.abort(); pending.current?.abort(); };
    }, [sourceSearchId, pendingKey]);
    async function checkListings() {
        if (pending.current || !ready) return;
        const controller = new AbortController();
        pending.current = controller;
        runId.current ??= crypto.randomUUID();
        try { sessionStorage.setItem(pendingKey, runId.current); } catch { /* This visit only. */ }
        setBusy(true);
        setError("");
        try {
            const result = await startLiveCollectorStrategy(sourceSearchId, target, runId.current, controller.signal);
            if (!controller.signal.aborted) {
                setLive(result.report);
                runId.current = null;
                try { sessionStorage.removeItem(pendingKey); } catch { /* This visit only. */ }
            }
        } catch (e) {
            if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not finish the listing check.");
        } finally {
            pending.current = null;
            if (!controller.signal.aborted) setBusy(false);
        }
    }

    return <>{live ? <>
        <div className={styles.heading}><h2>{live.decision === "BUY" ? "Buy at the checked price" : "Wait"}</h2>
            <span className={styles.source}>Live listings checked {new Date(live.checkedAt).toLocaleString()}</span></div>
        <div className={styles.details}>
            <h3>{query}</h3>
            <p>{live.reason}</p>
            <div className={styles.numbers}>
                <div><span>Collector limit</span><strong>{dollars(live.maxTotal)}</strong><small>Including shipping and tax</small></div>
                {live.listing && <div><span>Verified purchase total</span><strong>{dollars(live.listing.total)}</strong>
                    <small>{dollars(live.listing.price)} + {live.listing.shipping === 0 ? "free shipping" : dollars(live.listing.shipping) + " shipping"} + {dollars(live.listing.total - live.listing.price - live.listing.shipping)} estimated tax</small></div>}
            </div>
            {live.listing && <a href={live.listing.url} target="_blank" rel="noreferrer">{live.listing.title} ↗</a>}
            <p className={styles.source}>{live.fetched} source rows fetched · {live.candidates} shortlisted · {live.steps.length} checked</p>
            {live.candidates > 0 && live.withinBudgetAtScreening === 0 && <p>Even the lowest possible purchase total among the shortlisted copies exceeded your limit.</p>}
            {!!live.titleExclusions?.length && <details><summary>Ruled out by title ({live.titleExclusions.reduce((sum, group) => sum + group.listings.length, 0)})</summary>
                {live.titleExclusions.map(group => <div key={group.listings[0].id}><p>{group.reason}</p><ul>{group.listings.map(row =>
                    <li key={row.id}>{row.title}</li>)}</ul></div>)}</details>}
            {live.steps.length > 0 && <details><summary>Which listings were checked?</summary><ol className={styles.steps}>
                {live.steps.map(step => <li key={step.listingId}><strong>{step.title}</strong><p>{step.reason}</p><p>{step.outcome}</p></li>)}
            </ol></details>}
            <details><summary>Original comparison</summary>{children}</details>
        </div>
    </> : children}
        <div className={styles.footer}>
            <p role="status">{busy ? "Checking current Buy It Now listings…" : `Search for a copy at ${dollars(target)} or less after shipping and tax.`}</p>
            <div className={styles.actions}><button type="button" disabled={!ready || busy} onClick={() => void checkListings()}>
                {busy ? "Checking listings…" : runId.current ? "Resume listing check" : "Check live listings"}
            </button></div>
        </div>
        {error && <p role="alert" className={styles.caution}>{error}{!ready && <> <a href="">Reload guide</a></>}</p>}
    </>;
}

export function CollectorStrategy({ searchId, standalone = false }: { searchId: string; standalone?: boolean }) {
    const [state, setState] = useState<CollectorStrategyState | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const pending = useRef<AbortController | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        readCollectorStrategy(searchId, controller.signal).then(setState).catch(e => {
            if (!controller.signal.aborted) setError(e.message);
        });
        return () => { controller.abort(); pending.current?.abort(); };
    }, [searchId]);
    async function run() {
        if (pending.current) return;
        const controller = new AbortController();
        pending.current = controller;
        setBusy(true);
        setError("");
        try { setState(await startCollectorStrategy(searchId, controller.signal)); }
        catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not finish the buying guide."); }
        finally { pending.current = null; if (!controller.signal.aborted) setBusy(false); }
    }

    const report = state?.report;
    const binSales = report?.market?.fixedPriceSales ?? [];
    const asking = report?.listing?.price;
    const withinRecentSales = asking != null && binSales.length === 2 &&
        asking >= Math.min(binSales[0].price, binSales[1].price) && asking <= Math.max(binSales[0].price, binSales[1].price);
    const savedComparison = report && <>
            <div className={styles.heading}><h2>{report.decision === "WAIT" ? "Wait" : "Buy at the price shown"}</h2>
                <span className={styles.source}>Prices checked · {new Date(report.asOf).toLocaleString()}</span></div>
            <div className={styles.details}>
                <h3>{report.query}</h3>
                <p>{report.reason}</p>
                <div className={styles.numbers}>
                    {report.listing && <div><span>Total to buy</span><strong>{dollars(report.listing.total)}</strong>
                        <small>{dollars(report.listing.price)} + {report.listing.shipping === 0 ? "free shipping" : dollars(report.listing.shipping) + " shipping"} + {dollars(report.listing.total - report.listing.price - report.listing.shipping)} estimated tax</small></div>}
                    {report.market && <div><span>Matched sold estimate</span><strong>{dollars(report.market.estimate)}</strong>
                        <small>{report.market.count} matched {report.market.count === 1 ? "sale" : "sales"}</small></div>}
                    {report.resaleProfit != null && <div data-outcome={report.resaleProfit < 0 ? "loss" : report.resaleProfit > 0 ? "profit" : "even"}>
                        <span>{report.resaleProfit < 0 ? "Projected resale loss" : "Projected resale profit"}</span>
                        <strong>{dollars(Math.abs(report.resaleProfit))}</strong><small>After purchase and selling costs</small></div>}
                </div>
                {!!binSales.length && <p className={styles.source}>{withinRecentSales && `The ${dollars(asking)} asking price is within the range of the two latest Buy It Now sales. `}Recent Buy It Now sales before buyer tax: {binSales.map((sale, i) =>
                    <span key={i}>{i > 0 && " · "}{sale.url ? <a href={sale.url} target="_blank" rel="noreferrer">{dollars(sale.price)}</a> : dollars(sale.price)} ({sale.soldAt.slice(0, 10)})</span>)}</p>}
                <details><summary>How the strategy reached this decision</summary><ol className={styles.steps}>{report.steps.map(step =>
                    <li key={step.action}><strong>{checkNames[step.action]}</strong><p>{step.reason}</p></li>)}</ol></details>
                <div className={styles.actions}>
                    {report.listing && <a href={report.listing.url} target="_blank" rel="noreferrer">View listing on eBay ↗</a>}
                    {!standalone && <a href={`?strategy=${encodeURIComponent(searchId)}`}>Open guide</a>}
                </div>
            </div>
    </>;
    if (!standalone && !state?.available && !error) return null;
    return <section className={styles.card} aria-label="Collector strategy" data-outcome="collector">
        {report?.market ? <LiveListings key={searchId} sourceSearchId={searchId} target={report.market.estimate} query={report.query}>
            {savedComparison}
        </LiveListings> : report ? savedComparison : <>
            <h2>Collector strategy</h2>
            {state?.available ? <><p>Compare the asking price with sales of the same slab.</p>
                <div className={styles.actions}><button type="button" disabled={busy} onClick={() => void run()}>{busy ? "Comparing sales…" : "Run collector strategy"}</button></div></>
                : <p>{state ? "This search has no exact-slab comparison." : error ? null : "Loading the comparison…"}</p>}
        </>}
        {error && <p role="alert" className={styles.caution}>{error}</p>}
    </section>;
}
