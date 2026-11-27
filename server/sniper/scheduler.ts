import { randomUUID } from "node:crypto";
import path from "node:path";
import { withinReminderWindow } from "../../shared/sniper.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { cents } from "../../shared/money.ts";
import type { SniperArm, SniperJob, SniperMode, SniperQuote, SniperStatus } from "../../shared/sniper.ts";
import { withFileLease } from "../lib/file-lease.ts";
import { jsonStore } from "../lib/json-store.ts";
import { DATA_DIR } from "../lib/paths.ts";
import { trackSharedWork } from "../lib/shared-work.ts";

interface Services {
    file?: string;
    now?: () => number;
    sandboxBuyerId: () => Promise<string | null>;
    readQuote: (itemId: string, mode: SniperMode, signal: AbortSignal, searchId?: string, buyerId?: string) => Promise<SniperQuote>;
    submitSandbox: (itemId: string, maxBid: number, signal: AbortSignal, buyerId: string) => Promise<string>;
}
type StoredJob = SniperJob & { searchId?: string };
type Queue = { version: 1; jobs: StoredJob[] };

export class SniperError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}

function money(value: unknown): value is number {
    return typeof value === "number" && value >= 0 && Number.isFinite(value) && cents(value) / 100 === value;
}

function quoteFields(quote: SniperQuote | null | undefined): quote is SniperQuote {
    return !!quote && !!parseListingLink(quote.itemId) && typeof quote.title === "string" && quote.title.trim().length > 0 &&
        typeof quote.url === "string" && Number.isFinite(Date.parse(quote.checkedAt)) && Number.isFinite(Date.parse(quote.endTime)) &&
        [quote.currentBid, quote.minimumBid, quote.shipping].every(amount => amount === null || money(amount)) &&
        (quote.highBidder === undefined || typeof quote.highBidder === "boolean") &&
        (quote.buyerConnectionId === undefined || typeof quote.buyerConnectionId === "string" && quote.buyerConnectionId.length <= 128);
}

function validArm(plan: SniperArm): boolean {
    return (plan.mode === "reminder" || plan.mode === "sandbox") && quoteFields(plan.quote) && money(plan.maxBid) &&
        plan.maxBid > 0 && Number.isInteger(plan.leadSeconds) && plan.leadSeconds >= 3 && plan.leadSeconds <= 600;
}

const statuses: SniperStatus[] = ["ARMED", "REMINDER", "SUBMITTING", "SUBMITTED", "SKIPPED", "CANCELLED", "UNCERTAIN"];
function validQueue(value: unknown): value is Queue {
    const queue = value as Queue | null;
    return !!queue && queue.version === 1 && Array.isArray(queue.jobs) && queue.jobs.every(job => job && validArm(job) &&
        typeof job.id === "string" && typeof job.message === "string" && Number.isFinite(Date.parse(job.updatedAt)) &&
        statuses.includes(job.status) && (job.searchId === undefined || typeof job.searchId === "string"));
}

function dueAt(plan: SniperArm) { return Date.parse(plan.quote.endTime) - plan.leadSeconds * 1000; }

function checkTerms(plan: SniperArm, quote: SniperQuote, now: number): string | undefined {
    if (!quoteFields(quote) || parseListingLink(quote.itemId)?.itemId !== plan.quote.itemId) return "Auction identity could not be confirmed.";
    if (quote.title.trim() !== plan.quote.title.trim() || Date.parse(quote.endTime) !== Date.parse(plan.quote.endTime)) return "The auction title or ending time changed.";
    const age = now - Date.parse(quote.checkedAt);
    if (age < 0 || age > 30_000) return "The auction quote is stale.";
    if (!withinReminderWindow({ buyingOption: "AUCTION", endTime: quote.endTime }, now)) return "Only active auctions ending within 12 hours are eligible.";
    if (quote.minimumBid === null || quote.minimumBid <= 0) return "eBay did not confirm the minimum bid.";
    if (quote.minimumBid > plan.maxBid || (quote.currentBid !== null && quote.currentBid > plan.maxBid)) return "The bid needed exceeds your maximum.";
    if (plan.mode === "sandbox") {
        if (!plan.quote.buyerConnectionId || quote.buyerConnectionId !== plan.quote.buyerConnectionId) return "The sandbox buyer connection changed. Preview the auction again.";
        if (quote.highBidder !== false) return quote.highBidder ? "Your sandbox account already leads this auction." : "The sandbox account’s bidding status is unknown.";
        if (plan.quote.shipping === null) return "Destination shipping could not be confirmed.";
    }
    if (plan.quote.shipping !== null) {
        if (quote.shipping === null) return "Destination shipping could not be confirmed.";
        if (quote.shipping > plan.quote.shipping) return "Shipping increased since you scheduled this auction.";
    }
}

