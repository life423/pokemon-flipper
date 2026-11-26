import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AiUsageDay, HuntProgress } from "../../../shared/ai-usage.ts";
import { DEAL_HUNT_LISTING_LIMIT, dealHuntGoals, type DealHuntGoal, type DealHuntReport, type DealHuntResponse, type DealHuntScope, type HuntMarketPreferences } from "../../../shared/deal-hunt.ts";
import type { ListingFilters } from "../../../shared/listing-filters.ts";
import { CONDITION_NAMES, isRawCondition } from "../../../shared/conditions.ts";
import { dollars } from "../../../shared/format.ts";
import { MONEY_CONFIG } from "../../../shared/money/config.ts";
import { acquisitionCost } from "../../../shared/money/underwriting.ts";
import { checkedTerms } from "../search/results";
import { rawPriceForPath } from "../../../shared/money/price-evidence.ts";
import { applyVerifiedPurchase } from "../../../shared/money/verified-purchase.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../../shared/search-diagnostic.ts";
import { releaseYearText } from "../../../shared/search-years.ts";
import { releaseIssue, withReleaseEvidence } from "../../../shared/base-set-release.ts";
import { timeLeft } from "../format";
import { useNow } from "../useNow";
import { ListingThumbnail } from "./ListingThumbnail";
import { ProgressBar } from "./SearchProgress";
import { expiredGradingReason, huntDecisionLabel, huntSections, reconcileHuntListing, selectedHuntListing, supportsCrossCardHunt } from "../search/hunt-result";
import type { Evaluation, ListingSummary, Targets } from "../types";
import { runDealHunt } from "../api";
import { tcgplayerEstimateLabel } from "./analysis/PricingSections";
import styles from "./DealHunt.module.css";
import { listingMarketPrices } from "../../../shared/listing-market-prices.ts";
import { MarketPrices } from "./MarketPrices";

