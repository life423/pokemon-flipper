import { useState } from "react";
import type { CardmarketComparison } from "../../../shared/cardmarket.ts";
import { searchPhotosFitDetails } from "../../../shared/listing-evidence.ts";
import { acquisitionCost } from "../../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../../shared/money/config.ts";
import type { AnalysisState } from "../analysis-state";
import type { ListingSummary } from "../types";
import { fetchCardmarketComparison } from "../api";
import { checkedTerms, eligibleAssessedListing } from "../search/results";
import { cardmarketScenario } from "../search/cardmarket-scenario";
import { dollars } from "../format";
import styles from "./ResaleReceipts.module.css";

const euro = new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" });

export function CardmarketComparisonPanel({ listing, state, now, market }: {
    listing: ListingSummary; state: Extract<AnalysisState, { status: "done" }>; now: number; market: string;
}) {
    const [comparison, setComparison] = useState<CardmarketComparison | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [fee, setFee] = useState("");
    const [expenses, setExpenses] = useState("");
    const evaluation = eligibleAssessedListing(listing, state, null, now);
    if (!evaluation || evaluation.listing.title.trim() !== listing.title.trim() ||
        !searchPhotosFitDetails(listing.images, evaluation.listing.photos ?? [])) return null;
    const terms = checkedTerms(listing, evaluation, now);
    const purchase = terms && acquisitionCost(terms.price, terms.shipping, MONEY_CONFIG.buying);
    const lowest = comparison?.offers[0];
    const fx = comparison?.fx;
    const scenario = lowest && fx && cardmarketScenario(lowest.priceEur, fx.usdPerEur, purchase, fee, expenses);

    async function check() {
        setLoading(true); setError("");
        try { setComparison(await fetchCardmarketComparison(listing.id, market, state.searchRunId)); }
        catch (ex) { setError(ex instanceof Error ? ex.message : "Cardmarket offers could not be retrieved."); }
        finally { setLoading(false); }
    }
    return <details className={styles.panel}>
        <summary>Compare Cardmarket asking prices</summary>
        <p>Check what sellers are asking for this printing in the same raw condition or slab grade.</p>
        {!comparison && <button type="button" disabled={loading} onClick={check}>{loading ? "Checking offers…" : "Check Cardmarket offers"}</button>}
        {error && <p role="alert">{error}</p>}
        {comparison && <div role="status">
            {lowest ? <>
                <strong>{euro.format(lowest.priceEur)} lowest checked ask{fx && ` (about ${dollars(lowest.priceEur * fx.usdPerEur)})`}</strong>
                <p>{comparison.offers.length} matching {comparison.offers.length === 1 ? "offer" : "offers"} checked · {lowest.variant} · {lowest.grader ? `${lowest.grader} ${lowest.grade}` : lowest.condition} · before delivery.</p>
                <p>Active offers from PKMNPrices · checked {new Date(comparison.checkedAt).toLocaleDateString()}.
                    {fx && ` ECB reference rate on ${fx.date}: €1 = $${fx.usdPerEur}.`}</p>
            </> : <p>{comparison.reason ?? "No matching current offers were returned."}</p>}
        </div>}
        {lowest && (purchase === null ? <p>A current eBay delivered price is needed to compare resale proceeds.</p> :
            <p>eBay purchase including shipping and estimated tax: <strong>{dollars(purchase)}</strong>.</p>)}
        {lowest && purchase !== null && !fx && <p>A recent US-dollar reference rate is unavailable.</p>}
        {lowest && fx && purchase !== null && <>
            <p>If you can sell on Cardmarket, enter your costs to see what you would keep at this asking price.</p>
            <div className={styles.form}>
                <label>Your selling fee (%)<input type="number" min="0" max="100" step="0.01" value={fee} onChange={e => setFee(e.target.value)} /></label>
                <label>Postage, supplies, conversion and other costs ($)<input type="number" min="0" step="0.01" value={expenses} onChange={e => setExpenses(e.target.value)} /></label>
            </div>
            {scenario && <p role="status">If it sells at {euro.format(lowest.priceEur)}, you would keep {dollars(scenario.proceeds)}.
                Estimated {scenario.difference < 0 ? "loss" : "gain"} after purchase: <strong>{dollars(Math.abs(scenario.difference))}</strong>.</p>}
        </>}
    </details>;
}
