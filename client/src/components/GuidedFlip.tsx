import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { HUNT_RECHECK_MS, type DealHuntResponse } from "../../../shared/deal-hunt.ts";
import type { ListingFilters } from "../../../shared/listing-filters.ts";
import type { BuyingOption, ListingSummary, Targets } from "../../../shared/types.ts";
import type { AiUsageDay } from "../../../shared/ai-usage.ts";
import { fetchAiUsage, interpretSearchRequest, newWatchScanId, runDealHunt } from "../api";
import { currentHuntBid, reconcileHuntListing, selectedHuntListing } from "../search/hunt-result";
import { runGuidedHuntLegs, type GuidedHuntLeg } from "../search/guided-hunt";
import { applyVerifiedPurchase } from "../../../shared/money/verified-purchase.ts";
import { DealHuntResult, HuntProgressPanel, HuntCandidateCards } from "./DealHunt";
import { AnalysisDetails } from "./analysis/AnalysisDetails";
import { ShippingDestination } from "./ShippingDestination";
import type { SniperDraft } from "../search/sniper-draft";
import styles from "./DealHunt.module.css";

type Result = DealHuntResponse & { listing?: ListingSummary; format: BuyingOption; targets: Targets; destination: string | null };
const changedDestination = "The shipping ZIP changed. Search again for updated delivery prices.";

interface Props {
    onSnipe?: (draft: SniperDraft) => void;
    filters: ListingFilters; targets: Targets; minGrade: number; destination: string | null | undefined; ready: boolean; now: number;
    latest: ReadonlyMap<string, ListingSummary>; updated: ReadonlyMap<string, number>; shortlist: (listing: ListingSummary) => ReactNode;
    active?: boolean; onStart?: (id: string) => void; onBusyChange?: (busy: boolean) => void; onDestinationSaved?: (zip: string) => void;
}