const checks: Record<DealHuntReport["steps"][number]["action"], string> = {
    find_listings: "Look for another card",
    check_listing: "Listing terms",
    inspect_photos: "Photo assessment",
    resolve_printing: "Check the printing",
    check_sales: "Sale comparisons",
    check_raw_resale: "Compare selling raw",
    check_price_tracker: "Pokémon Price Tracker",
    search_web_sales: "Cited web sales",
    check_price_history: "Price history",
    compare_cardmarket: "Cardmarket asking prices",
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

const huntPhases = {
    planning: "Choosing what to check next",
    discovering: "Scanning eBay listings",
    pricing: "Comparing recent sales",
    reviewing: "Checking this listing",
} as const;

const huntActions: Record<NonNullable<HuntProgress["action"]>, string> = {
    find_listings: "Finding matching listings",
    check_listing: "Checking price and availability",
    inspect_photos: "Reading the listing photos",
    resolve_printing: "Checking the printing marks",
    check_sales: "Comparing recent sales",
    check_raw_resale: "Estimating resale value ungraded",
    check_price_tracker: "Checking Pokémon Price Tracker",
    search_web_sales: "Looking up cited transactions",
    check_price_history: "Checking price history",
    compare_cardmarket: "Checking Cardmarket offers",
    check_price_references: "Comparing resale prices",
    calculate_grading: "Calculating profit after grading",
};

function elapsed(milliseconds: number) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function count(value: number, singular: string, plural = `${singular}s`) {
    return value > 0 ? `${value.toLocaleString()} ${value === 1 ? singular : plural}` : null;
}

export function HuntProgressPanel({ searchId, startedAt, usage, onStop }: { searchId: string; startedAt?: number; usage?: AiUsageDay | null; onStop?: () => void }) {
    const now = useNow(1000);
    const snapshot = usage?.hunt;
    const serverStart = snapshot ? Date.parse(snapshot.startedAt) : Number.NaN;
    const live = snapshot?.searchId === searchId && serverStart >= (startedAt ?? 0) ? snapshot : undefined;
    const phase = live && !live.completedAt ? huntPhases[live.phase as keyof typeof huntPhases] : undefined;
    // Finding listings includes a sold-price screening stage after discovery.
    const activity = phase && live?.action && !(live.phase === "pricing" && live.action === "find_listings")
        ? huntActions[live.action] : phase;
    const accounting = usage?.searchId === searchId ? usage : undefined;
    const calls = accounting?.calls ?? 0;
    const images = accounting?.stages.reduce((sum, stage) => sum + stage.images, 0) ?? 0;
    const pricing = accounting?.pricing?.completed ?? 0;
    const counts = live ? [
        count(live.discovered, "listing found", "listings found"),
        count(live.screened, "pricing check"),
        count(live.retained, "candidate"),
        count(live.reviewed, "copy checked", "copies checked"),
        count(live.photos, "copy with photos checked", "copies with photos checked"),
    ].filter(Boolean) : [count(calls, "AI request logged", "AI requests logged"),
        count(images, "image submitted for analysis", "images submitted for analysis"),
        count(pricing, "pricing request settled", "pricing requests settled")].filter(Boolean);
    const startTime = live ? serverStart : startedAt;
    const lastUpdate = live ? Date.parse(live.updatedAt) : Number.NaN;
    const timing = [startTime !== undefined && `Elapsed ${elapsed(now - startTime)}`,
        Number.isFinite(lastUpdate) && `Last activity ${now - lastUpdate < 1000 ? "just now" : `${elapsed(now - lastUpdate)} ago`}`].filter(Boolean);
    return <section className={styles.progress} aria-label="Search progress">
        <div className={styles.heading}>
            <div role="status" className={styles.progressStatus}>
                <h2 className={styles.activity}>{activity ?? (live?.phase === "failed" ? "Search interrupted" :
                    live?.phase === "stopped" ? "Search stopped" : live ? "Preparing your results" : "Starting your search")}</h2>
                {phase && live?.cohort && <p>{live.cohort}</p>}
                {phase && live?.guidance && <p className={styles.note}>{live.guidance}</p>}
            </div>
            {!live?.completedAt && onStop && <button type="button" className={styles.stop} onClick={onStop}>Stop</button>}
        </div>
        {!live?.completedAt && <ProgressBar percent={null} label="Search activity" />}
        {counts.length > 0 && <p className={styles.note}>{!live && "Recorded for this search · "}{counts.join(" · ")}</p>}
        {timing.length > 0 && <p className={styles.note}>{timing.join(" · ")}</p>}
    </section>;
}

export function HuntCandidateCards({ listings, now, active, shortlistButton }: {
    listings: ListingSummary[]; now: number; active: boolean; shortlistButton: (listing: ListingSummary) => ReactNode;
}) {
    if (!listings.length) return null;
    return <section aria-label={active ? "Candidates being checked" : "Other listings found"}>
        <h2>{active ? "Candidates being checked" : "Other listings found"}</h2>
        <p className={styles.note}>{active ? "Checking these listings against your criteria. A purchase decision is not ready." :
            "These listings also appeared in the search. They do not have a verified purchase recommendation."}</p>
        <div className={styles.tileGrid}>{listings.map(listing => <HuntListingCard key={listing.id} listing={listing} now={now}
            shortlist={shortlistButton(listing)} />)}</div>
    </section>;
}

export function DealHuntResult({ result, now, targets, updatedTerms, currentListing, destinationReady = true, onEvidence, shortlistButton }: {
    result: HuntResult; now: number; updatedTerms: ReadonlyMap<string, number>;
    targets?: Targets; currentListing?: ListingSummary; destinationReady?: boolean;
    onEvidence: (opener: HTMLElement) => void; shortlistButton: (listing: ListingSummary) => ReactNode;
}) {
    const { report } = result;
    const auction = report.goal === "collect_slab" ? result.collectorAuction : result.auctionOpportunity;
    const grading = result.gradingOpportunity;
    const expiredGrading = grading && grading.validUntil <= now;
    const selected = result.listing;
    const current = selected && result.evaluation && reconcileHuntListing(selected, result.evaluation, currentListing);
    const checked = Date.parse(current?.listing.termsCheckedAt ?? "");
    const outdated = report.decision !== "WAIT" && (!destinationReady || !current?.currentTerms ||
        !(checked <= now && now - checked < BEST_BUY_TERMS_MAX_AGE_MS) ||
        (updatedTerms.get(current.listing.id) ?? 0) > checked);
    const shouldCheckPurchase = report.decision === "BUY" && report.goal !== "collect_slab";
    const receipt = report.verifiedPurchase;
    const reviewed = shouldCheckPurchase && !outdated && receipt
        ? applyVerifiedPurchase(result.evaluation, receipt, targets ?? receipt.targets, now) : null;
    const expiredPurchase = shouldCheckPurchase && !reviewed;
    const physical = result.evaluation && withReleaseEvidence(result.evaluation);
    const selectedPrices = current && listingMarketPrices(physical, current.listing, now);
    const savedPrices = current && result.candidatePrices?.[current.listing.id];
    if (selectedPrices?.lookup && selectedPrices.lookup.market === savedPrices?.lookup?.market) selectedPrices.additional = savedPrices.additional;
    const mismatch = physical?.identity?.notThisCard;
    const release = mismatch || (physical && releaseIssue(physical));
    const unverifiedResaleBid = report.decision === "BID" && report.goal === "resell" &&
        result.auctionOpportunity?.marketBasis?.startsWith("TCGPLAYER_");
    const expired = release || outdated || expiredGrading || expiredPurchase || unverifiedResaleBid || auction && auction.validUntil <= now;
    const bid = report.decision === "BID";
    const resaleBid = bid && !expired && result.auctionOpportunity?.status === "BID" ? result.auctionOpportunity : null;
    const quoteSource = tcgplayerEstimateLabel(resaleBid?.marketBasis);
    const discoveryReason = bid && result.alternative?.reason;
    const destination = expired ? null : report.destination;
    const otherListings = result.candidates?.filter(row => row.id !== selected?.id &&
        (row.buyingOption !== "AUCTION" || Date.parse(row.endTime ?? "") > now)) ?? [];
    let decision = huntDecisionLabel(report);
    if (expired) decision = bid ? "Waiting for a fresh bid limit" : "Waiting for a fresh price check";
    if (release) decision = mismatch ? "Different card or printing" : "Release unverified";
    const exit = reviewed?.underwriting?.best;
    const rawPrice = exit?.path === "RAW" ? rawPriceForPath(reviewed?.rawPricing, exit) : undefined;
    const terms = current?.currentTerms && current.listing.buyingOption === "FIXED_PRICE" && destinationReady &&
        result.evaluation && !result.evaluation.underwriting?.shippingUnconfirmed && (updatedTerms.get(current.listing.id) ?? 0) <= checked
        ? checkedTerms(current.listing, result.evaluation, now) : null;
    const explanation = <>
        {resaleBid?.maxBid != null && <p>Recommended max snipe <strong>{dollars(resaleBid.maxBid)}</strong> item bid.
            {resaleBid.totalAtMaxBid != null && resaleBid.profitAtMaxBid != null &&
                ` At that bid, you pay ${dollars(resaleBid.totalAtMaxBid)} delivered and project ${dollars(resaleBid.profitAtMaxBid)} profit after costs.`}</p>}
        {terms && !grading && <p>Estimated total to buy <strong>{dollars(acquisitionCost(terms.price, terms.shipping, MONEY_CONFIG.buying))}</strong> including shipping and estimated tax.</p>}
        {rawPrice && !expired && <p>Raw resale used for profit <strong>{dollars(rawPrice.price)}</strong>
            {isRawCondition(rawPrice.condition) && ` · ${CONDITION_NAMES[rawPrice.condition]}`} · {tcgplayerEstimateLabel(rawPrice.basis) ?? "Matched eBay sales"}</p>}
        {exit?.path === "GRADED_RESALE" && exit.salePrice != null && !expired && <p>Slab resale used for profit <strong>{dollars(exit.salePrice)}</strong>
            {" · "}{reviewed?.slab?.grader} {reviewed?.slab?.grade} · Matched eBay sales</p>}
        {exit?.path === "GRADE" && exit.expectedSale != null && !expired && <p>Estimated resale after {exit.grader} grading <strong>{dollars(exit.expectedSale)}</strong>
            {" · Weighted across the projected grades"}</p>}
        <p>{release || (expiredGrading ? expiredGradingReason : expired ? bid
            ? "The next search checks the auction terms before calculating a bid limit."
            : "The next search checks current prices and availability before recommending a buy." : report.reason)}</p>
        {!expired && reviewed?.underwriting?.best && <p>Max item price {dollars(reviewed.underwriting.best.maxBid)} before shipping and estimated tax.</p>}
        {resaleBid && <p>{dollars(resaleBid.marketValue)} · {resaleBid.marketLabel} · {quoteSource ?? "resale estimate"}
            {resaleBid.marketBasis === "EBAY_SOLD" && ` from ${resaleBid.sampleSize} matching ${resaleBid.sampleSize === 1 ? "sale" : "sales"}`}.
            {" "}The next bid costs {dollars(resaleBid.nextTotal)} delivered.</p>}
        {grading && !expired && <p>{dollars(grading.delivered)} delivered · {grading.dateSource === "listed" ? "Listed" : "Listing created"}{" "}
            {new Date(grading.listingDate).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>}
        {!expired && !bid && result.alternative && <p>{result.alternative.reason}</p>}
        {!expired && report.marketNote && report.marketNote !== result.alternative?.reason && report.marketNote !== report.reason && <p>{report.marketNote}</p>}
    </>;
    return <div className={styles.result} data-decision={expired ? "WAIT" : report.decision}>
        {!(selected && current) && <><h3>{decision}</h3>{explanation}</>}
        {!selected && otherListings.length > 0 && <h3>Listings found</h3>}
        {(selected && current || otherListings.length > 0) && <div className={styles.tileGrid} aria-label="Listings found">
        {selected && current && <HuntListingCard listing={current.listing} decision={decision} now={now} fallbackImages={selected.images}
            onEvidence={destination ? onEvidence : undefined} evidenceLabel={destination ? `View ${huntSections[destination.section]}` : undefined}
            shortlist={shortlistButton(selected)}>{explanation}<MarketPrices prices={selectedPrices ?? undefined} now={now} /></HuntListingCard>}
        {otherListings.map(row => <HuntListingCard key={row.id} listing={row} now={now} shortlist={shortlistButton(row)}>
            <MarketPrices prices={result.candidatePrices?.[row.id]} now={now} />
        </HuntListingCard>)}
        </div>}
        {!release && (report.steps.length > 0 || discoveryReason) && <details>
            <summary>Research steps ({report.steps.length})</summary>
            {discoveryReason && <p><strong>Market used to find this copy</strong> · {discoveryReason}</p>}
            <ol>{report.steps.map((step, i) => <li key={i}>
                <strong>{checks[step.action]} · {step.title}</strong>
                {step.parallelGroup === i + 1 && <p>Checked together with the next step.</p>}
                <p>{step.selectedBy === "model" && <strong>AI choice · </strong>}
                    {step.selectedBy === "app" && <strong>App rule · </strong>}{step.reason}</p>
                <p>{step.observation}</p>
            </li>)}</ol>
        </details>}
    </div>;
}

export function DealHunt({ searchId, listings, listingOwners, latestListings, destinationReady, targets, filters, minPotentialGrade, standalone = false, initialGoal, marketPreferences, takePrompt, now, updatedTerms, usage, onFormatChange, onOpen, onClear, onStart, onUsage, onBusyChange, shortlistButton, active = true }: {
    searchId: string;
    listings: ListingSummary[];
    listingOwners?: ReadonlyMap<string, string>;
    latestListings: ReadonlyMap<string, ListingSummary>;
    destinationReady: boolean;
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
    usage?: AiUsageDay | null;
    onOpen: (report: DealHuntReport, listing: ListingSummary, evaluation: Evaluation, opener: HTMLElement, scope: DealHuntScope, alternative?: DealHuntResponse["alternative"], showPanel?: boolean, gradingValidUntil?: number) => boolean;
    shortlistButton: (listing: ListingSummary) => ReactNode;
    onClear: () => void;
    onStart: () => void;
    onUsage: () => void;
    onBusyChange?: (busy: boolean) => void;
    active?: boolean;
}) {
    const [mixedFormat, setMixedFormat] = useState<"FIXED_PRICE" | "AUCTION">("FIXED_PRICE");
    const format = filters.typeFilter === "AUCTION" || filters.typeFilter === "all" && mixedFormat === "AUCTION" ? "AUCTION" : "FIXED_PRICE";
    const matching = listings.filter(row => row.buyingOption === format);
    const candidates = matching.slice(0, DEAL_HUNT_LISTING_LIMIT);
    const [goal, setGoal] = useState<DealHuntGoal>(initialGoal ?? "resell");
    const freshGrading = standalone && goal === "grade_raw" && format === "FIXED_PRICE";
    const [scope, setScope] = useState<DealHuntScope>(standalone ? "any_card" : "search");
    const noMatches = scope === "search" && !candidates.length;
    const [result, setResult] = useState<HuntResult | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const pending: { current: (AbortController & { startedAt?: number }) | null; lifecycle?: symbol } =
        useRef<(AbortController & { startedAt?: number }) | null>(null);
    const start = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        const lifecycle = Symbol();
        pending.lifecycle = lifecycle;
        return () => {
            // A refreshed effect can reattach to the same mounted hunt during cleanup.
            queueMicrotask(() => {
                if (pending.lifecycle !== lifecycle) return;
                pending.current?.abort();
                onBusyChange?.(false);
            });
        };
    }, [onBusyChange]);

    useEffect(() => {
        if (!active) return;
        const timer = setTimeout(() => { if (takePrompt()) void hunt(); }, 0);
        return () => clearTimeout(timer);
    }, [searchId, active]);
    useEffect(() => { if (!active) cancel(); }, [active]);
    async function hunt(event?: FormEvent) {
        event?.preventDefault();
        if (!active || pending.current || noMatches) return;
        const controller = Object.assign(new AbortController(), { startedAt: Date.now() });
        pending.current = controller;
        setBusy(true);
        onBusyChange?.(true);
        setResult(null);
        setError("");
        onClear();
        onStart();
        try {
            const ids = candidates.map(listing => listing.id);
            const owners = new Set(ids.map(id => listingOwners?.get(id)));
            const batchIds = [...owners].filter((id): id is string => !!id && id !== searchId);
            const response = await runDealHunt(searchId, {
                goal, scope, listingIds: ids, ...(batchIds.length && { batchIds }), targets, filters: { ...filters, typeFilter: format,
                    ...(format === "AUCTION" && { minPrice: 0 }), ...(freshGrading && { kindFilter: "raw" }) }, minPotentialGrade, standalone, marketPreferences,
                ...(standalone && goal === "resell" && format === "FIXED_PRICE" && { freshListings: true }),
            }, controller.signal);
            if (controller.signal.aborted) return;
            const { report, evaluation, alternative } = response;
            const listing = selectedHuntListing(response, searchId, goal, scope, candidates, format);
            if (listing && evaluation && start.current && !onOpen(report, listing, evaluation, start.current, scope, alternative, !standalone, response.gradingOpportunity?.validUntil)) {
                throw new Error("The listing changed while the hunt was running. Run it again with the latest evidence.");
            }
            setResult({ ...response, listing });
        } catch (err) {
            if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "The deal hunt could not finish.");
        } finally {
            if (pending.current === controller) {
                pending.current = null;
                if (!controller.signal.aborted) {
                    setBusy(false);
                    onBusyChange?.(false);
                }
            }
            onUsage();
        }
    }
    function cancel() {
        pending.current?.abort();
        pending.current = null;
        setBusy(false);
        onBusyChange?.(false);
        if (active) start.current?.focus();
    }
    function viewEvidence(opener: HTMLElement) {
        if (result?.listing && result.evaluation && !onOpen(result.report, result.listing, result.evaluation, opener, scope, result.alternative, true, result.gradingOpportunity?.validUntil)) {
            setError("The listing changed. Run the hunt again to check the latest evidence.");
        }
    }
    const choices = (Object.keys(dealHuntGoals) as DealHuntGoal[]).filter(key => !standalone ||
        supportsCrossCardHunt(key, format) && (key !== "grade_raw" || filters.kindFilter !== "graded"));
    const years = releaseYearText(marketPreferences?.minYear, marketPreferences?.maxYear);
    const criteria = [years, marketPreferences?.finish?.toLowerCase().replace("_", "-"),
        marketPreferences?.preferRecentSales && "Recent matched sales prioritized",
        filters.maxPrice !== undefined && `Up to ${dollars(filters.maxPrice)} delivered`,
        marketPreferences && (goal === "resell" || freshGrading) && (targets.minProfit > 0 ? `Minimum profit ${dollars(targets.minProfit)}` : "Positive profit after costs")].filter(Boolean);
    return <section className={styles.hunt} aria-label="Deal hunt">
        {busy ? <HuntProgressPanel searchId={searchId} startedAt={pending.current?.startedAt} usage={usage} onStop={cancel} /> : <>
            <h2>{format === "AUCTION" ? "Find an auction to bid on" : freshGrading ? "Find newly listed cards worth grading" : standalone ? "Find a card to flip" : "Deal hunt"}</h2>
            {!standalone && <p className={styles.note}>Starting with {candidates.length}{matching.length > candidates.length && ` of ${matching.length}`} matching {candidates.length === 1 ? "listing" : "listings"}.</p>}
        </>}
        {result && <DealHuntResult result={result} now={now} targets={targets} updatedTerms={updatedTerms}
            currentListing={result.listing && latestListings.get(result.listing.id)} destinationReady={destinationReady}
            onEvidence={viewEvidence} shortlistButton={shortlistButton} />}
        {!busy && goal === "resell" && <p>{standalone && format === "FIXED_PRICE" ? "Check active Buy It Now listings, newest first. Compare the photographed copy with sales of the same printing and condition or slab grade." : "Look for cards with recent sales of the same printing and condition or slab grade."}
            {" "}{format === "AUCTION" ? "The next bid must fit your limit after costs." : "A Buy must clear your profit and ROI targets after costs."} Your purchase limit includes shipping and estimated tax.</p>}
        {!busy && goal === "collect_slab" && format === "AUCTION" && <p>Compare the next bid with recent sales of the same printing, grader and grade. Your bid limit includes room for shipping and estimated tax.</p>}
        {!busy && freshGrading && <p>Search raw Buy It Now listings from the last 24 hours. Compare the condition visible in the photos with the seller’s description, then check profit after costs at the likely grade and one grade lower.</p>}
        {criteria.length > 0 && <p>{criteria.join(" · ")}</p>}
        <form onSubmit={hunt}>
            <div className={styles.controls}>
                {(filters.typeFilter === "all" || standalone) && <label>Hunt format<select value={format} disabled={busy} onChange={event => {
                    const next = event.target.value === "AUCTION" ? "AUCTION" : "FIXED_PRICE";
                    setMixedFormat(next);
                    if (standalone) onFormatChange?.(next);
                    if (standalone && !supportsCrossCardHunt(goal, next)) setGoal("resell");
                    if (!standalone && next === "FIXED_PRICE" && goal === "collect_slab" && scope === "any_card") setScope("search");
                    setResult(null); setError(""); onClear();
                }}><option value="FIXED_PRICE">Buy It Now</option><option value="AUCTION">Auctions under 10 hours</option></select></label>}
                {choices.length > 1 && <label>Buying goal<select value={goal} disabled={busy} onChange={event => {
                        const next = event.target.value as DealHuntGoal;
                        setGoal(next); setScope(standalone ? "any_card" : "search"); setResult(null); setError(""); onClear();
                    }}>{choices.map(key => <option key={key} value={key}>{standalone && key === "grade_raw" ? "Find newly listed raw cards worth grading" : dealHuntGoals[key]}</option>)}</select></label>}
                {!standalone && <label>Cards to consider<select value={scope} disabled={busy} onChange={event => {
                        setScope(event.target.value as DealHuntScope); setResult(null); setError(""); onClear();
                    }}>
                        <option value="search">Only these results</option>
                        <option value="same_set">Other cards in the same set</option>
                        {(goal === "resell" || goal === "collect_slab" && format === "AUCTION") && <option value="any_card">Any card across sets</option>}
                    </select></label>}
                <button type="submit" ref={start} className={styles.run} aria-disabled={busy || noMatches}>{format === "AUCTION" ? "Find auction opportunities" : freshGrading ? "Find grading opportunities" : standalone ? "Find a flip" : "Run deal hunt"}</button>
            </div>
        </form>
        {error && <p role="alert" className={styles.error}>{error}</p>}
    </section>;
}
