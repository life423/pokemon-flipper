import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_SNIPER_LEAD_SECONDS } from "../../../shared/sniper.ts";
import type { SniperJob, SniperQuote } from "../../../shared/sniper.ts";
import { REMINDER_WINDOW_HOURS, withinReminderWindow } from "../../../shared/sniper.ts";
import { MONEY_CONFIG } from "../../../shared/money.ts";
import { acquisitionCost } from "../../../shared/money.ts";
import { ApiRequestError, armSnipe, cancelSnipe, fetchAuctionReminders, previewSnipe } from "../api";
import { dollars } from "../../../shared/format.ts";
import { useNow } from "../useNow";
import { EbayBuyerAccount } from "./EbayBuyerAccount";
import styles from "./AuctionSniper.module.css";

const endDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
const statusLabel: Record<SniperJob["status"], string> = {
    ARMED: "Scheduled", REMINDER: "Reminder issued", SUBMITTING: "In progress",
    SUBMITTED: "Completed", SKIPPED: "Skipped", CANCELLED: "Cancelled", UNCERTAIN: "Check auction",
};

function Countdown({ endTime }: { endTime: string }) {
    const now = useNow(1000);
    const seconds = Math.max(0, Math.ceil((Date.parse(endTime) - now) / 1000));
    if (!seconds) return <>Ended</>;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    return <>{hours > 0 ? `${hours}h ` : ""}{minutes > 0 || hours > 0 ? `${minutes}m ` : ""}{seconds % 60}s left</>;
}

function reminderError(cause: unknown, fallback: string) {
    return cause instanceof ApiRequestError && cause.code === "AUCTION_INPUT" ? cause.message : fallback;
}

