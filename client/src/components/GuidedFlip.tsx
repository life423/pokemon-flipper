import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { MIN_FLIP_BIN_ASK, type DealHuntResponse } from "../../../shared/deal-hunt.ts";
import type { ListingFilters } from "../../../shared/listing-filters.ts";
import type { BuyingOption, ListingSummary, Targets } from "../../../shared/types.ts";
import type { AiUsageDay } from "../../../shared/ai-usage.ts";
import { ApiRequestError, fetchAiUsage, interpretSearchRequest, newWatchScanId, restoreWatchBudget, runDealHunt } from "../api";
import { currentHuntBid, reconcileHuntListing, selectedHuntListing } from "../search/hunt-result";
import { runGuidedHuntLegs, type GuidedHuntLeg } from "../search/guided-hunt";
import { readFlipSession, writeFlipSession, type FlipSession } from "../search/flip-session";
import { applyVerifiedPurchase } from "../../../shared/money/verified-purchase.ts";
import { DealHuntResult, HuntProgressPanel, HuntCandidateCards } from "./DealHunt";
import { AnalysisDetails } from "./analysis/AnalysisDetails";
import { ShippingDestination } from "./ShippingDestination";
import type { SniperDraft } from "../search/sniper-draft";
import styles from "./DealHunt.module.css";

type Result = DealHuntResponse & { listing?: ListingSummary; format: BuyingOption; targets: Targets; destination: string | null; receivedAt: number };
const changedDestination = "The shipping ZIP changed. Search again for updated delivery prices.";
const leftSearch = "Search paused. Resume when you’re ready.";
type ActiveLeg = GuidedHuntLeg & { waiting?: { at: number; reason: string } };
interface Props {
    onSnipe?: (draft: SniperDraft) => void;
    filters: ListingFilters; targets: Targets; minGrade: number; destination: string | null | undefined; ready: boolean; now: number;
    latest: ReadonlyMap<string, ListingSummary>; updated: ReadonlyMap<string, number>; shortlist: (listing: ListingSummary) => ReactNode;
    onUsage?: (value: AiUsageDay) => void; active?: boolean; onStart?: (id: string) => void; onBusyChange?: (busy: boolean) => void; onDestinationSaved?: (zip: string) => void;
}

