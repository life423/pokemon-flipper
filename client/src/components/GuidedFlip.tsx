import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { DealHuntResponse } from "../../../shared/deal-hunt.ts";
import type { ListingFilters } from "../../../shared/listing-filters.ts";
import type { BuyingOption, ListingSummary, Targets } from "../../../shared/types.ts";
import type { AiUsageDay } from "../../../shared/ai-usage.ts";
import { fetchAiUsage, interpretSearchRequest, runDealHunt } from "../api";
import { selectedHuntListing } from "../search/hunt-result";
import { DealHuntResult, HuntProgressPanel } from "./DealHunt";
import { AnalysisDetails } from "./analysis/AnalysisDetails";
import styles from "./DealHunt.module.css";

type Result = DealHuntResponse & { listing?: ListingSummary; format: BuyingOption; targets: Targets; destination: string | null };
const changedDestination = "The shipping ZIP changed. Start a new hunt for current delivery prices.";
interface Props {
    filters: ListingFilters; targets: Targets; minGrade: number; destination: string | null | undefined; ready: boolean; now: number;
    latest: ReadonlyMap<string, ListingSummary>; updated: ReadonlyMap<string, number>; shortlist: (listing: ListingSummary) => ReactNode;
}

export function GuidedFlip({ filters: initialFilters, targets: initialTargets, minGrade: initialGrade, destination, ready, now, latest, updated, shortlist }: Props) {
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
    const [run, setRun] = useState<{ id: string; started: number } | null>(null);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const [results, setResults] = useState<Result[]>([]);
    const [detail, setDetail] = useState<BuyingOption | null>(null);
    const [usage, setUsage] = useState<AiUsageDay | null>(null);
    const [interruptedId, setInterruptedId] = useState<string | null>(null);
    const pending = useRef<{ controller: AbortController; zip: string | null } | null>(null);
    useEffect(() => () => pending.current?.controller.abort(), []);
    useEffect(() => {
        const active = pending.current;
        // Undefined means the saved destination is being checked, including on window focus.
        if (active && destination !== undefined && destination !== active.zip) {
            active.controller.abort(new DOMException(changedDestination, "AbortError"));
        }
    }, [destination]);
    useEffect(() => {
        const id = run?.id ?? interruptedId;
        if (!id) return;
        let active = true;
        const poll = async () => {
            try { const receipt = await fetchAiUsage(id); if (active) setUsage(receipt); } catch { /* Next poll resumes. */ }
        };
        void poll();
        const timer = run ? setInterval(poll, 2000) : undefined;
        return () => { active = false; clearInterval(timer); };
    }, [run, interruptedId]);
    async function start(event: FormEvent) {
        event.preventDefault();
        if (pending.current || !ready || destination === undefined) return;
        if (maxCost && Number(minCost) > Number(maxCost)) {
            setError("The minimum item price exceeds your maximum delivered price.");
            return;
        }
        const controller = new AbortController(), id = crypto.randomUUID();
        const { signal } = controller;
        pending.current = { controller, zip: destination };
        setInterruptedId(null);
        setRun({ id, started: Date.now() }); setUsage(null); setError(""); setResults([]); setDetail(null);
        setMessage(text.trim() ? "Interpreting your hunt…" : "Ranking cards by recent eBay sales.");
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
            const formats: BuyingOption[] = both ? ["FIXED_PRICE", "AUCTION"] : [plan?.format ?? (format === "all" ? "FIXED_PRICE" : format)];
            for (const leg of formats) {
                signal.throwIfAborted();
                const label = leg === "AUCTION" ? "Auctions ending within ten hours" : "Buy It Now listings · newest first";
                setMessage([label, plan?.summary].filter(Boolean).join(" · "));
                const result = await runDealHunt(id, { standalone: true, listingIds: [], scope: "any_card", goal: "resell",
                    marketPreferences: scoped, targets: actualTargets, minPotentialGrade: minGrade,
                    ...(leg === "FIXED_PRICE" && { freshListings: true }),
                    filters: { typeFilter: leg, kindFilter: kind, minPrice: leg === "AUCTION" ? 0 : filters.minPrice,
                        ...(Number.isFinite(ceiling) && { maxPrice: ceiling }) } }, signal);
                signal.throwIfAborted();
                const listing = selectedHuntListing(result, id, "resell", "any_card", [], leg);
                setResults(previous => [...previous, { ...result, listing, format: leg, targets: actualTargets, destination }]);
            }
            setMessage("Hunt complete");
        } catch (err) {
            setInterruptedId(id);
            if (signal.aborted) setMessage(signal.reason?.message === changedDestination ? changedDestination : "Hunt stopped");
            else { setError(err instanceof Error ? err.message : "The hunt could not finish."); setMessage(""); }
        } finally {
            if (pending.current?.controller === controller) { pending.current = null; setRun(null); }
        }
    }
    return <section className={styles.hunt} aria-label="Find a flip">
        <form onSubmit={start}>
            <label className={styles.guidance}>Where should the hunt start?
                <input type="search" maxLength={300} value={text} disabled={!!run} onChange={event => setText(event.target.value)}
                    placeholder="Card, set or buying goal (optional)" aria-describedby="flip-hint" />
            </label>
            <p className={styles.note} id="flip-hint">Leave blank to start with cards showing recent eBay sales.</p>
            <details className={styles.limits}><summary>Hunt filters{activeLimits.length > 0 && " · " + activeLimits.join(" · ")}</summary>
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
            <div className={styles.controls}><label>Hunt format<select value={format} disabled={!!run}
                onChange={event => setFormat(event.target.value as typeof format)}>
                <option value="FIXED_PRICE">Buy It Now</option><option value="AUCTION">Auctions under 10 hours</option><option value="all">Both</option>
            </select></label>{text.trim() && <label className={styles.expand}><input type="checkbox" checked={expand} disabled={!!run}
                onChange={event => setExpand(event.target.checked)} /> Include related cards</label>}
                <button type="submit" disabled={!!run || !ready} className={styles.run}>Start hunt</button>
            </div>
        </form>
        {message && <p role="status">{message}</p>}
        {!run && interruptedId && usage?.hunt?.searchId === interruptedId &&
            <p className={styles.note}>{usage.hunt.discovered} listings found · {usage.hunt.screened} pricing checks · {usage.hunt.reviewed} copies checked before the interruption</p>}
        {run && <HuntProgressPanel searchId={run.id} startedAt={run.started} usage={usage} onStop={() => pending.current?.controller.abort()} />}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {results.map(result => <div key={result.format}><h2>{result.format === "AUCTION" ? "Auction results" : "Buy It Now results"}</h2>
            <DealHuntResult result={result} now={now} targets={result.targets} updatedTerms={updated}
                currentListing={result.listing && latest.get(result.listing.id)} destinationReady={ready && destination === result.destination &&
                    (!result.evaluation || (result.evaluation.listing.shippingDestination ?? null) === destination)}
                onEvidence={() => setDetail(previous => previous === result.format ? null : result.format)} shortlistButton={shortlist} />
            {detail === result.format && result.evaluation && result.listing && <AnalysisDetails listing={result.listing} evaluation={result.evaluation}
                minGrade={minGrade} now={now} reviewing={false} showPurchaseScenarios={false} />}
        </div>)}
    </section>;
}
