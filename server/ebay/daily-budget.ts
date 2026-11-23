import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { writeJsonAtomic } from "../lib/atomic-json.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { withFileLease } from "../lib/file-lease.ts";
import type { EbayUsage } from "../../shared/types.ts";

export class EbayBudgetError extends Error {}
interface Ledger { used: number; limit: number; resetAt: number }
const DAY = 24 * 60 * 60_000;

// Local app instances using the same eBay account share the daily ledger.
export function createDailyBrowseBudget({ file, now = Date.now }: { file: string; now?: () => number }) {
    const serial = createLimiter(1);
    return (snapshot: EbayUsage | null, keepReserve = false, consume = true): Promise<EbayUsage> => serial(() => withFileLease(file, async () => {
        const at = now();
        if (snapshot && (!Number.isSafeInteger(snapshot.limit) || snapshot.limit <= 0 || !Number.isSafeInteger(snapshot.used) || snapshot.used < 0 ||
            !Number.isSafeInteger(snapshot.remaining) || snapshot.remaining < 0 || snapshot.remaining > snapshot.limit)) {
            throw new EbayBudgetError("eBay's quota response is invalid. No request was sent.");
        }
        const previous: Ledger | null = await fs.readFile(file, "utf8").then(JSON.parse).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw new EbayBudgetError("eBay quota accounting could not be read. No request was sent.");
        });
        if (previous && (!Number.isSafeInteger(previous.used) || previous.used < 0 || !Number.isSafeInteger(previous.limit) || previous.limit <= 0 || !Number.isFinite(previous.resetAt))) {
            throw new EbayBudgetError("eBay quota accounting is invalid. No request was sent.");
        }
        const remoteReset = Date.parse(snapshot?.resetsAt ?? "");
        if (snapshot && Number.isFinite(remoteReset) && remoteReset <= at) snapshot = null;
        const current = previous && previous.resetAt > at ? previous : null;
        const limit = snapshot?.limit ?? current?.limit ?? 5000;
        const used = Math.max(current?.used ?? 0, snapshot ? Math.max(snapshot.used, snapshot.limit - snapshot.remaining) : 0);
        const resetAt = snapshot && Number.isFinite(remoteReset) ? remoteReset : current?.resetAt ?? at + DAY;
        const remaining = Math.max(0, limit - used);
        if (consume && remaining <= (keepReserve ? Math.ceil(limit * .1) : 0)) throw new EbayBudgetError(keepReserve
            ? "Saving the rest of today's eBay allowance; cached evidence and AI work remain available."
            : "eBay's daily allowance is used up. Cached evidence and AI work remain available until it resets.");
        const ledger = { limit, used: used + (consume ? 1 : 0), resetAt };
        await writeJsonAtomic(file, ledger);
        return { limit, used: ledger.used, remaining: Math.max(0, limit - ledger.used), resetsAt: new Date(resetAt).toISOString(), braking: limit - ledger.used <= limit * .1 };
    }, { timeoutError: () => new EbayBudgetError("eBay quota accounting is busy. No request was sent; retry shortly.") }));
}

const accounts = new Map<string, ReturnType<typeof createDailyBrowseBudget>>();
export function reserveDailyBrowseCall(snapshot: EbayUsage | null, keepReserve = false, consume = true) {
    const account = createHash("sha256").update(process.env.EBAY_CLIENT_ID?.trim() ?? "missing").digest("hex");
    let reserve = accounts.get(account);
    if (!reserve) {
        reserve = createDailyBrowseBudget({ file: path.join(os.tmpdir(), "pokemon-flipper-ebay-quota", `${account}.json`) });
        accounts.set(account, reserve);
    }
    return reserve(snapshot, keepReserve, consume);
}
