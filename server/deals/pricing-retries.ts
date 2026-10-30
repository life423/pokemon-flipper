import { createHash, randomUUID } from "node:crypto";
import { PRICING_RETRY_LIMIT, pricingSnapshotKey, type PricingIssue, type PricingRetry, type PricingRetryResult } from "../../shared/pricing-retries.ts";
import type { ListingSummary, Screen, SearchIntent, Targets } from "../../shared/types.ts";
import { prescreen, type ScreenInput } from "./prescreen.ts";
import { lookupCards, fetchComps, pricingCooldown } from "../pricing/pkmnprices.ts";
import { withTargets } from "../../shared/money/targets.ts";
import { cardMismatch } from "../search/relevance.ts";

const MAX_ATTEMPTS = 3;
const TTL_MS = 30 * 60_000;
const MAX_TICKETS = 2000;
export class PricingRetryError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}
interface Job { token: string; listing: ListingSummary; input: ScreenInput; intent: SearchIntent | null; screen: Screen; match?: ListingSummary["match"]; nextAt: number; attempts: number; expires: number }
export function createPricingRetries({
    price = (input: ScreenInput, targets: Targets, includeOffers: boolean) => prescreen(input, { lookupCards, fetchComps, config: withTargets(targets), includeOffers }),
    cooldown = pricingCooldown,
    now = () => Date.now(),
    wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
} = {}) {
    const jobs = new Map<string, Job>();
    const keys = new Map<string, string>();
    let busy = false;
    let lastRunAt = 0;
    const retryable = (issue?: PricingIssue) => issue && ["RATE_LIMIT", "TEMPORARY"].includes(issue.kind);
    const hint = (job: Job): PricingRetry => ({ ticket: job.token, snapshotKey: pricingSnapshotKey(job.listing), retryAt: new Date(job.nextAt).toISOString(), attemptsLeft: Math.max(0, MAX_ATTEMPTS - job.attempts) });
    const result = (job: Job) => ({ id: job.listing.id, snapshotKey: pricingSnapshotKey(job.listing), match: job.match,
        screen: { ...job.screen, pricingRetry: retryable(job.screen.pricingIssue) ? hint(job) : undefined } });
    return {
        register(listing: ListingSummary, input: ScreenInput, intent: SearchIntent | null): PricingRetry | undefined {
            if (listing.match || !retryable(listing.screen?.pricingIssue)) return undefined;
            for (const [token, job] of jobs) if (job.expires <= now() && !busy) jobs.delete(token);
            for (const [key, token] of keys) if (!jobs.has(token)) keys.delete(key);
            const key = createHash("sha256").update(JSON.stringify([pricingSnapshotKey(listing), input, intent])).digest("hex");
            const existing = jobs.get(keys.get(key) ?? "");
            if (existing && existing.expires > now()) return hint(existing);
            // Do not evict a batch that is in flight; the next search can retry registration.
            if (jobs.size >= MAX_TICKETS) { if (busy) return undefined; const oldest = jobs.keys().next().value; if (oldest) jobs.delete(oldest); }
            const token = randomUUID();
            const issueAt = Date.parse(listing.screen?.pricingIssue?.retryAt ?? "");
            const job: Job = { token, listing: structuredClone(listing), input: structuredClone(input), intent: intent ? structuredClone(intent) : null,
                screen: structuredClone(listing.screen!), nextAt: Math.max(now() + 30_000, Number.isFinite(issueAt) ? issueAt : 0), attempts: 0, expires: now() + TTL_MS };
            jobs.set(token, job); keys.set(key, token); return hint(job);
        },
        async retry(tokens: unknown, targets: Targets, includeOffers: boolean, signal?: AbortSignal): Promise<PricingRetryResult> {
            if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > PRICING_RETRY_LIMIT || tokens.some((token) => typeof token !== "string" || token.length > 80)) throw new PricingRetryError(`Choose up to ${PRICING_RETRY_LIMIT} pricing retries.`);
            const selected = [...new Set(tokens as string[])].map((token) => {
                const job = jobs.get(token);
                if (!job || job.expires <= now()) throw new PricingRetryError("This pricing retry expired. Your results are kept; run a new search to check it again.", 410);
                return job;
            });
            if (busy) throw new PricingRetryError("A pricing retry batch is already running. Wait for it to finish.", 409);
            busy = true;
            const results: PricingRetryResult["results"] = [];
            let note: string | null = null;
            let blocked: PricingIssue | null = null;
            try {
                for (const job of selected) {
                    signal?.throwIfAborted();
                    if (job.listing.endTime && Date.parse(job.listing.endTime) <= now()) { job.screen = { ...job.screen, pricingIssue: undefined, reason: "This listing ended. No pricing retry was sent." }; results.push(result(job)); continue; }
                    if (!job.screen.pricingIssue) { results.push(result(job)); continue; }
                    const pause = blocked ?? cooldown();
                    if (pause) {
                        job.screen = { ...job.screen, pricingIssue: pause };
                        job.nextAt = Math.max(job.nextAt, Date.parse(pause.retryAt ?? "") || now() + 60_000);
                        note = pause.kind === "CREDITS" || pause.kind === "CONFIG" ? "Check the price-provider account or configuration. Cached results remain available." : "The price provider needs more time. Remaining lookups were deferred without sending requests.";
                        results.push(result(job)); continue;
                    }
                    if (job.attempts >= MAX_ATTEMPTS || job.nextAt > now()) {
                        note ??= job.attempts >= MAX_ATTEMPTS ? "The retry limit for these results was reached. Your earlier results are kept." : "These prices are still cooling down. No early requests were sent.";
                        results.push(result(job)); continue;
                    }
                    const delay = Math.max(0, lastRunAt + 1500 - now());
                    if (delay) await wait(delay);
                    signal?.throwIfAborted();
                    // Another search may have entered cooldown while this job waited.
                    const latePause = cooldown();
                    if (latePause) { blocked = latePause; job.screen = { ...job.screen, pricingIssue: latePause }; job.nextAt = Math.max(job.nextAt, Date.parse(latePause.retryAt ?? "") || now() + 60_000); results.push(result(job)); note = "The provider is cooling down; remaining requests were deferred."; continue; }
                    lastRunAt = now(); job.attempts += 1;
                    try {
                        const previous = job.screen;
                        const updated = await price(job.input, targets, includeOffers);
                        job.screen = { ...updated, evidence: previous.evidence, filledFromTitle: previous.filledFromTitle };
                    }
                    catch { job.screen = { ...job.screen, pricingIssue: { kind: "TEMPORARY", retryAt: new Date(now() + 30_000).toISOString() }, reason: "The pricing retry could not finish. Your previous result is kept." }; }
                    job.match = job.intent ? cardMismatch(job.screen, job.intent) ?? undefined : undefined;
                    const issueAt = Date.parse(job.screen.pricingIssue?.retryAt ?? "");
                    job.nextAt = Math.max(now() + (job.screen.pricingIssue ? 30_000 : 60_000), Number.isFinite(issueAt) ? issueAt : 0);
                    if (job.screen.pricingIssue) blocked = job.screen.pricingIssue;
                    results.push(result(job));
                }
                return { results, note };
            } finally { busy = false; }
        },
    };
}
export const pricingRetries = createPricingRetries();
