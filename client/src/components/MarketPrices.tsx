import { useEffect, useRef, useState } from "react";
import { screeningSaleGroups, type BuyerPriceComparison, type ListingMarketPrices, type ProviderPrice, type TileSale } from "../../../shared/listing-market-prices.ts";
import { fetchMarketPrices } from "../api";
import type { Screen } from "../../../shared/types.ts";
import { dollars } from "../format";
import styles from "./MarketPrices.module.css";

const saved = new Map<string, { until: number; result: BuyerPriceComparison }>();
const eur = new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" });
const dayOf = (date?: string | null) => date?.slice(0, 10);
const rowKey = (row: ProviderPrice) => JSON.stringify([row.source, row.basis, row.url]);

function SaleList({ sales }: { sales: TileSale[] }) {
    const methods = { fixed_price: "Buy It Now", best_offer_accepted: "Accepted offer", auction: "Auction" };
    return <ul className={styles.sales}>{sales.map(sale => <li key={sale.url}>
        <a href={sale.url} target="_blank" rel="noopener noreferrer">{sale.title}</a>
        <strong>{dollars(sale.price)}</strong>
        <small><time dateTime={sale.soldAt}>{dayOf(sale.soldAt)}</time> · {methods[sale.method]}</small>
    </li>)}</ul>;
}

