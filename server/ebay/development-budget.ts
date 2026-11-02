import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonAtomic } from "../lib/atomic-json.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { DATA_DIR } from "../lib/paths.ts";
import { EbayBudgetError } from "./daily-budget.ts";

export class EbayDevelopmentBudgetError extends EbayBudgetError {}
interface Ledger { version: 1; expiresAt: string; limit: number; used: number; requireRenewal?: boolean }
export interface DevelopmentBrowseAllowance { limit: number; used: number; remaining: number; expiresAt: string; renewalRequired?: boolean }

// Exclusive-create/nonce lease, with no age-based stealing: a slow or suspended
// owner may still be alive. Only filesystem reservations run inside it; accepted
// HTTP requests run afterwards. A crash retains the lock for inspection.
async function withLease<T>(file: string, run: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`, nonce = randomUUID(), deadline = Date.now() + 10_000;
    for (;;) {
        try { await fs.writeFile(lock, nonce, { flag: "wx" }); break; }
        catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
            if (Date.now() >= deadline) throw new EbayDevelopmentBudgetError("Development Browse accounting is locked. No request was sent. If a server crashed, stop all app instances and inspect the retained lock before removing only that lock file; keep the budget ledger.");
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
    try { return await run(); }
    finally { if (await fs.readFile(lock, "utf8").catch(() => "") === nonce) await fs.unlink(lock).catch(() => {}); }
}

export function createDevelopmentBrowseBudget({ file, now = Date.now }: { file: string; now?: () => number }) {
    const serial = createLimiter(1);
    const read = async (): Promise<Ledger | null> => {
        let value: unknown;
        try { value = JSON.parse(await fs.readFile(file, "utf8")); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw new EbayDevelopmentBudgetError("Development Browse accounting could not be read. No Browse request was sent.");
        }
        const entry = value as Partial<Ledger> | null;
        if (!entry || entry.version !== 1 || typeof entry.expiresAt !== "string" || !Number.isFinite(Date.parse(entry.expiresAt)) ||
            !Number.isSafeInteger(entry.limit) || entry.limit! < 0 || !Number.isSafeInteger(entry.used) || entry.used! < 0 ||
            entry.requireRenewal !== undefined && typeof entry.requireRenewal !== "boolean") {
            throw new EbayDevelopmentBudgetError("Development Browse accounting is invalid. No Browse request was sent.");
        }
        return entry as Ledger;
    };
    return {
        status: async (): Promise<DevelopmentBrowseAllowance | null> => {
            const ledger = await read();
            if (!ledger) return null;
            const expired = Date.parse(ledger.expiresAt) <= now();
            if (expired && ledger.requireRenewal) return { ...ledger, remaining: 0, renewalRequired: true };
            return expired ? null : { ...ledger, remaining: Math.max(0, ledger.limit - ledger.used) };
        },
        reserve: (reserveDaily: () => Promise<void> = async () => {}, signal?: AbortSignal): Promise<void> => serial(async () => {
            signal?.throwIfAborted();
            try {
                await withLease(file, async () => {
                    signal?.throwIfAborted();
                    const ledger = await read();
                    const at = now();
                    if (ledger?.requireRenewal && Date.parse(ledger.expiresAt) <= at) throw new EbayDevelopmentBudgetError(
                        "The development Browse allowance expired. Explicitly renew its limit and expiry before sending more Browse requests. The used count was kept; cached evidence, Analytics and offline work remain available.");
                    const active = ledger && Date.parse(ledger.expiresAt) > at ? ledger : null;
                    if (active && active.used >= active.limit) throw new EbayDevelopmentBudgetError(
                        `The development Browse limit of ${active.limit} additional requests is reached until ${active.expiresAt}. Cached evidence and AI remain available; this is separate from eBay's daily allowance.`);
                    // A development rejection must not consume the real daily
                    // reservation. A real quota rejection must not use this one.
                    await reserveDaily();
                    if (active) await writeJsonAtomic(file, { ...active, used: active.used + 1 });
                });
            } catch (error) {
                signal?.throwIfAborted();
                if (error instanceof EbayBudgetError) throw error;
                throw new EbayDevelopmentBudgetError("Development Browse accounting could not be saved. No Browse request was sent.");
            }
        }),
    };
}

const budget = createDevelopmentBrowseBudget({ file: path.join(DATA_DIR, "ebay-development-budget.json") });
export const developmentBrowseAllowance = budget.status;
export const reserveDevelopmentBrowseRequest = budget.reserve;
