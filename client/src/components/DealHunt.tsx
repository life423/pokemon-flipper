import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { dealHuntGoals, type DealHuntGoal, type DealHuntReport, type DealHuntResponse, type DealHuntScope, type HuntMarketPreferences } from "../../../shared/deal-hunt.ts";
import type { ListingFilters } from "../../../shared/listing-filters.ts";
import { dollars } from "../../../shared/format.ts";
import { withFreshListing } from "../../../shared/fresh-listing.ts";
import { timeLeft } from "../format";
import { ListingThumbnail } from "./ListingThumbnail";
import { huntDecisionLabel, huntSections, selectedHuntListing } from "../search/hunt-result";
import type { Evaluation, ListingSummary, Targets } from "../types";
import { runDealHunt } from "../api";
import styles from "./DealHunt.module.css";

const checks: Record<DealHuntReport["steps"][number]["action"], string> = {
    find_listings: "Look for another card",
    check_listing: "Listing terms",
    inspect_photos: "Photo assessment",
    resolve_printing: "Check the printing",
    check_sales: "Sale comparisons",
    check_raw_resale: "Compare selling raw",
    check_price_references: "Additional price sources",
    calculate_grading: "Grading costs and returns",
};

function HuntListingCard({ listing, decision, now, children, onEvidence, evidenceLabel, shortlist, fallbackImages }: {
    listing: ListingSummary; decision?: string; now: number; children?: ReactNode; fallbackImages?: string[];
    onEvidence?: (opener: HTMLElement) => void; evidenceLabel?: string; shortlist: ReactNode;
}) {
    const auction = listing.buyingOption === "AUCTION";
    const images = listing.images.length ? listing.images : fallbackImages ?? [];
    const photo = <ListingThumbnail images={images} alt={listing.title} eager={Boolean(decision)} />;
    return <article className={styles.card} aria-label={listing.title}>
        {onEvidence ? <button type="button" className={styles.photo} aria-label={`View analysis of ${listing.title}`}
            onClick={event => onEvidence(event.currentTarget)}>{photo}</button> :
            <a className={styles.photo} href={listing.url} target="_blank" rel="noopener noreferrer" aria-label={`View ${listing.title} on eBay`}>{photo}</a>}
        <div className={styles.cardBody}>
            <p className={styles.meta}>{auction ? "Auction" : "Buy It Now"}{auction && listing.endTime && ` · ${timeLeft(listing.endTime, now)}`}</p>
            <h3>{decision && <span>{decision} · </span>}{listing.title}</h3>
            {listing.currentPrice !== null && <p className={styles.meta}>{auction ? listing.bids ? "Bid when checked" : "Opening bid" : "Asking price"} {dollars(listing.currentPrice)}
                {listing.shipping !== null && (listing.shipping === 0 ? " · Free shipping" : ` · ${dollars(listing.shipping)} shipping`)}</p>}
            {children}
            <div className={styles.actions}>
                {onEvidence && <button type="button" onClick={event => onEvidence(event.currentTarget)}>{evidenceLabel}</button>}
                {shortlist}
                <a href={listing.url} target="_blank" rel="noopener noreferrer">Open on eBay ↗</a>
            </div>
        </div>
    </article>;
}

type HuntResult = DealHuntResponse & { listing?: ListingSummary };

