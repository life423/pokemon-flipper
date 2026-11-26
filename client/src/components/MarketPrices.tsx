import { useEffect, useRef, useState } from "react";
import type { BuyerPriceComparison, ListingMarketPrices, ProviderPrice } from "../../../shared/listing-market-prices.ts";
import { fetchMarketPrices } from "../api";
import { dollars } from "../format";
import styles from "./MarketPrices.module.css";

const saved = new Map<string, { until: number; result: BuyerPriceComparison }>();
const eur = new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" });
const dayOf = (date?: string | null) => date?.slice(0, 10);
const rowKey = (row: ProviderPrice) => JSON.stringify([row.source, row.basis, row.url]);

export function MarketPrices({ prices, now }: { prices?: ListingMarketPrices; now: number }) {
    const panel = useRef<HTMLElement>(null);
    const [loaded, setLoaded] = useState<BuyerPriceComparison>();
    const [failure, setFailure] = useState<{ market: string; message: string }>();
    const [attempt, retry] = useState(0);
    const current = prices && prices.validUntil > now ? prices : undefined;
    const market = current?.lookup?.market, id = current?.lookup?.listingId;
    useEffect(() => {
        if (!market || !id || !panel.current) return;
        const controller = new AbortController();
        const cache = saved.get(market);
        if (cache && cache.until > Date.now()) { setLoaded(cache.result); return; }
        async function load() {
            if (controller.signal.aborted || !market || !id) return;
            setFailure(undefined);
            try {
                const result = await fetchMarketPrices(id, market, controller.signal);
                if (controller.signal.aborted || result.market !== market) return;
                setLoaded(result);
                if (!result.notes.length) {
                    saved.set(market, { until: Date.now() + 300_000, result });
                    if (saved.size > 200) saved.delete(saved.keys().next().value!);
                }
            } catch (error) {
                if (!controller.signal.aborted) setFailure({ market, message: error instanceof Error ? error.message : "Additional prices could not be loaded." });
            }
        }
        // A hunt can retain fifty copies. Only request additional providers for a card the buyer can see.
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load(); }
        });
        observer.observe(panel.current);
        return () => { observer.disconnect(); controller.abort(); };
    }, [id, market, attempt]);

    if (!current) return <p className={styles.empty}>No matched resale prices available</p>;
    const comparison = loaded?.market === market ? loaded : undefined;
    const problem = failure?.market === market ? failure?.message : undefined;
    const extra = new Map<string, ProviderPrice>();
    for (const row of [...(current.additional ?? []), ...(comparison?.prices ?? [])])
        if (row.validUntil > now) extra.set(rowKey(row), row);
    const sold = current.sold && (current.sold.validUntil ?? current.validUntil) > now ? current.sold : undefined;
    const tcg = current.tcg && (current.tcg.validUntil ?? current.validUntil) > now ? current.tcg : undefined;
    const offer = tcg && (tcg.offerValidUntil ?? current.validUntil) > now ? tcg.delivered : undefined;
    const noQuote = [];
    if (comparison && !comparison.notes.length) {
        const received = new Set([...extra.values()].map(row => row.source));
        if (!/\d/.test(current.scope) && tcg?.market == null && offer == null && !received.has("TCGplayer")) noQuote.push("TCGplayer");
        if (!received.has("Pokémon Price Tracker")) noQuote.push("Pokémon Price Tracker");
        if (!received.has("Cardmarket")) noQuote.push("Cardmarket");
    }
    const label = [current.printing, current.scope].filter(Boolean).join(" · ");
    return <section ref={panel} aria-label={`Resale comparisons · ${label}`}>
        <strong className={styles.heading}>Market prices · {label}</strong>
        <dl className={styles.prices}>
            <div><dt>eBay sold median</dt><dd>{sold ? dollars(sold.price) + " USD" : "No matched sales"}</dd>
                {sold && <dd className={styles.detail}>{sold.count} {sold.count === 1 ? "sale" : "sales"} in {sold.days} days{sold.sellerCondition && " · seller-described condition"}
                    {sold.latestSale && " · latest " + dayOf(sold.latestSale)}</dd>}</div>
            {tcg?.market != null && <div><dt>TCGplayer market</dt><dd>{dollars(tcg.market)} USD</dd>
                <dd className={styles.detail}>{tcg.condition}{tcg.checkedAt && " · " + dayOf(tcg.marketRecordAt || tcg.checkedAt)}</dd></div>}
            {offer != null && <div><dt>TCGplayer lowest offer</dt><dd>{dollars(offer)} USD</dd>
                <dd className={styles.detail}>{tcg?.condition} · shipped{tcg?.snapshotAt && " · " + dayOf(tcg.snapshotAt)}</dd></div>}
            {[...extra].map(([key, row]) => <div key={key}><dt>{row.source}</dt><dd>{row.currency === "EUR" ? eur.format(row.price) : dollars(row.price)} {row.currency}</dd>
                <dd className={styles.detail}>{row.url ? <a href={row.url} target="_blank" rel="noopener noreferrer">{row.basis}</a> : row.basis}
                    {" · "}{row.source === "Pokémon Price Tracker" && /median|provider estimate/i.test(row.basis) ? "latest sale " : ""}{dayOf(row.asOf)}</dd></div>)}
        </dl>
        {market && !comparison && !problem && <p className={styles.empty}>Checking other price sources…</p>}
        {noQuote.length > 0 && <p className={styles.empty}>No matching quote returned by {new Intl.ListFormat("en-US").format(noQuote)}.</p>}
        {comparison?.notes.map(note => <p key={note} className={styles.empty}>{note}</p>)}
        {problem && <p className={styles.empty}>{problem}</p>}
        {(problem || !!comparison?.notes.length) && <button type="button" onClick={() => retry(n => n + 1)}>Retry price comparison</button>}
    </section>;
}