export function GuidedFlip({ filters: initialFilters, targets: initialTargets, minGrade: initialGrade, destination, ready, now, latest, updated, shortlist,
    active = true, onSnipe, onStart, onUsage, onBusyChange, onDestinationSaved }: Props) {
    const [session, setSession] = useState(readFlipSession);
    const startingFilters = session?.filters ?? initialFilters, startingTargets = session?.targets ?? initialTargets;
    const [kindFilter, setKind] = useState<NonNullable<ListingFilters["kindFilter"]>>(startingFilters.kindFilter ?? "all");
    const [maxCost, setMaxCost] = useState(String(startingFilters.maxPrice ?? ""));
    const [minCost, setMinCost] = useState(String(Math.max(MIN_FLIP_BIN_ASK, startingFilters.minPrice ?? 0)));
    const [profit, setProfit] = useState(String(startingTargets.minProfit || ""));
    const [roi, setRoi] = useState(String(startingTargets.minRoi * 100 || ""));
    const [minGrade, setGrade] = useState(session?.minGrade ?? initialGrade);
    const [format, setFormat] = useState<BuyingOption | "all">(session?.format ?? "FIXED_PRICE");
    const minAsk = Math.max(MIN_FLIP_BIN_ASK, Number(minCost));
    const filters: ListingFilters = { kindFilter, minPrice: format === "AUCTION" ? 0 : minAsk, ...(maxCost && { maxPrice: Number(maxCost) }) };
    const targets: Targets = { minProfit: Number(profit), minRoi: Number(roi) / 100 };
    const activeLimits = [kindFilter !== "all" && kindFilter, maxCost && "up to $" + maxCost + " delivered",
        format !== "AUCTION" && "Buy It Now from $" + filters.minPrice, profit && "$" + profit + " minimum profit", roi && roi + "% ROI",
        minGrade > 0 && "potential grade " + minGrade + "+"].filter(Boolean);
    const [text, setText] = useState(session?.text ?? "");
    const [expand, setExpand] = useState(session?.expand ?? true);
    const [run, setRun] = useState<{ id: string; started: number; legs: ActiveLeg[] } | null>(null);
    const [message, setMessage] = useState(session ? leftSearch : "");
    const [error, setError] = useState("");
    const [results, setResults] = useState<Result[]>([]);
    const [detail, setDetail] = useState<BuyingOption | null>(null);
    const [usage, setUsage] = useState<Record<string, AiUsageDay>>({});
    const [lastLegs, setLastLegs] = useState<GuidedHuntLeg[]>([]);
    const liveContext = useRef({ latest, updated, destination, ready });
    liveContext.current = { latest, updated, destination, ready };
    const pending = useRef<{ controller: AbortController; zip: string | null } | null>(null);
    function remember(value: FlipSession | null) {
        writeFlipSession(value); setSession(value);
    }
    useEffect(() => () => pending.current?.controller.abort(new DOMException(leftSearch, "AbortError")), []);
    useEffect(() => { if (!active) pending.current?.controller.abort(new DOMException(leftSearch, "AbortError")); }, [active]);
    useEffect(() => {
        const active = pending.current;
        // Undefined means the saved destination is being checked, including on window focus.
        if (active && destination !== undefined && destination !== active.zip) {
            active.controller.abort(new DOMException(changedDestination, "AbortError"));
        }
    }, [destination]);
    useEffect(() => {
        const legs = run?.legs.length ? run.legs.filter(leg => !leg.waiting) : run ? [{ id: run.id, started: run.started, format: "FIXED_PRICE" as const }] : lastLegs;
        if (!legs.length) return;
        let active = true;
        let reading = false;
        const poll = async () => {
            if (reading) return;
            reading = true;
            try {
                const receipt = await fetchAiUsage(legs[0].id, legs.map(leg => leg.id));
                if (active) {
                    onUsage?.(receipt);
                    setUsage(previous => ({ ...previous, ...Object.fromEntries(legs.map(leg =>
                        [leg.id, { ...receipt, hunt: receipt.hunts?.find(progress => progress.searchId === leg.id) ?? (receipt.hunt?.searchId === leg.id ? receipt.hunt : undefined) }])) }));
                }
            } catch { /* A later poll restores progress without restarting research. */ } finally { reading = false; }
        };
        void poll();
        const timer = run ? setInterval(poll, 2000) : undefined;
        return () => { active = false; clearInterval(timer); };
    }, [run, lastLegs, onUsage]);
    async function start(event: FormEvent) {
        event.preventDefault();
        if (!active || pending.current || !ready || destination === undefined) return;
        if (format === "FIXED_PRICE" && maxCost && minAsk > Number(maxCost)) {
            setError("The minimum item price exceeds your maximum delivered price.");
            return;
        }
        if (session && destination !== session.destination) {
            remember(null); setMessage(changedDestination); setError(""); return;
        }
        const controller = new AbortController(), id = session?.id ?? crypto.randomUUID();
        const submitted: FlipSession = session ?? { id, destination, text, format, filters, targets, expand, minGrade };
        let prepared = Boolean(session?.prepared);
        const { signal } = controller;
        pending.current = { controller, zip: destination };
        remember(submitted);
        onStart?.(id); onBusyChange?.(true);
        setRun({ id, started: Date.now(), legs: [] }); setUsage({}); setLastLegs([]); setError("");
        if (!session) { setResults([]); setDetail(null); }
        setMessage(text.trim() ? "Reading your search…" : "Ranking cards by recent eBay sales.");
        try {
            const plan = session?.prepared ? session.prepared.plan : text.trim() ? await interpretSearchRequest({ query: text.trim(), filters: { ...filters, typeFilter: format } }, id, signal) : null;
            signal.throwIfAborted();
            const intent = plan?.intent;
            const scoped = { ...plan?.marketPreferences, preferRecentSales: true,
                ...(intent && (intent.cardName || intent.cardNumber) && { seed: { name: intent.cardName, number: intent.cardNumber,
                    expand: expand && !intent.cardNumber && !/\b(?:only|exclusively|strictly)\b/i.test(text) } }) };
            const kind = intent?.graded === true ? "graded" : intent?.graded === false ? "raw" : filters.kindFilter;
            if (kind && filters.kindFilter && filters.kindFilter !== "all" && kind !== filters.kindFilter)
                throw new Error("The requested card type conflicts with the selected card filter.");
            const ceiling = Math.min(plan?.maxDelivered ?? Infinity, filters.maxPrice ?? Infinity);
            const actualTargets = { ...targets, minProfit: Math.max(plan?.minProfit ?? 0, targets.minProfit) };
            const asksAuction = /\bauctions?\b/i.test(text);
            const asksFixed = /\b(?:buy it now|fixed.price)\b/i.test(text);
            const both = format === "all" && asksAuction === asksFixed;
            const requestedFormats: BuyingOption[] = plan?.listingFormats ?? (both ? ["FIXED_PRICE", "AUCTION"] : [plan?.format ?? (format === "all" ? "FIXED_PRICE" : format)]);
            const formats = requestedFormats.filter(option => option === "AUCTION" || minAsk <= ceiling);
            if (!formats.length) throw new Error(`The maximum delivered price is below the minimum Buy It Now asking price of $${minAsk}.`);
            const legs = session?.prepared?.legs.filter(leg => formats.includes(leg.format)) ?? formats.map(format => ({ format, id: formats.length > 1 ? newWatchScanId(id) : id, started: Date.now() }));
            for (const leg of legs) restoreWatchBudget(leg.id, id);
            remember({ ...submitted, prepared: { plan, legs } });
            prepared = true;
            setRun(previous => previous && { ...previous, legs }); setLastLegs(legs);
            setMessage([formats.length > 1 ? "Checking Buy It Now listings and auctions together" :
                formats[0] === "AUCTION" ? "Auctions ending within ten hours" : scoped.seed?.name ? "Buy It Now · lowest price plus shipping first" : "Buy It Now · newest across cards",
                scoped.minimumCondition && "Near Mint or better",
                scoped.seed?.expand && !scoped.seed.number ? `Starting with ${scoped.seed.name}. Related cards can come from the same set, the same year or an older release.` : plan?.query,
                Number.isFinite(ceiling) && `Up to $${ceiling.toFixed(2)} delivered`].filter(Boolean).join(" · "));
            const outcome = await runGuidedHuntLegs<Result>({ legs, signal,
                async run(leg, legSignal) {
                    const started = Date.now();
                    setRun(current => current && { ...current, legs: current.legs.map(item => item.id === leg.id ? { ...leg, started } : item) });
                    const result = await runDealHunt(leg.id, { standalone: true, watch: true, listingIds: [], scope: "any_card", goal: "resell",
                        marketPreferences: scoped, targets: actualTargets, minPotentialGrade: minGrade,
                        ...(leg.format === "FIXED_PRICE" && { freshListings: true }),
                        filters: { typeFilter: leg.format, kindFilter: kind, minPrice: leg.format === "AUCTION" ? 0 : minAsk,
                            ...(Number.isFinite(ceiling) && { maxPrice: ceiling }) } }, legSignal);
                    legSignal.throwIfAborted();
                    const listing = selectedHuntListing(result, leg.id, "resell", "any_card", [], leg.format, { allowExpiredBid: true });
                    return { ...result, listing, format: leg.format, targets: actualTargets, destination, receivedAt: Date.now() };
                },
                onResult: (leg, result) => {
                    if (result.listing || result.candidates?.length || result.report.steps.length)
                        setResults(previous => [...previous.filter(item => item.format !== leg.format), result]);
                },
                onWaiting: (leg, at, reason) => setRun(current => current && { ...current, legs: current.legs.map(item =>
                    item.id === leg.id ? { ...item, waiting: { at, reason } } : item) }),
                isOpportunity(result) {
                    const live = liveContext.current, selected = result.listing, evaluation = result.evaluation;
                    if (!selected || !evaluation || !live.ready || live.destination !== result.destination ||
                        (evaluation.listing.shippingDestination ?? null) !== live.destination) return false;
                    const current = reconcileHuntListing(selected, evaluation, live.latest.get(selected.id));
                    const checked = Date.parse(current.listing.termsCheckedAt ?? "");
                    if (!current.currentTerms || (live.updated.get(selected.id) ?? 0) > checked) return false;
                    return result.report.decision === "BUY"
                        ? !!applyVerifiedPurchase(evaluation, result.report.verifiedPurchase, actualTargets, Date.now(), Number.isFinite(ceiling) ? ceiling : undefined)
                        : result.report.decision === "BID" && (result.auctionOpportunity?.validUntil ?? 0) > Date.now() && currentHuntBid("resell", evaluation, actualTargets, Date.now(),
                            Number.isFinite(ceiling) ? ceiling : undefined)?.status === "BID";
                },
            });
            signal.throwIfAborted();
            remember(null);
            setMessage(outcome.report.decision === "BID" ? "Found an auction with a verified bid limit." : "Found a verified flip");
        } catch (err) {
            if (signal.aborted) {
                const reason = signal.reason?.message;
                if (reason !== leftSearch) remember(null);
                setMessage(reason === leftSearch || reason === changedDestination ? reason : "Search stopped");
            } else {
                const resumable = prepared || err instanceof ApiRequestError && err.retryable;
                if (!resumable) remember(null);
                setError(err instanceof Error ? err.message : "Unable to check listings.");
                setMessage(resumable ? "Search paused" : "");
            }
        } finally {
            if (pending.current?.controller === controller) { pending.current = null; setRun(null); onBusyChange?.(false); }
        }
    }
    const completedIds = new Set(results.flatMap(result => [result.listing?.id, ...(result.candidates?.map(row => row.id) ?? [])]));
    const pendingCandidates = [...new Map(lastLegs.flatMap(leg => {
        const progress = usage[leg.id]?.hunt;
        return progress?.searchId === leg.id && Date.parse(progress.startedAt) >= leg.started
            ? progress.candidates ?? [] : [];
    }).filter(row => !completedIds.has(row.id)).map(row => [row.id, row])).values()].slice(-50);
    const waitingLegs = run?.legs.filter(leg => leg.waiting) ?? [];
    const showSetup = !run && !results.length || !!session && !run;
    return <section className={styles.hunt} aria-label="Find a flip">
        <details key={showSetup ? "setup" : "activity"} className={styles.settings} open={showSetup || undefined}>
        <summary>{showSetup ? "Search setup" : "Search settings"}{!showSetup && text && " · " + text}</summary>
        <form id="flip-search-form" onSubmit={start}>
            <label className={styles.guidance}>Which cards should we look for?
                <input type="search" maxLength={300} value={text} disabled={!!session} onChange={event => setText(event.target.value)}
                    placeholder="Card, set or buying goal (optional)" aria-describedby="flip-hint" />
            </label>
            <p className={styles.note} id="flip-hint">Searches English cards on eBay. Leave blank to start with cards showing recent sales.</p>
            <details className={styles.limits}><summary>Search filters{activeLimits.length > 0 && " · " + activeLimits.join(" · ")}</summary>
                <div className={styles.controls}>
                    <label>Card type<select disabled={!!session} value={kindFilter} onChange={e => setKind(e.target.value as typeof kindFilter)}>
                        <option value="all">Raw and graded</option><option value="raw">Raw</option><option value="graded">Graded</option>
                    </select></label>
                    <label>Maximum delivered price ($)<input type="number" min="0.01" step="0.01" value={maxCost} disabled={!!session} onChange={e => setMaxCost(e.target.value)} placeholder="Any" /></label>
                    {format !== "AUCTION" && <label>Minimum Buy It Now asking price ($)<input type="number" min={MIN_FLIP_BIN_ASK} step="0.01" value={minCost} disabled={!!session} onChange={e => setMinCost(e.target.value)} placeholder={String(MIN_FLIP_BIN_ASK)} /></label>}
                    <label>Minimum net profit ($)<input type="number" min="0" step="0.01" value={profit} disabled={!!session} onChange={e => setProfit(e.target.value)} placeholder="Positive profit" /></label>
                    <label>Minimum ROI (%)<input type="number" min="0" step="0.01" value={roi} disabled={!!session} onChange={e => setRoi(e.target.value)} placeholder="Any" /></label>
                    <label>Minimum potential grade<input type="number" min="1" max="10" step="1" value={minGrade || ""} disabled={!!session} onChange={e => setGrade(Number(e.target.value))} placeholder="Any" /></label>
                </div>
            </details>
            <div className={styles.controls}><label>Listing format<select value={format} disabled={!!session}
                onChange={event => setFormat(event.target.value as typeof format)}>
                <option value="FIXED_PRICE">Buy It Now</option><option value="AUCTION">Auctions under 10 hours</option><option value="all">Both</option>
            </select></label>{text.trim() && <label className={styles.expand}><input type="checkbox" checked={expand} disabled={!!session}
                onChange={event => setExpand(event.target.checked)} /> Include related cards</label>}
                {!run && <>
                    <button type="submit" disabled={!ready} className={styles.run}>{session ? "Resume search" : "Find a flip"}</button>
                    {session && <button type="button" onClick={() => { remember(null); setMessage("Search stopped"); setError(""); }}>Stop search</button>}
                </>}
            </div>
        </form></details>
        {run && <div className={styles.heading}><h2>{text || "Finding a flip"}</h2><button type="button" className={styles.stop} onClick={() => pending.current?.controller.abort()}>Stop search</button></div>}
        {ready && destination === null && <ShippingDestination busy={!!run} onSaved={onDestinationSaved} />}
        {message && <p role="status">{message}</p>}
        {waitingLegs.length > 0 && <div className={styles.progress} role="status">
            <h2 className={styles.activity}>Watching for a flip</h2>
            {[...new Set(waitingLegs.map(leg => leg.waiting!.reason))].map(reason => <p key={reason}>{reason}</p>)}
            {waitingLegs.map(leg => <p className={styles.note} key={leg.id}>{leg.format === "AUCTION" ? "Auctions" : "Buy It Now"} · Next check at <time dateTime={new Date(leg.waiting!.at).toISOString()}>{new Date(leg.waiting!.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></p>)}
        </div>}
        {run && <>
            {(run.legs.length ? run.legs : [{ id: run.id, started: run.started, format: "FIXED_PRICE" as const, waiting: undefined }]).filter(leg => !leg.waiting).map(leg => <div key={leg.id}>
                {run.legs.length > 1 && <h2>{leg.format === "AUCTION" ? "Auction search" : "Buy It Now search"}</h2>}
                <HuntProgressPanel searchId={leg.id} startedAt={leg.started} usage={usage[leg.id]} />
            </div>)}
        </>}

        {error && <p className={styles.error} role="alert">{error}</p>}
        {results.map(result => <div key={result.format}><h2>{result.format === "AUCTION" ? "Auction results" : "Buy It Now results"}</h2>
            <DealHuntResult onSnipe={onSnipe} result={result} now={Math.max(now, result.receivedAt)} targets={result.targets} updatedTerms={updated}
                currentListing={result.listing && latest.get(result.listing.id)} destinationReady={ready && destination === result.destination &&
                    (!result.evaluation || (result.evaluation.listing.shippingDestination ?? null) === destination)}
                onEvidence={() => setDetail(previous => previous === result.format ? null : result.format)} shortlistButton={shortlist} />
            {detail === result.format && result.evaluation && result.listing && <AnalysisDetails listing={result.listing} evaluation={result.evaluation}
                minGrade={minGrade} now={now} reviewing={false} showPurchaseScenarios={false} />}
        </div>)}
        {pendingCandidates.length > 0 && <HuntCandidateCards listings={pendingCandidates} now={now} active={!!run?.legs.some(leg => !leg.waiting)} shortlistButton={shortlist} />}
    </section>;
}