export function DealHuntResult({ result, now, updatedTerms, onEvidence, shortlistButton }: {
    result: HuntResult; now: number; updatedTerms: ReadonlyMap<string, number>;
    onEvidence: (opener: HTMLElement) => void; shortlistButton: (listing: ListingSummary) => ReactNode;
}) {
    const { report } = result;
    const auction = report.goal === "collect_slab" ? result.collectorAuction : result.auctionOpportunity;
    const expired = auction && (auction.validUntil <= now || (updatedTerms.get(auction.listingId) ?? 0) > Date.parse(result.evaluation?.listing.termsCheckedAt ?? ""));
    const bid = report.decision === "BID";
    const resaleBid = bid && !expired && result.auctionOpportunity?.status === "BID" ? result.auctionOpportunity : null;
    const discoveryReason = bid && result.alternative?.reason;
    const destination = expired ? null : report.destination;
    const selected = result.listing;
    const otherListings = result.candidates?.filter(row => row.id !== selected?.id &&
        (row.buyingOption !== "AUCTION" || Date.parse(row.endTime ?? "") > now)) ?? [];
    const decision = expired ? "Recheck auction" : huntDecisionLabel(report);
    const explanation = <>
        <p>{expired ? "The auction terms have changed or expired. Run the hunt again for a current bid limit." : report.reason}</p>
        {resaleBid && <p>Recent {resaleBid.marketLabel} sold estimate {dollars(resaleBid.marketValue)} from {resaleBid.sampleSize} matching {resaleBid.sampleSize === 1 ? "sale" : "sales"}.
            {" "}The next bid costs {dollars(resaleBid.nextTotal)} delivered.</p>}
        {!bid && result.alternative && <p>{result.alternative.reason}</p>}
        {report.marketNote && report.marketNote !== result.alternative?.reason && report.marketNote !== report.reason && <p>{report.marketNote}</p>}
    </>;
    return <div className={styles.result} data-decision={expired ? "WAIT" : report.decision}>
        {selected && result.evaluation ? <HuntListingCard listing={withFreshListing(selected, result.evaluation)} decision={decision} now={now} fallbackImages={selected.images}
            onEvidence={destination ? onEvidence : undefined} evidenceLabel={destination ? `View ${huntSections[destination.section]}` : undefined}
            shortlist={shortlistButton(selected)}>{explanation}</HuntListingCard> : <><h3>{decision}</h3>{explanation}</>}
        {otherListings.length > 0 && <section aria-label="Listings found" className={styles.otherListings}>
            <h3>{selected ? "Other listings found" : "Listings found"}</h3>
            {otherListings.map(row => <HuntListingCard key={row.id} listing={row} now={now} shortlist={shortlistButton(row)} />)}
        </section>}
        {(report.steps.length > 0 || discoveryReason) && <details>
            <summary>Research steps ({report.steps.length})</summary>
            {discoveryReason && <p><strong>Market used to find this copy</strong> · {discoveryReason}</p>}
            <ol>{report.steps.map((step, i) => <li key={i}>
                <strong>{checks[step.action]} · {step.title}</strong>
                {step.parallelGroup === i + 1 && <p>Checked together with the next step.</p>}
                <p>{step.selectedBy === "model" && <strong>{step.reused ? "Reused AI choice" : "AI choice"} · </strong>}
                    {step.selectedBy === "app" && <strong>App rule · </strong>}{step.reason}</p>
                <p>{step.observation}</p>
            </li>)}</ol>
        </details>}
    </div>;
}