function PlanForm({ onSaved }: { onSaved: (job: SniperJob) => void }) {
    const [url, setUrl] = useState("");
    const [quote, setQuote] = useState<SniperQuote | null>(null);
    const [bid, setBid] = useState("");
    const [working, setWorking] = useState<"preview" | "arm" | null>(null);
    const [error, setError] = useState("");
    const now = useNow(1000);
    const maxBid = Number(bid);
    const validBid = /^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(bid) && maxBid > 0 && Number.isFinite(maxBid);
    const withinWindow = quote && withinReminderWindow({ buyingOption: "AUCTION", endTime: quote.endTime }, now);
    const leadSeconds = DEFAULT_SNIPER_LEAD_SECONDS.reminder;
    const tooLate = quote && Date.parse(quote.endTime) - now <= leadSeconds * 1000;
    let blocked: string | null = null;
    if (quote) {
        if (!withinWindow) blocked = `Choose an active auction ending within ${REMINDER_WINDOW_HOURS} hours.`;
        else if (tooLate) blocked = `The ${leadSeconds}-second scheduling deadline has passed.`;
        else if (quote.minimumBid == null || quote.minimumBid <= 0) blocked = "eBay hasn’t confirmed the next minimum bid. Check the auction again.";
        else if (validBid && maxBid < Math.max(quote.minimumBid, quote.currentBid ?? 0)) blocked = "The bid needed exceeds your limit.";
    }
    const canArm = quote && validBid && !blocked && !working;
    function resetPreview() { setQuote(null); setBid(""); setError(""); }

    const preview = useCallback(async (value: string, signal?: AbortSignal) => {
        if (signal?.aborted) return;
        setWorking("preview"); setQuote(null); setBid(""); setError("");
        try {
            const { quote: fresh } = await previewSnipe(value, "reminder", undefined, signal);
            if (signal?.aborted) return;
            setQuote(fresh);
        } catch (cause) { if (!signal?.aborted) setError(reminderError(cause, "We couldn’t confirm the auction details with eBay. Check the listing and try again.")); }
        finally { if (!signal?.aborted) setWorking(null); }
    }, []);
    function check(event: FormEvent) {
        event.preventDefault();
        if (!working && url.trim()) void preview(url.trim());
    }
    async function arm(event: FormEvent) {
        event.preventDefault();
        if (!canArm || !quote) return;
        setWorking("arm"); setError("");
        try {
            const { job } = await armSnipe(quote, "reminder", maxBid, undefined);
            onSaved(job); setQuote(null); setBid(""); setUrl("");
        } catch (cause) { setError(reminderError(cause, "We couldn’t confirm the reminder. Check Your auctions before trying again.")); }
        finally { setWorking(null); }
    }
    return <section className={styles.planner} aria-label="Plan an auction">
        <h3>Plan an auction</h3>
        <form className={styles.lookup} onSubmit={check}>
            <label>eBay auction link or item number
                <input type="text" value={url} placeholder="Paste an eBay auction link" disabled={!!working}
                    onChange={event => { setUrl(event.target.value); resetPreview(); }} required />
            </label>
            <button className={styles.secondary} type="submit" disabled={!!working || !url.trim()}>{working === "preview" ? "Checking…" : "Check auction"}</button>
        </form>
        {error && <p role="alert" className={styles.caution}>{error}</p>}
        {quote && <form className={styles.terms} onSubmit={arm}>
            <h4><a href={quote.url} target="_blank" rel="noreferrer">{quote.title} ↗</a></h4>
            <dl className={styles.facts}>
                <div><dt>Current bid</dt><dd>{dollars(quote.currentBid)}</dd></div>
                <div><dt>Next minimum bid</dt><dd>{quote.minimumBid == null ? "Check on eBay" : dollars(quote.minimumBid)}</dd></div>
                <div><dt>Shipping</dt><dd>{quote.shipping == null ? "Unquoted" : quote.shipping === 0 ? "Free" : dollars(quote.shipping)}</dd></div>
                <div><dt>Auction ends</dt><dd><time dateTime={quote.endTime}>{endDate.format(new Date(quote.endTime))}</time></dd></div>
            </dl>
            <label className={styles.bid}>Your maximum item bid (USD)
                <input type="number" min="0.01" step="0.01" required inputMode="decimal" value={bid} disabled={!!working}
                    onChange={event => setBid(event.target.value)} placeholder="0.00" />
            </label>
            {validBid && quote.shipping != null && <p>At your maximum, estimated total with shipping and tax is <strong>{dollars(acquisitionCost(maxBid, quote.shipping, MONEY_CONFIG.buying))}</strong>.</p>}
            {blocked && <p className={styles.caution}>{blocked}</p>}
            <div className={styles.confirm}>
                <button className={styles.primary} type="submit" disabled={!canArm}>{working === "arm" ? "Scheduling…" : "Set reminder"}</button>
                <p>Keep the app open for your one-minute reminder. You place the bid on eBay.</p>
            </div>
        </form>}
    </section>;
}

