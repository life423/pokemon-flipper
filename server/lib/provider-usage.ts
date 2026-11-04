import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "./paths.ts";
import { writeJsonAtomic } from "./atomic-json.ts";
import { withFileLease } from "./file-lease.ts";
import { createKeyedLock } from "./keyed-lock.ts";
import type { ProviderUsageProvider, ProviderUsageSnapshot } from "../../shared/provider-usage.ts";

export interface ProviderUsageObservation {
    limit: number;
    remaining: number;
    observedAt: string;
    resetsAt: string;
}
interface Ledger { version: 1; provider: ProviderUsageProvider; accountHash: string; samples: ProviderUsageObservation[] }
const WINDOW_MS = 15 * 60_000;
// Countdown headers can round their deadline or arrive a little later. A
// genuinely changed quota/reset period starts a new, incomparable baseline.
const RESET_TOLERANCE_MS = 60_000;
const LABELS: Record<ProviderUsageProvider, string> = { EBAY: "eBay Browse", PKMNPRICES: "PKMNPrices credits" };
const validProvider = (value: unknown): value is ProviderUsageProvider => value === "EBAY" || value === "PKMNPRICES";
const samePeriod = (a: ProviderUsageObservation, b: ProviderUsageObservation) => a.limit === b.limit &&
    Math.abs(Date.parse(a.resetsAt) - Date.parse(b.resetsAt)) <= RESET_TOLERANCE_MS;
function observation(value: unknown): ProviderUsageObservation {
    const sample = value as ProviderUsageObservation | null;
    if (!sample || typeof sample !== "object" || Array.isArray(sample) || Object.keys(sample).length !== 4 ||
        !Number.isSafeInteger(sample.limit) || sample.limit <= 0 || !Number.isSafeInteger(sample.remaining) || sample.remaining < 0 || sample.remaining > sample.limit ||
        typeof sample.observedAt !== "string" || !Number.isFinite(Date.parse(sample.observedAt)) ||
        typeof sample.resetsAt !== "string" || !Number.isFinite(Date.parse(sample.resetsAt)) ||
        Date.parse(sample.resetsAt) <= Date.parse(sample.observedAt)) throw new Error("Invalid provider-usage observation.");
    return { limit: sample.limit, remaining: sample.remaining,
        observedAt: new Date(sample.observedAt).toISOString(), resetsAt: new Date(sample.resetsAt).toISOString() };
}
function bounded(samples: ProviderUsageObservation[], now: number): ProviderUsageObservation[] {
    const buckets = new Map<number, ProviderUsageObservation[]>();
    for (const sample of samples) {
        const at = Date.parse(sample.observedAt);
        if (at < now - WINDOW_MS || at > now) continue;
        const minute = Math.floor(at / 60_000), previous = buckets.get(minute);
        // Retaining the first and last observation captures a rapid burst even
        // when both responses arrive in one minute. At most 32 samples remain.
        buckets.set(minute, previous ? [previous[0], sample] : [sample]);
    }
    return [...buckets.values()].flat();
}

