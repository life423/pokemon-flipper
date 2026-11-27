import { readDataFile } from "../storage/data-file.ts";
import { storageBackend } from "../storage/config.ts";
import { DATA_DIR } from "../lib/paths.ts";
import { setTimeout as delay } from "node:timers/promises";
import { shouldPaceBrowse, type ProviderUsageSnapshot } from "../../shared/provider-usage.ts";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { writeJsonAtomic } from "../lib/atomic-json.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { withFileLease } from "../lib/file-lease.ts";
import type { EbayUsage } from "../../shared/types.ts";

export class EbayBudgetError extends Error {
    constructor(message: string, readonly reason: "QUOTA" | "ACCOUNTING" = "ACCOUNTING") { super(message); }
    get code() { return this.reason === "QUOTA" ? "EBAY_DAILY_BUDGET" as const : "EBAY_BUDGET_ACCOUNTING" as const; }
}

export function ebayBudgetFailure(error: unknown): EbayBudgetError | null {
    const visited = new Set<Error>();
    while (error instanceof Error && !visited.has(error)) {
        if (error instanceof EbayBudgetError) return error;
        visited.add(error);
        error = error.cause;
    }
    return null;
}

interface Ledger { used: number; limit: number; resetAt: number }
const DAY = 24 * 60 * 60_000;
export const dailyBrowseReserve = (limit: number) => Math.ceil(limit * .1);
interface ReservationOptions { consume?: boolean; signal?: AbortSignal }

// Local app instances using the same eBay account share the daily ledger.
export function createDailyBrowseBudget({ file, now = Date.now }: { file: string; now?: () => number }) {
    const serial = createLimiter(1);
    return (snapshot: EbayUsage | null, { consume = true, signal }: ReservationOptions = {}): Promise<EbayUsage> => serial(async () => {
        try {
            return await withFileLease(file, async () => {
                const at = now();
                if (snapshot && (!Number.isSafeInteger(snapshot.limit) || snapshot.limit <= 0 || !Number.isSafeInteger(snapshot.used) || snapshot.used < 0 ||
                    !Number.isSafeInteger(snapshot.remaining) || snapshot.remaining < 0 || snapshot.remaining > snapshot.limit)) {
                    throw new EbayBudgetError("eBay's quota response is invalid. No request was sent.");
                }
                const previous: Ledger | null | undefined = await readDataFile(file, "utf8").then(JSON.parse).catch(error => {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                    throw new EbayBudgetError("eBay quota accounting could not be read. No request was sent.");
                });
                if (previous !== undefined && (!previous || !Number.isSafeInteger(previous.used) || previous.used < 0 || !Number.isSafeInteger(previous.limit) ||
                    previous.limit <= 0 || !Number.isFinite(previous.resetAt))) {
                    throw new EbayBudgetError("eBay quota accounting is invalid. No request was sent.");
                }
                const remoteReset = Date.parse(snapshot?.resetsAt ?? "");
                const observed = Number.isFinite(remoteReset) && remoteReset <= at ? null : snapshot;
                const current = previous && previous.resetAt > at ? previous : null;
                const limit = observed?.limit ?? previous?.limit ?? 5000;
                const used = Math.max(current?.used ?? 0, observed ? Math.max(observed.used, observed.limit - observed.remaining) : 0);
                const resetAt = observed && Number.isFinite(remoteReset) ? remoteReset : current?.resetAt ?? at + DAY;
                const reserve = dailyBrowseReserve(limit);
                if (consume && limit - used <= reserve) throw new EbayBudgetError(limit <= used
                    ? "eBay's daily Browse allowance is used up."
                    : "The app reached eBay's daily Browse reserve.", "QUOTA");
                signal?.throwIfAborted();
                const ledger = { limit, used: used + (consume ? 1 : 0), resetAt };
                await writeJsonAtomic(file, ledger);
                const remaining = Math.max(0, limit - ledger.used);
                return { limit, used: ledger.used, remaining, resetsAt: new Date(resetAt).toISOString(), braking: remaining <= reserve };
            }, { signal, timeoutError: () => new EbayBudgetError("eBay quota accounting is busy. No request was sent; retry shortly.") });
        } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof EbayBudgetError) throw error;
            throw new EbayBudgetError("eBay quota accounting could not be saved. No request was sent.");
        }
    });
}

// Reserve a dispatch time only when this account is using quota quickly or running low.
export async function paceBrowse(file: string, usage: ProviderUsageSnapshot, signal?: AbortSignal,
    now = Date.now, wait = (ms: number) => delay(ms, undefined, { signal })) {
    while (shouldPaceBrowse(usage) && usage.remaining > dailyBrowseReserve(usage.limit)) {
        signal?.throwIfAborted();
        const at = now(), reset = Date.parse(usage.resetsAt);
        if (reset <= at || at - Date.parse(usage.observedAt) >= 15 * 60_000) return;
        // Spread the spendable requests over the rest of the quota period.
        const interval = Math.max(6000, Math.ceil((reset - at) / (usage.remaining - dailyBrowseReserve(usage.limit))));
        const pause = await withFileLease(file, async () => {
            const clock = now();
            const prior = await readDataFile(file, "utf8").then(JSON.parse).catch(error => {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                return null;
            });
            const remaining = prior?.reset === reset ? prior.last + interval - clock : 0;
            if (remaining > 0) return remaining;
            await writeJsonAtomic(file, { reset, last: clock });
            return 0;
        }, { signal, timeoutError: () => new EbayBudgetError("The shared eBay request queue is busy.") });
        if (!pause) return;
        await wait(Math.min(pause, Math.max(1, Date.parse(usage.observedAt) + 15 * 60_000 - now())));
    }
}

function dailyAccountKey() {
    return createHash("sha256").update(process.env.EBAY_CLIENT_ID?.trim() ?? "missing").digest("hex");
}

function quotaFile(account: string, extension: string) {
    return storageBackend() === "azure-sql" ? path.join(DATA_DIR, "ebay-daily-budget", account + extension)
        : path.join(os.tmpdir(), "pokemon-flipper-ebay-quota", account + extension);
}

export function paceCurrentBrowse(usage: ProviderUsageSnapshot, signal?: AbortSignal) {
    return paceBrowse(quotaFile(dailyAccountKey(), ".pace"), usage, signal);
}

const accounts = new Map<string, ReturnType<typeof createDailyBrowseBudget>>();
export function reserveDailyBrowseCall(snapshot: EbayUsage | null, options?: ReservationOptions) {
    const account = dailyAccountKey();
    let reserve = accounts.get(account);
    if (!reserve) {
        reserve = createDailyBrowseBudget({ file: quotaFile(account, ".json") });
        accounts.set(account, reserve);
    }
    return reserve(snapshot, options);
}