export function MarketPrices({ prices, now, screen, loadAdditional = true }: { prices?: ListingMarketPrices; now: number; screen?: Screen; loadAdditional?: boolean }) {
    const inFlight = useRef<AbortController | null>(null);
    const [pending, setPending] = useState<string>();
    const [loaded, setLoaded] = useState<BuyerPriceComparison>();
    const [failure, setFailure] = useState<{ market: string; message: string }>();
    const current = prices && prices.validUntil > now ? prices : undefined;
    const market = current?.lookup?.market, id = current?.lookup?.listingId;
    useEffect(() => {
        setPending(undefined);
        setFailure(undefined);
        setLoaded(undefined);
        return () => { inFlight.current?.abort(); inFlight.current = null; };
    }, [id, market, loadAdditional]);
    async function compare() {
        if (!loadAdditional || !market || !id || inFlight.current) return;
        const controller = new AbortController();
        inFlight.current = controller;
        setPending(market);
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
        } finally {
            if (inFlight.current === controller) { inFlight.current = null; setPending(undefined); }
        }
    }
    const cache = market ? saved.get(market) : undefined;
    const comparison = loaded && loaded.market === market ? loaded : cache && cache.until > now ? cache.result : undefined;
    const problem = failure?.market === market ? failure?.message : undefined;
    const extra = new Map<string, ProviderPrice>();
    for (const row of [...(current?.additional ?? []), ...(comparison?.prices ?? [])])
        if (row.validUntil > now) extra.set(rowKey(row), row);
    const sold = current?.sold && (current.sold.validUntil ?? current.validUntil) > now ? current.sold : undefined;
    const tcg = current?.tcg && (current.tcg.validUntil ?? current.validUntil) > now ? current.tcg : undefined;
    const offer = tcg && (tcg.offerValidUntil ?? tcg.validUntil ?? 0) > now ? tcg.delivered : undefined;
    const fetchedGroups = comparison?.saleGroups?.filter(group => group.validUntil > now);
    const groups = sold?.sales?.length ? [{ scope: "", sales: sold.sales, median: sold.price, days: sold.days }] :
        fetchedGroups?.length ? fetchedGroups : screeningSaleGroups(screen?.soldEvidence?.references ?? [], now);
    const label = [current?.printing, current?.scope].filter(Boolean).join(" · ");
    const rows = [...extra.values()];
    const estimate = rows.find(row => row.source === "eBay" && row.basis === "Resale estimate from matched sales");
    const tcgMarket = rows.find(row => row.source === "TCGplayer" && / market$/.test(row.basis));
    const cardmarket = rows.find(row => row.source === "Cardmarket");
    const fallback = groups.length === 1 && (fetchedGroups?.length || screen?.soldEvidence?.exactScope) ? groups[0] : undefined;
    const ebayPrice = estimate?.price ?? sold?.price ?? fallback?.median;
    const tcgPrice = tcg?.market ?? tcgMarket?.price;
    const gradeScope = current?.scope && /^(PSA|CGC|BGS|SGC|TAG) /i.test(current.scope);
    const loading = Boolean(market && pending === market);
    const empty = !loadAdditional ? "Pending" : loading ? "Checking…" : problem ? "Unavailable" : current ? (market && !comparison ? "Not checked" : "No match") : "Unverified";
    const referenceOnly = !sold && groups.length > 0;
    const shown = new Set([estimate, tcgMarket, cardmarket]);
    function saleGroup(group: typeof groups[number], index: number) {
        return <div key={group.scope || index}>
            {group.scope && <p className={styles.detail}>{group.scope} · Median {dollars(group.median)}</p>}
            <SaleList sales={group.sales.slice(0, 3)} />
            {group.sales.length > 3 && <details><summary>Show {group.sales.length - 3} more {group.sales.length === 4 ? "sale" : "sales"}</summary>
                <SaleList sales={group.sales.slice(3)} /></details>}
        </div>;
    }
    return <section className={styles.panel} aria-label={label ? "Resale comparisons · " + label : "Market prices"}>
        <strong className={styles.heading}>Market prices{label && " · " + label}</strong>
        <dl className={styles.prices}>
            <div><dt>{referenceOnly || !estimate && sold?.sellerCondition ? "eBay sold reference" : "eBay resale estimate"}</dt>
                <dd>{ebayPrice != null ? dollars(ebayPrice) + " USD" : groups.length ? "See sales" : empty}</dd>
                {sold?.average ? <dd className={styles.detail}>Average of {sold.average.count} {sold.average.fixedPrice && "fixed-price "}{sold.average.count === 1 ? "sale" : "sales"} in {sold.average.days} days</dd> :
                    sold && <dd className={styles.detail}>{sold.filteredMean ? "Sold average · " : estimate ? "Median " + dollars(sold.price) + " · " : ""}{sold.count} {sold.count === 1 ? "sale" : "sales"} in {sold.days} days{sold.sellerCondition && " · seller-described condition"}</dd>}
                {sold?.sales30 !== undefined && <dd className={styles.detail}>{sold.sales30} observed in 30 days{sold.typicalRange && ` · Middle half ${dollars(sold.typicalRange[0])}–${dollars(sold.typicalRange[1])}`}</dd>}</div>
            <div><dt>TCGplayer market</dt><dd>{tcgPrice != null ? dollars(tcgPrice) + " USD" : gradeScope ? "Raw only" : empty}</dd>
                {tcgPrice != null && <dd className={styles.detail}>{tcg?.condition ?? tcgMarket?.basis} · {dayOf(tcg?.marketRecordAt || tcg?.checkedAt || tcgMarket?.asOf)}</dd>}</div>
            <div><dt>Cardmarket</dt><dd>{cardmarket ? eur.format(cardmarket.price) + " EUR" : empty}</dd>
                {cardmarket && <dd className={styles.detail}>{cardmarket.basis} · {dayOf(cardmarket.asOf)}</dd>}</div>
            {offer != null && <div><dt>TCGplayer lowest offer</dt><dd>{dollars(offer)} USD</dd>
                <dd className={styles.detail}>{tcg?.condition} · shipped{tcg?.snapshotAt && " · " + dayOf(tcg.snapshotAt)}</dd></div>}
            {rows.filter(row => !shown.has(row)).map(row => <div key={rowKey(row)}><dt>{row.source}</dt><dd>{row.currency === "EUR" ? eur.format(row.price) : dollars(row.price)} {row.currency}</dd>
                <dd className={styles.detail}>{row.url ? <a href={row.url} target="_blank" rel="noopener noreferrer">{row.basis}</a> : row.basis}
                    {" · "}{row.source === "Pokémon Price Tracker" && /median|provider estimate/i.test(row.basis) ? "latest sale " : ""}{dayOf(row.asOf)}</dd></div>)}
        </dl>
        {groups.length > 0 && <div className={styles.history}>
            <strong className={styles.heading}>Recent eBay sales</strong>
            {referenceOnly && <p className={styles.detail}>{current ? "Grading or condition as listed by the seller." : "Market references. This copy still needs a photo match."}</p>}
            {saleGroup(groups[0], 0)}
            {groups.length > 1 && <details><summary>Other comparable markets ({groups.length - 1})</summary>{groups.slice(1).map(saleGroup)}</details>}
        </div>}
        {!current && !groups.length && <p className={styles.empty}>Waiting for matching price evidence.</p>}
        {comparison?.notes.map(note => <p key={note} className={styles.empty}>{note}</p>)}
        {problem && <p className={styles.empty}>{problem}</p>}
        {loadAdditional && market && id && (!comparison || problem || !!comparison.notes.length) &&
            <button type="button" disabled={loading} onClick={compare}>
                {loading ? "Checking prices…" : problem || comparison?.notes.length ? "Retry price comparison" : "Check additional prices"}
            </button>}
    </section>;
}