export function AuctionSniper({ returnNotice }: { returnNotice?: string }) {
    const [jobs, setJobs] = useState<SniperJob[] | null>(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [cancelling, setCancelling] = useState("");
    const [dismissed, setDismissed] = useState<string[]>([]);
    const request = useRef<AbortController | null>(null);
    const needsLocalhost = typeof window !== "undefined" && ["127.0.0.1", "[::1]"].includes(window.location.hostname);
    useEffect(() => {
        if (needsLocalhost) {
            // eBay returns to localhost, where the browser must still have its consent cookie.
            const home = new URL("/?view=sniper", window.location.origin);
            home.hostname = "localhost";
            window.location.replace(home.href);
        }
    }, [needsLocalhost]);
    const refresh = useCallback(async () => {
        if (request.current && !request.current.signal.aborted) return;
        const controller = new AbortController(); request.current = controller;
        try {
            const result = await fetchAuctionReminders(controller.signal);
            if (!controller.signal.aborted) { setJobs(result.jobs); setError(""); }
        } catch { if (!controller.signal.aborted) setError("We couldn’t load your auction reminders. Try again."); }
        finally { if (request.current === controller) request.current = null; }
    }, []);
    const now = Date.now();
    const nextCheck = (jobs ?? []).reduce((delay, job) => {
        const end = Date.parse(job.quote.endTime);
        if (job.status === "REMINDER" && end > now) return Math.min(delay, end - now + 100);
        if (job.status !== "ARMED") return delay;
        const untilDue = end - job.leadSeconds * 1000 - now;
        return Math.min(delay, Math.max(1500, Math.min(60_000, untilDue + 250)));
    }, Infinity);
    useEffect(() => {
        void refresh();
        window.addEventListener("focus", refresh);
        return () => { window.removeEventListener("focus", refresh); request.current?.abort(); };
    }, [refresh]);
    useEffect(() => {
        if (!Number.isFinite(nextCheck)) return;
        const timer = window.setInterval(refresh, nextCheck);
        return () => window.clearInterval(timer);
    }, [refresh, nextCheck]);

    function update(job: SniperJob) {
        request.current?.abort();
        setJobs(previous => [job, ...(previous ?? []).filter(other => other.id !== job.id)]);
        setError(""); setNotice(`${statusLabel[job.status]} · ${job.quote.title}`);
    }
    async function cancel(id: string) {
        setCancelling(id); setNotice("");
        try { update((await cancelSnipe(id)).job); return true; }
        catch (cause) { setError(reminderError(cause, "We couldn’t confirm the cancellation. Refresh your auctions to check.")); return false; }
        finally { setCancelling(""); }
    }
    const reminders = jobs?.filter(job => job.status === "REMINDER" && !dismissed.includes(job.id) && Date.parse(job.quote.endTime) > now) ?? [];
    return <>
        {reminders.length > 0 && createPortal(<aside className={styles.alert} aria-label="Ending auctions">
            <div role="alert">{reminders.map(job => <p key={job.id}><strong>Ending soon · {job.quote.title}</strong><br />
                Your maximum is {dollars(job.maxBid)}. <a href={job.quote.url} target="_blank" rel="noreferrer">Bid on eBay ↗</a></p>)}</div>
            <button type="button" aria-label="Dismiss auction reminders" onClick={() => setDismissed(previous => [...previous, ...reminders.map(job => job.id)])}>×</button>
        </aside>, document.body)}
        {!needsLocalhost && <section className={styles.workspace} aria-labelledby="auction-sniper-heading">
            <header><h2 id="auction-sniper-heading">Auction sniper</h2>
                <p>Set a reminder for an auction ending within {REMINDER_WINDOW_HOURS} hours. Keep the app open for the alert, then place your bid on eBay.</p></header>
            <EbayBuyerAccount returnNotice={returnNotice} />
            <PlanForm onSaved={update} />
            <section className={styles.roster} aria-labelledby="sniper-jobs"><h3 id="sniper-jobs">Your auctions</h3>
                {notice && <p role="status">{notice}</p>}
                {error && <div className={styles.error}><p role="alert">{error}</p><button type="button" className={styles.secondary} onClick={() => void refresh()}>Refresh auctions</button></div>}
                {!jobs && !error && <p role="status">Loading auctions…</p>}
                {jobs?.length === 0 && <p>No auctions scheduled.</p>}
                {!!jobs?.length && <ul>{[...jobs].sort((a, b) => {
                    const aActive = a.status === "ARMED", bActive = b.status === "ARMED";
                    return aActive && bActive ? Date.parse(a.quote.endTime) - Date.parse(b.quote.endTime) : Number(bActive) - Number(aActive) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
                }).map(job => <li key={job.id}>
                    <div className={styles.jobHead}><span className={styles.state} data-status={job.status}>{statusLabel[job.status]}</span>
                        <span>eBay reminder</span></div>
                    <h4><a href={job.quote.url} target="_blank" rel="noreferrer">{job.quote.title} ↗</a></h4>
                    <div className={styles.jobFacts}><strong>Max bid {dollars(job.maxBid)}</strong><span>{job.status === "ARMED" ? <Countdown endTime={job.quote.endTime} /> : endDate.format(new Date(job.quote.endTime))}</span></div>
                    {job.status === "SKIPPED" && <p>{job.message}</p>}
                    {job.status === "ARMED" && <button className={styles.secondary} type="button" disabled={!!cancelling} onClick={() => void cancel(job.id)}>{cancelling === job.id ? "Cancelling…" : "Cancel reminder"}</button>}
                </li>)}</ul>}
            </section>
        </section>}
    </>;
}
