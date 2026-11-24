import { useEffect, useRef, useState, type FormEvent } from "react";
import { dealHuntGoals, type DealHuntGoal, type DealHuntReport, type DealHuntResponse, type DealHuntScope, type HuntMarketPreferences } from "../../../shared/deal-hunt.ts";
import type { ListingFilters } from "../../../shared/listing-filters.ts";
import { huntSections, selectedHuntListing } from "../search/hunt-result";
import type { Evaluation, ListingSummary, Targets } from "../types";
import { runDealHunt } from "../api";
import styles from "./DealHunt.module.css";

const checks: Record<DealHuntReport["steps"][number]["action"], string> = {
    find_listings: "Look for another card",
    check_listing: "Listing terms",
    inspect_photos: "Photo assessment",
    check_sales: "Sale comparisons",
    calculate_grading: "Grading costs and returns",
};

export function DealHunt({ searchId, listings, targets, filters, minPotentialGrade, standalone = false, marketPreferences, takePrompt, now, updatedTerms, onOpen, onClear, onStart, onUsage }: {
    searchId: string;
    listings: ListingSummary[];
    targets: Targets;
    filters: ListingFilters;
    minPotentialGrade: number;
    standalone?: boolean;
    marketPreferences?: HuntMarketPreferences;
    takePrompt: () => boolean;
    now: number;
    updatedTerms: ReadonlyMap<string, number>;
    onOpen: (report: DealHuntReport, listing: ListingSummary, evaluation: Evaluation, opener: HTMLElement, scope: DealHuntScope, alternative?: DealHuntResponse["alternative"]) => boolean;
    onClear: () => void;
    onStart: () => void;
    onUsage: () => void;
}) {
    const [mixedFormat, setMixedFormat] = useState<"FIXED_PRICE" | "AUCTION">("FIXED_PRICE");
    const format = filters.typeFilter === "AUCTION" || filters.typeFilter === "all" && mixedFormat === "AUCTION" ? "AUCTION" : "FIXED_PRICE";
    const candidates = listings.filter(row => row.buyingOption === format);
    const [goal, setGoal] = useState<DealHuntGoal>("resell");
    const [selectedScope, setScope] = useState<DealHuntScope>("any_card");
    const scope = selectedScope === "search" && !candidates.length ? "same_set" : selectedScope;
    const [result, setResult] = useState<(DealHuntResponse & { listing?: ListingSummary }) | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const pending = useRef<AbortController | null>(null);
    const start = useRef<HTMLButtonElement>(null);
    useEffect(() => () => { pending.current?.abort(); }, []);

    useEffect(() => {
        const timer = setTimeout(() => { if (takePrompt()) void hunt(); }, 0);
        return () => clearTimeout(timer);
    }, [searchId]);
    async function hunt(event?: FormEvent) {
        event?.preventDefault();
        if (pending.current) return;
        const controller = new AbortController();
        pending.current = controller;
        setBusy(true);
        setResult(null);
        setError("");
        onClear();
        onStart();
        try {
            const ids = candidates.map(listing => listing.id);
            const response = await runDealHunt(searchId, {
                goal, scope, listingIds: ids, targets, filters: { ...filters, typeFilter: format }, minPotentialGrade, standalone, marketPreferences,
            }, controller.signal);
            if (controller.signal.aborted) return;
            const { report, evaluation, alternative } = response;
            const listing = selectedHuntListing(response, searchId, goal, scope, candidates, format);
            if (listing && evaluation && start.current && !onOpen(report, listing, evaluation, start.current, scope, alternative)) {
                throw new Error("The listing changed while the hunt was running. Run it again with the latest evidence.");
            }
            setResult({ ...response, listing });
        } catch (err) {
            if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "The deal hunt could not finish.");
        } finally {
            if (pending.current === controller) {
                pending.current = null;
                if (!controller.signal.aborted) setBusy(false);
            }
            onUsage();
        }
    }
    function cancel() {
        pending.current?.abort();
        pending.current = null;
        setBusy(false);
        start.current?.focus();
    }
    const report = result?.report;
    const auction = result?.auctionOpportunity;
    const expired = auction && (auction.validUntil <= now || (updatedTerms.get(auction.listingId) ?? 0) > Date.parse(auction.checkedAt));
    const destination = expired ? null : report?.destination;
    const selected = result?.listing;
    return <section className={styles.hunt} aria-label="Deal hunt">
        <h2>{format === "AUCTION" ? "Find an auction to bid on" : standalone ? "Find a card to flip" : "Deal hunt"}</h2>
        {goal === "resell" && <p>{standalone ? "Search across sets for" : "Look for"} cards with repeated recent sales of the same printing and condition or slab grade.
            {" "}{format === "AUCTION" ? "The next bid must fit your limit after costs." : "A Buy must clear your profit and ROI targets after costs."} Your purchase limit includes shipping and estimated tax.</p>}
        {marketPreferences && <p>{[marketPreferences.minYear, marketPreferences.maxYear !== marketPreferences.minYear && marketPreferences.maxYear].filter(Boolean).join("–")}
            {" "}{marketPreferences.finish?.toLowerCase().replace("_", "-")} · Minimum profit {targets.minProfit.toLocaleString("en-US", {style:"currency",currency:"USD"})}</p>}
        <form onSubmit={hunt}>
            <div className={styles.controls}>
                {filters.typeFilter === "all" && <label>Hunt format<select value={format} disabled={busy} onChange={event => {
                    setMixedFormat(event.target.value === "AUCTION" ? "AUCTION" : "FIXED_PRICE");
                    setGoal("resell"); setResult(null); setError(""); onClear();
                }}><option value="FIXED_PRICE">Buy It Now</option><option value="AUCTION">Auctions under 10 hours</option></select></label>}
                {!standalone && <>
                    <label>Buying goal<select value={goal} disabled={busy} onChange={event => {
                        const next = event.target.value as DealHuntGoal;
                        setGoal(next); setScope(next === "resell" ? "any_card" : "search"); setResult(null); setError(""); onClear();
                    }}>{Object.entries(dealHuntGoals).filter(([key]) => format !== "AUCTION" || key !== "collect_slab").map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
                    <label>Cards to consider<select value={scope} disabled={busy} onChange={event => {
                        setScope(event.target.value as DealHuntScope); setResult(null); setError(""); onClear();
                    }}>
                        <option value="search" disabled={!candidates.length}>Only these results</option>
                        <option value="same_set">Other cards in the same set</option>
                        {goal === "resell" && <option value="any_card">Any card across sets</option>}
                    </select></label>
                </>}
                <button type="submit" ref={start} className={styles.run} aria-disabled={busy}>{format === "AUCTION" ? "Find auction opportunities" : standalone ? "Find a flip" : "Run deal hunt"}</button>
                {busy && <button type="button" onClick={cancel}>Stop</button>}
            </div>
        </form>
        <p className={styles.note} role="status">{busy ? "Choosing listings and checking the evidence…" :
            (standalone ? "" : `Starting with ${candidates.length} matching ${candidates.length === 1 ? "listing" : "listings"}. `) +
            "Reuses saved research and may use the remaining AI allowance."}</p>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {report && <div className={styles.result} data-decision={expired ? "WAIT" : report.decision}>
            <h3>{expired ? "Recheck auction" : report.decision === "BID" ? "Bid opportunity" : report.decision === "BUY" ? "Buy" : "Wait"}{selected && ` · ${selected.title}`}</h3>
            <p>{expired ? "The auction terms have changed or expired. Run the hunt again for a current bid limit." : report.reason}</p>
            {result?.alternative && <p>{result.alternative.reason}</p>}
            {report.marketNote && report.marketNote !== result?.alternative?.reason && report.marketNote !== report.reason && <p>{report.marketNote}</p>}
            {destination && selected && result?.evaluation && <button type="button" onClick={event => {
                if (!result.evaluation || !onOpen(report, selected, result.evaluation, event.currentTarget, scope, result.alternative)) {
                    setError("The listing changed. Run the hunt again to check the latest evidence.");
                }
            }}>
                View {huntSections[destination.section]}
            </button>}
            {report.steps.length > 0 && <details>
                <summary>Research steps ({report.steps.length})</summary>
                <ol>{report.steps.map((step, i) => <li key={i}>
                    <strong>{checks[step.action]} · {step.title}</strong>
                    <p>{step.reason}</p><p>{step.observation}</p>
                </li>)}</ol>
            </details>}
        </div>}
    </section>;
}
