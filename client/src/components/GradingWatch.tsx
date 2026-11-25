import { useEffect, useRef, useState } from "react";
import { GRADING_WATCH_DURATION_MS, GRADING_WATCH_INTERVAL_MS, type GradingOpportunity } from "../../../shared/grading-watch.ts";
import type { ListingSummary } from "../../../shared/types.ts";
import type { BuyerListingReview } from "../../../shared/wait-skip-review.ts";
import { SALES_ACTIVITY_DAYS } from "../../../shared/sales-activity.ts";
import { dollars } from "../format";
import styles from "./ResaleReceipts.module.css";

const notifiedKey = "pf:grading-watch:notified:v1";
const day = 86_400_000;

export function rememberGradingAlerts(listingIds: string[], now: number, storage: Pick<Storage, "getItem" | "setItem">) {
    const recorded: unknown = JSON.parse(storage.getItem(notifiedKey) ?? "{}");
    const seen = new Map<string, number>(Object.entries(recorded && typeof recorded === "object" ? recorded : {})
        .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > now - day));
    const added: string[] = [];
    for (const id of listingIds) if (!seen.has(id)) { seen.set(id, now); added.push(id); }
    storage.setItem(notifiedKey, JSON.stringify(Object.fromEntries(seen)));
    return added;
}

interface Watch { until: number; next: number; checks: number }
export function startGradingWatch(now: number): Watch {
    return { until: now + GRADING_WATCH_DURATION_MS, next: now + GRADING_WATCH_INTERVAL_MS, checks: 0 };
}
export function takeWatchCheck(watch: Watch, now: number, available: boolean): Watch | null {
    if (!available || watch.checks >= 2 || now >= watch.until || now < watch.next) return null;
    return { ...watch, checks: watch.checks + 1, next: now + GRADING_WATCH_INTERVAL_MS };
}

interface Props {
    listings: ListingSummary[];
    decisions: Record<string, Pick<BuyerListingReview, "decision" | "gradingOpportunity"> & { expiredQuote?: true }>;
    now: number; canScan: boolean; onScan: (signal: AbortSignal) => Promise<number>;
    onOpen: (id: string, opener: HTMLElement) => void;
    onRecheck: (id: string) => void;
}

function Opportunity({ value }: { value: GradingOpportunity }) {
    const { grader, likely, lower } = value;
    const [likelySales, lowerSales, days] = likely.sales60 !== undefined && lower.sales60 !== undefined
        ? [likely.sales60, lower.sales60, SALES_ACTIVITY_DAYS]
        : [likely.sales30, lower.sales30, 30];
    const date = new Date(value.listingDate).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return <p>{value.dateSource === "listed" ? "Listed" : "Listing created"} {date}. Buy for {dollars(value.delivered)} delivered. Grading and submission shipping add {dollars(value.gradingCosts)}.
        {" "}Estimated profit after selling costs is <strong>{dollars(likely.profit)} at {grader} {likely.grade}</strong> and {dollars(lower.profit)} at {grader} {lower.grade}.
        {" "}In the last {days} days, {likelySales} matching {likelySales === 1 ? "sale closed" : "sales closed"} at {grader} {likely.grade} and {lowerSales} at {grader} {lower.grade}.</p>;
}

export function GradingWatch({ listings, decisions, now, canScan, onScan, onOpen, onRecheck }: Props) {
    const [watch, setWatch] = useState<Watch | null>(null);
    const session = useRef(watch);
    const [announcement, setAnnouncement] = useState("");
    const [scanStatus, setScanStatus] = useState("");
    const controller = useRef<AbortController | null>(null);
    const lastMatches = useRef(new Map<string, { listing: ListingSummary; value: GradingOpportunity }>());
    useEffect(() => () => { controller.current?.abort(); }, []);
    const announced = useRef(new Set<string>());
    const active = !!watch && now < watch.until;
    const matches = active ? listings.flatMap(listing => {
        const result = decisions[listing.id], value = result?.gradingOpportunity;
        return result?.decision === "BUY" && value && value.validUntil > now ? [{ listing, value }] : [];
    }) : [];
    const historical = [...lastMatches.current.values()].filter(({ listing, value }) => value.validUntil <= now &&
        (decisions[listing.id]?.expiredQuote || !decisions[listing.id]));
    const matchIds = JSON.stringify(matches.map(match => match.listing.id));
    useEffect(() => {
        const current = session.current;
        if (!current || !active || controller.current) return;
        const next = takeWatchCheck(current, Date.now(), canScan && document.visibilityState === "visible");
        if (!next) return;
        session.current = next; setWatch(next);
        const job = new AbortController();
        controller.current = job;
        setScanStatus("Checking eBay for new listings…");
        void onScan(job.signal).then(found => {
            if (!job.signal.aborted) setScanStatus(found ? `Found ${found} new ${found === 1 ? "listing" : "listings"} for review.` : "Latest check found no new matching listings.");
        }).catch(error => {
            if (!job.signal.aborted) {
                session.current = null; setWatch(null);
                setScanStatus(`Watch stopped. ${error instanceof Error ? error.message : "The new-listing check failed."}`);
            }
        }).finally(() => { if (controller.current === job) controller.current = null; });
    }, [now, active, canScan, onScan]);
    useEffect(() => {
        if (!active) return;
        for (const match of matches) lastMatches.current.set(match.listing.id, match);
        const ids: string[] = JSON.parse(matchIds);
        const fresh = ids.filter(id => !announced.current.has(id));
        if (!fresh.length) return;
        let added = fresh;
        try { added = rememberGradingAlerts(fresh, Date.now(), window.localStorage); } catch { /* Keep session deduplication when storage is unavailable. */ }
        for (const id of fresh) announced.current.add(id);
        if (added.length) setAnnouncement(`${added.length} new grading ${added.length === 1 ? "opportunity" : "opportunities"} found.`);
    }, [active, matchIds]);
    function toggle() {
        const next = active ? null : startGradingWatch(Date.now());
        controller.current?.abort(); controller.current = null;
        session.current = next; setWatch(next); setAnnouncement(""); setScanStatus("");
    }
    return <section className={styles.panel} aria-label="Newly listed grading watch">
        <button type="button" aria-pressed={active} onClick={toggle}>{active ? "Stop grading watch" : "Watch for grading opportunities"}</button>
        <p>{active ? `Watching this search until ${new Date(watch.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. ${watch.checks} of 2 new-listing checks used.`
            : "Watch this search for 30 minutes. While Results is open, up to two checks look for raw Buy It Now listings from the last 24 hours using this search’s remaining allowance."}</p>
        {scanStatus && <p role="status">{scanStatus}</p>}
        <span role="status" className={styles.announcement}>{active && matches.length > 0 && announcement}</span>
        {matches.map(({ listing, value }) => <article key={listing.id}>
            <strong>{listing.title}</strong>
            <Opportunity value={value} />
            <button type="button" onClick={event => onOpen(listing.id, event.currentTarget)}>View listing analysis</button>
        </article>)}
        {historical.map(({ listing, value }) => <article key={listing.id}><strong>{listing.title}</strong>
            <p>Previously flagged at {dollars(value.delivered)} delivered. The purchase quote has expired.</p>
            <button type="button" disabled={!decisions[listing.id]?.expiredQuote} onClick={() => onRecheck(listing.id)}>
                {decisions[listing.id] ? "Recheck price and availability" : "Checking price and availability…"}
            </button>
        </article>)}
    </section>;
}