function setStatus(job: StoredJob, status: SniperStatus, message: string, now: number) {
    Object.assign(job, { status, message, updatedAt: new Date(now).toISOString() });
}

export function createSniperScheduler(services: Services) {
    const file = services.file ?? path.join(DATA_DIR, "sniper-queue.json");
    const now = services.now ?? Date.now;
    const store = jsonStore<Queue>(file, () => ({ version: 1, jobs: [] }), validQueue);
    function withQueueLock<T>(run: () => Promise<T>) {
        return withFileLease(file, run, { timeoutError: () => new SniperError("The sniper queue is busy.", 503) });
    }
    function change<T>(edit: (data: Queue, buyerId: string | null) => T, checkBuyer = false) {
        return withQueueLock(async () => {
            const buyerId = checkBuyer ? await services.sandboxBuyerId() : null;
            return store.change(data => edit(data, buyerId));
        });
    }
    let running = false;
    let timer: NodeJS.Timeout | undefined;
    let revision = 0;
    let shutdown = new AbortController();
    const inFlight = new Map<string, Promise<void>>();
    const submitting = new Set<string>();

    async function list(): Promise<SniperJob[]> {
        return (await store.read()).jobs.map(job => {
            // After a crash there is no receipt. A second worker must also leave this claim alone.
            if (job.status === "SUBMITTING" && !submitting.has(job.id))
                return { ...job, status: "UNCERTAIN", message: "Check the sandbox account for this bid before taking further action." };
            return job;
        });
    }

    async function schedule(minimumDelay = 0) {
        const current = ++revision;
        clearTimeout(timer);
        if (!running) return;
        const jobs = await list();
        if (!running || current !== revision) return;
        const next = jobs.filter(job => job.status === "ARMED" && !inFlight.has(job.id)).reduce((time, job) => Math.min(time, dueAt(job)), Infinity);
        if (!Number.isFinite(next)) return;
        timer = setTimeout(() => {
            void tick().catch(error => console.error("The auction queue could not be processed.", error));
        }, Math.max(minimumDelay, next - now()));
        timer.unref();
    }

    async function arm(input: SniperArm & { searchId?: string }): Promise<SniperJob> {
        if (!validArm(input)) throw new SniperError("Choose an auction, a positive maximum in whole cents, and a lead of 3–600 seconds.");
        const link = parseListingLink(input.quote.itemId)!;
        const url = input.mode === "sandbox" ? link.url.replace("www.ebay.com", "www.sandbox.ebay.com") : link.url;
        const quote = { ...input.quote, itemId: link.itemId, url };
        const plan = { mode: input.mode, maxBid: input.maxBid, leadSeconds: input.leadSeconds, quote };
        const job = await change((data, buyerId) => {
            if (plan.mode === "sandbox" && (!buyerId || quote.buyerConnectionId !== buyerId)) {
                throw new SniperError("The sandbox buyer is unavailable or has changed. Preview the auction again.", 409);
            }
            const prior = data.jobs.find(job => job.mode === plan.mode && job.quote.itemId === quote.itemId &&
                ["ARMED", "SUBMITTING", "SUBMITTED", "UNCERTAIN"].includes(job.status));
            if (prior) {
                if (prior.status === "ARMED" && prior.quote.buyerConnectionId === quote.buyerConnectionId && prior.maxBid === plan.maxBid && prior.leadSeconds === plan.leadSeconds) return prior;
                throw new SniperError("This auction already has a scheduled or submitted bid plan.", 409);
            }
            const time = now();
            const reason = checkTerms(plan, quote, time);
            if (reason) throw new SniperError(reason, 409);
            if (dueAt(plan) <= time) throw new SniperError("The selected lead time has already passed.", 409);
            const job: StoredJob = { ...plan, id: randomUUID(), status: "ARMED", message: "Scheduled.", updatedAt: new Date(time).toISOString() };
            if (input.searchId) job.searchId = input.searchId;
            data.jobs.unshift(job);
            return job;
        }, plan.mode === "sandbox");
        await schedule();
        return job;
    }

    async function cancel(id: string): Promise<SniperJob> {
        const job = await change(data => {
            const job = data.jobs.find(item => item.id === id);
            if (!job) throw new SniperError("Scheduled auction was not found.", 404);
            if (job.status === "CANCELLED") return job;
            if (job.status !== "ARMED") throw new SniperError("This auction plan has already finished or started submitting.", 409);
            setStatus(job, "CANCELLED", "Cancelled.", now());
            return job;
        });
        await schedule();
        return job;
    }

    async function reconcileBuyerJobs() {
        await withQueueLock(async () => {
            if (!(await store.read()).jobs.some(job => job.mode === "sandbox" && job.status === "ARMED")) return;
            const buyerId = await services.sandboxBuyerId();
            await store.change(data => {
                for (const job of data.jobs) {
                    if (job.mode === "sandbox" && job.status === "ARMED" && (!buyerId || job.quote.buyerConnectionId !== buyerId))
                        setStatus(job, "CANCELLED", "The sandbox buyer connection changed. Preview the auction to schedule it again.", now());
                }
            });
        });
    }

    function transition(id: string, previous: SniperStatus, status: SniperStatus, message: string) {
        return change(data => {
            const job = data.jobs.find(entry => entry.id === id);
            if (!job || job.status !== previous) return false;
            setStatus(job, status, message, now());
            return true;
        });
    }

    async function deadlineReason(plan: SniperArm) {
        if (now() >= Date.parse(plan.quote.endTime)) return "The auction ended before the scheduled action could finish.";
        if (plan.mode === "sandbox") {
            try {
                if (!plan.quote.buyerConnectionId || await services.sandboxBuyerId() !== plan.quote.buyerConnectionId)
                    return "The sandbox buyer connection changed. Preview the auction again.";
            } catch { return "The sandbox buyer connection could not be verified."; }
        }
    }

    async function processDue(job: StoredJob) {
        const skip = (message: string) => transition(job.id, "ARMED", "SKIPPED", message);
        const blocked = await deadlineReason(job);
        if (blocked) { await skip(blocked); return; }
        if (job.mode === "sandbox" && now() - dueAt(job) > 2_000) {
            await skip("The server missed the scheduled bid time."); return;
        }
        const remaining = () => Math.max(1, Math.min(15_000, Date.parse(job.quote.endTime) - now()));
        let fresh: SniperQuote;
        const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(remaining())]);
        try { fresh = await services.readQuote(job.quote.itemId, job.mode, signal, job.searchId, job.quote.buyerConnectionId); }
        catch {
            if (!shutdown.signal.aborted) {
                await skip("The final auction check could not confirm bidding terms.");
                if (job.mode === "sandbox") await reconcileBuyerJobs();
            }
            return;
        }
        if (shutdown.signal.aborted) return;
        if (signal.aborted) { await skip("The final auction check timed out."); return; }
        const reason = await deadlineReason(job) ?? checkTerms(job, fresh, now());
        if (reason) { await skip(reason); return; }
        if (job.mode === "reminder") {
            await transition(job.id, "ARMED", "REMINDER", "Open the auction on eBay to place your bid.");
            return;
        }

        // Persist the submission claim before the external write. An interrupted
        // or ambiguous request is never retried, including after process restart.
        if (!await transition(job.id, "ARMED", "SUBMITTING", "Submitting your maximum to eBay Sandbox.")) return;
        submitting.add(job.id);
        try {
            const late = shutdown.signal.aborted ? "The server stopped before sending the bid." : await deadlineReason(job) ?? checkTerms(job, fresh, now());
            if (late) { await transition(job.id, "SUBMITTING", "SKIPPED", late); return; }
            let receipt: string;
            try { receipt = await services.submitSandbox(job.quote.itemId, job.maxBid, AbortSignal.timeout(remaining()), job.quote.buyerConnectionId!); }
            catch (error) {
                const rejected = error instanceof Error && "definiteRejection" in error && error.definiteRejection === true;
                await transition(job.id, "SUBMITTING", rejected ? "SKIPPED" : "UNCERTAIN",
                    rejected ? (error as Error).message : "Bid response unknown. Check the sandbox account.");
                if (rejected) await reconcileBuyerJobs();
                return;
            }
            await transition(job.id, "SUBMITTING", "SUBMITTED", `eBay Sandbox accepted your proxy bid. Receipt ${receipt}.`);
        } finally { submitting.delete(job.id); }
    }

    async function tick(): Promise<void> {
        if (shutdown.signal.aborted) return;
        const { jobs } = await store.read();
        const due = jobs.filter(job => job.status === "ARMED" && dueAt(job) <= now());
        const tasks = due.map(job => {
            let task = inFlight.get(job.id);
            if (!task) {
                task = trackSharedWork(processDue(job)).finally(() => inFlight.delete(job.id));
                inFlight.set(job.id, task);
            }
            return task;
        });
        // A slow final quote must not delay auctions with a later closing time.
        const results = await Promise.allSettled([...tasks, schedule()]);
        const failure = results.find(result => result.status === "rejected");
        await schedule(failure ? 5_000 : 0);
        if (failure?.status === "rejected") throw failure.reason;
    }

    return {
        list, arm, cancel, tick, reconcileBuyerJobs,
        async start() {
            if (shutdown.signal.aborted) shutdown = new AbortController();
            running = true;
            try { await reconcileBuyerJobs(); } finally { await schedule(); }
        },
        stop() { running = false; ++revision; clearTimeout(timer); shutdown.abort(); },
    };
}