export function createProviderUsageMonitor({ directory, now = Date.now }: { directory: string; now?: () => number }) {
    const locked = createKeyedLock();
    function target(provider: ProviderUsageProvider, accountKey: string) {
        if (!validProvider(provider) || typeof accountKey !== "string" || !accountKey.trim()) throw new Error("A configured provider account is required for quota observations.");
        const accountHash = createHash("sha256").update(provider).update("\0").update(accountKey.trim()).digest("hex");
        return { accountHash, file: path.join(directory, `${provider.toLowerCase()}-${accountHash}.json`) };
    }
    async function load(file: string, provider: ProviderUsageProvider, accountHash: string): Promise<Ledger | null> {
        let value: unknown;
        try { value = JSON.parse(await fs.readFile(file, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
        const ledger = value as Ledger | null;
        if (!ledger || typeof ledger !== "object" || Array.isArray(ledger) || Object.keys(ledger).length !== 4 || ledger.version !== 1 ||
            ledger.provider !== provider || ledger.accountHash !== accountHash || !Array.isArray(ledger.samples) || ledger.samples.length > 34) throw new Error("Invalid saved provider-usage observations.");
        const samples = ledger.samples.map(observation);
        if (samples.some((sample, index) => !samePeriod(sample, samples[0]) || index > 0 &&
            (Date.parse(sample.observedAt) < Date.parse(samples[index - 1].observedAt) || sample.remaining > samples[index - 1].remaining))) throw new Error("Invalid saved provider-usage history.");
        return { ...ledger, samples };
    }
    return {
        async record(provider: ProviderUsageProvider, accountKey: string, value: ProviderUsageObservation): Promise<void> {
            const sample = observation(value), at = now();
            // Expired or future observations cannot establish current usage.
            if (!Number.isFinite(at) || Date.parse(sample.observedAt) > at || Date.parse(sample.observedAt) < at - WINDOW_MS || Date.parse(sample.resetsAt) <= at) return;
            const { file, accountHash } = target(provider, accountKey);
            await locked(file, () => withFileLease(file, async () => {
                const ledger = await load(file, provider, accountHash), latest = ledger?.samples.at(-1);
                if (latest && Date.parse(sample.observedAt) < Date.parse(latest.observedAt)) return;
                const previous = ledger?.samples ?? [];
                const comparable = previous.length > 0 && samePeriod(sample, previous[0]);
                // Delayed/inconsistent headers must not refill the remaining
                // balance or erase a burst observed in the same quota period.
                if (comparable && latest && sample.remaining > latest.remaining) return;
                if (latest && JSON.stringify(latest) === JSON.stringify(sample)) return;
                const samples = bounded([...(comparable ? previous : []), sample], at);
                await writeJsonAtomic(file, { version: 1, provider, accountHash, samples });
            }, { timeoutError: () => new Error("Provider-usage observation storage is busy.") }));
        },
        async read(provider: ProviderUsageProvider, accountKey: string): Promise<ProviderUsageSnapshot | null> {
            try {
                const { file, accountHash } = target(provider, accountKey), ledger = await load(file, provider, accountHash), at = now();
                if (!ledger || !Number.isFinite(at)) return null;
                const samples = bounded(ledger.samples, at), first = samples[0], latest = samples.at(-1);
                if (!first || !latest || Date.parse(latest.resetsAt) <= at) return null;
                const usedInWindow = samples.length > 1 ? first.remaining - latest.remaining : null;
                const low = latest.remaining <= latest.limit * .2;
                const fast = usedInWindow !== null && usedInWindow >= latest.limit * .05;
                return { provider, label: LABELS[provider], limit: latest.limit, remaining: latest.remaining,
                    observedAt: latest.observedAt, resetsAt: latest.resetsAt, usedInWindow,
                    windowMinutes: (Date.parse(latest.observedAt) - Date.parse(first.observedAt)) / 60_000,
                    warning: low && fast ? "LOW_AND_FAST" : low ? "LOW" : fast ? "FAST" : null };
            } catch { return null; } // Monitoring cannot make a usage/API read fail.
        },
    };
}

const monitor = createProviderUsageMonitor({ directory: path.join(DATA_DIR, "provider-usage") });
export const recordProviderUsage = monitor.record;
// Local disk only: no Analytics, pricing, OAuth or other provider polling.
export async function dailyProviderUsage(): Promise<ProviderUsageSnapshot[]> {
    const configured: [ProviderUsageProvider, string | undefined][] = [["EBAY", process.env.EBAY_CLIENT_ID], ["PKMNPRICES", process.env.PKMNPRICES_API_KEY]];
    const samples = await Promise.all(configured.map(([provider, key]) => key?.trim() ? monitor.read(provider, key) : null));
    return samples.filter((sample): sample is ProviderUsageSnapshot => sample !== null);
}
