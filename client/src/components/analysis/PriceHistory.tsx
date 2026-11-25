import { useEffect, useRef, useState } from "react";
import type { MarketHistory } from "../../../../shared/price-history.ts";
import { dollars } from "../../../../shared/format.ts";
import { fetchPriceHistory } from "../../api";
import { Section } from "./primitives";
import styles from "./PriceHistory.module.css";

export function PriceHistory({ id, market }: { id: string; market: string }) {
    const [data, setData] = useState<MarketHistory | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const request = useRef<AbortController | null>(null);
    useEffect(() => () => request.current?.abort(), []);
    async function load() {
        if (request.current) return;
        const controller = new AbortController();
        request.current = controller;
        setBusy(true); setError("");
        try {
            const result = await fetchPriceHistory(id, market, controller.signal);
            if (!controller.signal.aborted) setData(result);
        } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "History is unavailable."); }
        finally { request.current = null; if (!controller.signal.aborted) setBusy(false); }
    }
    const points = data?.points ?? [];
    const min = Math.min(...points.map(p => p.price)), max = Math.max(...points.map(p => p.price));
    const start = Date.parse(points[0]?.day ?? ""), end = Date.parse(points.at(-1)?.day ?? "");
    const coords = points.map(p => [30 + (end === start ? 210 : 420*(Date.parse(p.day)-start)/(end-start)),
        max === min ? 63 : 110-92*(p.price-min)/(max-min)]);
    return <Section title="Price history">
        {!data && <button type="button" onClick={load} disabled={busy} className={styles.load}>{busy ? "Loading history…" : error ? "Retry price history" : "Show price history"}</button>}
        {error && <p role="alert">{error}</p>}
        {data && <div className={styles.history}>
            {data.scope && <p>{data.scope} · {data.source}</p>}
            {points.length > 0 && <>
                <p>{dollars(points.at(-1)!.price)} on {points.at(-1)!.day} · Observed range {dollars(min)}–{dollars(max)}</p>
                <svg viewBox="0 0 480 132" role="img" aria-label={"Price history from " + points[0].day + " to " + points.at(-1)!.day + ", ranging from " + dollars(min) + " to " + dollars(max)}>
                    <path d="M30 18 V111 H450" fill="none" stroke="var(--border-control)" />
                    {coords.length > 1 && <polyline points={coords.map(p=>p.join(",")).join(" ")} fill="none" stroke="var(--accent)" strokeWidth="3" />}
                    {coords.map(([x,y],i)=><circle key={points[i].day} cx={x} cy={y} r="2.5" fill="var(--accent)" />)}
                </svg>
                <div className={styles.dates}><span>{points[0].day}</span><span>{points.at(-1)!.day}</span></div>
                <details><summary>Daily prices ({points.length})</summary><table><thead><tr><th>Date</th><th>USD</th></tr></thead>
                    <tbody>{points.map(p=><tr key={p.day}><td>{p.day}</td><td>{dollars(p.price)}</td></tr>)}</tbody></table></details>
            </>}
            <p><strong>Seven-day outlook · {data.outlook}</strong></p><p>{data.reason}</p>
        </div>}
    </Section>;
}