export function GuidedFlip({ filters: initialFilters, targets: initialTargets, minGrade: initialGrade, destination, ready, now, latest, updated, shortlist,
    active = true, onSnipe, onStart, onBusyChange, onDestinationSaved }: Props) {
    const [kindFilter, setKind] = useState<NonNullable<ListingFilters["kindFilter"]>>(initialFilters.kindFilter ?? "all");
    const [maxCost, setMaxCost] = useState(String(initialFilters.maxPrice ?? ""));
    const [minCost, setMinCost] = useState(String(initialFilters.minPrice || ""));
    const [profit, setProfit] = useState(String(initialTargets.minProfit || ""));
    const [roi, setRoi] = useState(String(initialTargets.minRoi * 100 || ""));
    const [minGrade, setGrade] = useState(initialGrade);
    const filters: ListingFilters = { kindFilter, minPrice: Number(minCost), ...(maxCost && { maxPrice: Number(maxCost) }) };
    const targets: Targets = { minProfit: Number(profit), minRoi: Number(roi) / 100 };
    const activeLimits = [kindFilter !== "all" && kindFilter, maxCost && "up to $" + maxCost + " delivered",
        minCost && "Buy It Now from $" + minCost, profit && "$" + profit + " minimum profit", roi && roi + "% ROI",
        minGrade > 0 && "potential grade " + minGrade + "+"].filter(Boolean);
    const [text, setText] = useState("");
    const [format, setFormat] = useState<BuyingOption | "all">("FIXED_PRICE");
    const [expand, setExpand] = useState(true);
    const [run, setRun] = useState<{ id: string; started: number; legs: GuidedHuntLeg[] } | null>(null);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const [results, setResults] = useState<Result[]>([]);
    const [detail, setDetail] = useState<BuyingOption | null>(null);
    const [usage, setUsage] = useState<Record<string, AiUsageDay>>({});
    const [lastLegs, setLastLegs] = useState<GuidedHuntLeg[]>([]);
    const [legErrors, setLegErrors] = useState<{ format: BuyingOption; message: string }[]>([]);
    const liveContext = useRef({ latest, updated, destination, ready });
    liveContext.current = { latest, updated, destination, ready };
    const pending = useRef<{ controller: AbortController; zip: string | null } | null>(null);
    useEffect(() => () => pending.current?.controller.abort(), []);
    useEffect(() => { if (!active) pending.current?.controller.abort(); }, [active]);
    useEffect(() => {
        const active = pending.current;
        // Undefined means the saved destination is being checked, including on window focus.
        if (active && destination !== undefined && destination !== active.zip) {
            active.controller.abort(new DOMException(changedDestination, "AbortError"));
        }
    }, [destination]);
    useEffect(() => {
        const legs = run?.legs.length ? run.legs : run ? [{ id: run.id, started: run.started, format: "FIXED_PRICE" as const }] : lastLegs;
        if (!legs.length) return;
        let active = true;
        let reading = false;
        const poll = async () => {
            if (reading) return;
            reading = true;
            try {
                await Promise.all(legs.map(async leg => {
                    try { const receipt = await fetchAiUsage(leg.id, leg.id); if (active) setUsage(previous => ({ ...previous, [leg.id]: receipt })); }
                    catch { /* Next poll resumes without restarting research. */ }
                }));
            } finally { reading = false; }
        };
        void poll();
        const timer = run ? setInterval(poll, 2000) : undefined;
        return () => { active = false; clearInterval(timer); };
    }, [run, lastLegs]);
    async function start(event: FormEvent) {
        event.preventDefault();
        if (!active || pending.current || !ready || destination === undefined) return;
        if (maxCost && Number(minCost) > Number(maxCost)) {
            setError("The minimum item price exceeds your maximum delivered price.");
            return;
        }
        const controller = new AbortController(), id = crypto.randomUUID();
        const { signal } = controller;
        pending.current = { controller, zip: destination };
        onStart?.(id); onBusyChange?.(true);
        setRun({ id, started: Date.now(), legs: [] }); setUsage({}); setLastLegs([]); setLegErrors([]); setError(""); setResults([]); setDetail(null);
        setMessage(text.trim() ? "Reading your search…" : "Ranking cards by recent eBay sales.");
        try {
            const plan = text.trim() ? await interpretSearchRequest({ query: text.trim(), filters: { ...filters, typeFilter: format } }, id, signal) : null;
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
            const formats: BuyingOption[] = plan?.listingFormats ?? (both ? ["FIXED_PRICE", "AUCTION"] : [plan?.format ?? (format === "all" ? "FIXED_PRICE" : format)]);
            const legs = formats.map(format => ({ format, id: formats.length > 1 ? newWatchScanId(id) : id, started: Date.now() }));
            setRun(previous => previous && { ...previous, legs }); setLastLegs(legs);
            setMessage([formats.length > 1 ? "Checking Buy It Now listings and auctions together" :
                formats[0] === "AUCTION" ? "Auctions ending within ten hours" : "Buy It Now listings · newest first", scoped.seed?.expand ? `Starting with ${scoped.seed.name}. After two misses, checking the same set and same-year or older releases.` : plan?.query,
                Number.isFinite(ceiling) && `Up to $${ceiling.toFixed(2)} delivered`].filter(Boolean).join(" · "));
            const attempted = new Set<string>();
            let failures = 0;
            const outcome = await runGuidedHuntLegs<Result>({ legs, signal,
                async run(leg, legSignal) {
                    if (attempted.has(leg.id)) setMessage(leg.format === "AUCTION" ? "Rechecking eligible auctions" : "Rechecking Buy It Now listings");
                    attempted.add(leg.id);
                    const result = await runDealHunt(leg.id, { watch: true, standalone: true, listingIds: [], scope: "any_card", goal: "resell",
                        marketPreferences: scoped, targets: actualTargets, minPotentialGrade: minGrade,
                        ...(leg.format === "FIXED_PRICE" && { freshListings: true }),
                        filters: { typeFilter: leg.format, kindFilter: kind, minPrice: leg.format === "AUCTION" ? 0 : filters.minPrice,
                            ...(Number.isFinite(ceiling) && { maxPrice: ceiling }) } }, legSignal);
                    legSignal.throwIfAborted();
                    const listing = selectedHuntListing(result, leg.id, "resell", "any_card", [], leg.format);
                    return { ...result, listing, format: leg.format, targets: actualTargets, destination };
                },
                onResult: (_leg, result) => setResults(previous => [...previous.filter(item => item.format !== result.format), result]),
                continuation: {
                    next(result) {
                        if (result.report.providerStop === "account") throw new Error(result.report.reason);
                        return { at: result.nextCheckAt ?? Date.now() + HUNT_RECHECK_MS,
                            reason: result.waitingFor === "provider" ? "Waiting for provider availability" : "Waiting for the next inventory check" };
                    },
                    waiting: (leg, at, reason) => setMessage(`${leg.format === "AUCTION" ? "Auctions" : "Buy It Now"} · ${reason}. Resuming at ${new Date(at).toLocaleTimeString()}.`),
                },
                onFailure: (leg, failure) => { failures++; setLegErrors(previous => [...previous, { format: leg.format, message: failure.message }]); },
                isOpportunity(result) {
                    const live = liveContext.current, selected = result.listing, evaluation = result.evaluation;
                    if (!selected || !evaluation || !live.ready || live.destination !== result.destination ||
                        (evaluation.listing.shippingDestination ?? null) !== live.destination) return false;
                    const current = reconcileHuntListing(selected, evaluation, live.latest.get(selected.id));
                    const checked = Date.parse(current.listing.termsCheckedAt ?? "");
                    if (!current.currentTerms || (live.updated.get(selected.id) ?? 0) > checked) return false;
                    return result.report.decision === "BUY"
                        ? !!applyVerifiedPurchase(evaluation, result.report.verifiedPurchase, actualTargets, Date.now())
                        : result.report.decision === "BID" && currentHuntBid("resell", evaluation, actualTargets, Date.now(),
                            Number.isFinite(ceiling) ? ceiling : undefined)?.status === "BID";
                },
            });
            setMessage(outcome.found ? "Found a verified flip" : failures === legs.length ? "Search interrupted" :
                failures ? "One listing format was interrupted" : "No verified flip found in this search");
        } catch (err) {
            if (signal.aborted) setMessage(signal.reason?.message === changedDestination ? changedDestination : "Search stopped");
            else { setError(err instanceof Error ? err.message : "The search could not finish."); setMessage(""); }
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
    return <section className={styles.hunt} aria-label="Find a flip">
        <form onSubmit={start}>
            <label className={styles.guidance}>Which cards should we look for?
                <input type="search" maxLength={300} value={text} disabled={!!run} onChange={event => setText(event.target.value)}
                    placeholder="Card, set or buying goal (optional)" aria-describedby="flip-hint" />
            </label>
            <p className={styles.note} id="flip-hint">Leave blank to start with cards showing recent eBay sales.</p>
            <details className={styles.limits}><summary>Search filters{activeLimits.length > 0 && " · " + activeLimits.join(" · ")}</summary>
                <div className={styles.controls}>
                    <label>Card type<select disabled={!!run} value={kindFilter} onChange={e => setKind(e.target.value as typeof kindFilter)}>
                        <option value="all">Raw and graded</option><option value="raw">Raw</option><option value="graded">Graded</option>
                    </select></label>
                    <label>Maximum delivered price ($)<input type="number" min="0.01" step="0.01" value={maxCost} disabled={!!run} onChange={e => setMaxCost(e.target.value)} placeholder="Any" /></label>
                    <label>Minimum Buy It Now price ($)<input type="number" min="0" step="0.01" value={minCost} disabled={!!run} onChange={e => setMinCost(e.target.value)} placeholder="Any" /></label>
                    <label>Minimum net profit ($)<input type="number" min="0" step="0.01" value={profit} disabled={!!run} onChange={e => setProfit(e.target.value)} placeholder="Positive profit" /></label>
                    <label>Minimum ROI (%)<input type="number" min="0" step="0.01" value={roi} disabled={!!run} onChange={e => setRoi(e.target.value)} placeholder="Any" /></label>
                    <label>Minimum potential grade<input type="number" min="1" max="10" step="1" value={minGrade || ""} disabled={!!run} onChange={e => setGrade(Number(e.target.value))} placeholder="Any" /></label>
                </div>
            </details>
            <div className={styles.controls}><label>Listing format<select value={format} disabled={!!run}
                onChange={event => setFormat(event.target.value as typeof format)}>
                <option value="FIXED_PRICE">Buy It Now</option><option value="AUCTION">Auctions under 10 hours</option><option value="all">Both</option>
            </select></label>{text.trim() && <label className={styles.expand}><input type="checkbox" checked={expand} disabled={!!run}
                onChange={event => setExpand(event.target.checked)} /> Include related cards</label>}
                <button type="submit" disabled={!!run || !ready} className={styles.run}>Find a flip</button>
            </div>
        </form>
        {ready && destination === null && <ShippingDestination busy={!!run} onSaved={onDestinationSaved} />}
        {message && <p role="status">{message}</p>}
        {run && <>
            <button type="button" className={styles.stop} onClick={() => pending.current?.controller.abort()}>Stop search</button>
            {(run.legs.length ? run.legs : [{ id: run.id, started: run.started, format: "FIXED_PRICE" as const }]).map(leg => <div key={leg.id}>
                {run.legs.length > 1 && <h2>{leg.format === "AUCTION" ? "Auction search" : "Buy It Now search"}</h2>}
                <HuntProgressPanel searchId={leg.id} startedAt={leg.started} usage={usage[leg.id]} />
            </div>)}
        </>}
        {pendingCandidates.length > 0 && <HuntCandidateCards listings={pendingCandidates} now={now} active={!!run} shortlistButton={shortlist} />}
        {legErrors.map(failure => <p key={failure.format} className={styles.error} role="alert">
            {failure.format === "AUCTION" ? "Auction search" : "Buy It Now search"} interrupted: {failure.message}
        </p>)}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {results.map(result => <div key={result.format}><h2>{result.format === "AUCTION" ? "Auction results" : "Buy It Now results"}</h2>
            <DealHuntResult result={result} onSnipe={onSnipe} now={now} targets={result.targets} updatedTerms={updated}
                currentListing={result.listing && latest.get(result.listing.id)} destinationReady={ready && destination === result.destination &&
                    (!result.evaluation || (result.evaluation.listing.shippingDestination ?? null) === destination)}
                onEvidence={() => setDetail(previous => previous === result.format ? null : result.format)} shortlistButton={shortlist} />
            {detail === result.format && result.evaluation && result.listing && <AnalysisDetails listing={result.listing} evaluation={result.evaluation}
                minGrade={minGrade} now={now} reviewing={false} showPurchaseScenarios={false} />}
        </div>)}
    </section>;
}