export function DealHunt({ searchId, listings, targets, filters, minPotentialGrade, standalone = false, initialGoal, marketPreferences, takePrompt, now, updatedTerms, onFormatChange, onOpen, onClear, onStart, onUsage, shortlistButton }: {
    searchId: string;
    listings: ListingSummary[];
    targets: Targets;
    filters: ListingFilters;
    minPotentialGrade: number;
    standalone?: boolean;
    initialGoal?: DealHuntGoal;
    onFormatChange?: (format: "FIXED_PRICE" | "AUCTION") => void;
    marketPreferences?: HuntMarketPreferences;
    takePrompt: () => boolean;
    now: number;
    updatedTerms: ReadonlyMap<string, number>;
    onOpen: (report: DealHuntReport, listing: ListingSummary, evaluation: Evaluation, opener: HTMLElement, scope: DealHuntScope, alternative?: DealHuntResponse["alternative"], showPanel?: boolean) => boolean;
    shortlistButton: (listing: ListingSummary) => ReactNode;
    onClear: () => void;
    onStart: () => void;
    onUsage: () => void;
}) {
    const [mixedFormat, setMixedFormat] = useState<"FIXED_PRICE" | "AUCTION">("FIXED_PRICE");
    const format = filters.typeFilter === "AUCTION" || filters.typeFilter === "all" && mixedFormat === "AUCTION" ? "AUCTION" : "FIXED_PRICE";
    const candidates = listings.filter(row => row.buyingOption === format);
    const [goal, setGoal] = useState<DealHuntGoal>(initialGoal ?? "resell");
    const [selectedScope, setScope] = useState<DealHuntScope>("any_card");
    const scope = selectedScope === "search" && !candidates.length ? "same_set" : selectedScope;
    const [result, setResult] = useState<HuntResult | null>(null);
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
                goal, scope, listingIds: ids, targets, filters: { ...filters, typeFilter: format,
                    ...(format === "AUCTION" && { minPrice: 0 }) }, minPotentialGrade, standalone, marketPreferences,
            }, controller.signal);
            if (controller.signal.aborted) return;
            const { report, evaluation, alternative } = response;
            const listing = selectedHuntListing(response, searchId, goal, scope, candidates, format);
            if (listing && evaluation && start.current && !onOpen(report, listing, evaluation, start.current, scope, alternative, !standalone)) {
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
    function viewEvidence(opener: HTMLElement) {
        if (result?.listing && result.evaluation && !onOpen(result.report, result.listing, result.evaluation, opener, scope, result.alternative)) {
            setError("The listing changed. Run the hunt again to check the latest evidence.");
        }
    }
    const choices = Object.entries(dealHuntGoals).filter(([key]) => !standalone || key === "resell" || key === "collect_slab" && format === "AUCTION");
    const years = [marketPreferences?.minYear, marketPreferences?.maxYear !== marketPreferences?.minYear && marketPreferences?.maxYear].filter(Boolean).join("–");
    const criteria = [years, marketPreferences?.finish?.toLowerCase().replace("_", "-"),
        filters.maxPrice !== undefined && `Up to ${dollars(filters.maxPrice)} delivered`,
        marketPreferences && goal === "resell" && `Minimum profit ${dollars(targets.minProfit)}`].filter(Boolean);
    return <section className={styles.hunt} aria-label="Deal hunt">
        <h2>{busy ? (format === "AUCTION" ? "Searching auctions…" : "Searching listings…") :
            format === "AUCTION" ? "Find an auction to bid on" : standalone ? "Find a card to flip" : "Deal hunt"}</h2>
        <p className={styles.note} role="status">{busy ? "Checking listings and price evidence. Listing cards appear here when the hunt finishes." :
            (standalone ? "" : `Starting with ${candidates.length} matching ${candidates.length === 1 ? "listing" : "listings"}. `) +
            "Reuses saved research and may use the remaining AI allowance."}</p>
        {result && <DealHuntResult result={result} now={now} updatedTerms={updatedTerms} onEvidence={viewEvidence} shortlistButton={shortlistButton} />}
        {goal === "resell" && <p>{standalone ? "Search across sets for" : "Look for"} cards with repeated recent sales of the same printing and condition or slab grade.
            {" "}{format === "AUCTION" ? "The next bid must fit your limit after costs." : "A Buy must clear your profit and ROI targets after costs."} Your purchase limit includes shipping and estimated tax.</p>}
        {goal === "collect_slab" && format === "AUCTION" && <p>Compare the next bid with recent sales of the same printing, grader and grade. Your bid limit includes room for shipping and estimated tax.</p>}
        {criteria.length > 0 && <p>{criteria.join(" · ")}</p>}
        <form onSubmit={hunt}>
            <div className={styles.controls}>
                {(filters.typeFilter === "all" || standalone) && <label>Hunt format<select value={format} disabled={busy} onChange={event => {
                    const next = event.target.value === "AUCTION" ? "AUCTION" : "FIXED_PRICE";
                    setMixedFormat(next);
                    if (standalone) onFormatChange?.(next);
                    if (standalone && next === "FIXED_PRICE") setGoal("resell");
                    if (!standalone && next === "FIXED_PRICE" && goal === "collect_slab" && scope === "any_card") setScope("search");
                    setResult(null); setError(""); onClear();
                }}><option value="FIXED_PRICE">Buy It Now</option><option value="AUCTION">Auctions under 10 hours</option></select></label>}
                {choices.length > 1 && <label>Buying goal<select value={goal} disabled={busy} onChange={event => {
                        const next = event.target.value as DealHuntGoal;
                        setGoal(next); setScope(standalone || next === "resell" ? "any_card" : "search"); setResult(null); setError(""); onClear();
                    }}>{choices.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>}
                {!standalone && <label>Cards to consider<select value={scope} disabled={busy} onChange={event => {
                        setScope(event.target.value as DealHuntScope); setResult(null); setError(""); onClear();
                    }}>
                        <option value="search" disabled={!candidates.length}>Only these results</option>
                        <option value="same_set">Other cards in the same set</option>
                        {(goal === "resell" || goal === "collect_slab" && format === "AUCTION") && <option value="any_card">Any card across sets</option>}
                    </select></label>}
                <button type="submit" ref={start} className={styles.run} aria-disabled={busy}>{format === "AUCTION" ? "Find auction opportunities" : standalone ? "Find a flip" : "Run deal hunt"}</button>
                {busy && <button type="button" onClick={cancel}>Stop</button>}
            </div>
        </form>
        {error && <p role="alert" className={styles.error}>{error}</p>}
    </section>;
}
