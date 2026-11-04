import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { EbaySearchAllowance } from "../../shared/types.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { DATA_DIR } from "../lib/paths.ts";
import { writeJsonAtomic } from "../lib/atomic-json.ts";
import { withFileLease } from "../lib/file-lease.ts";
import { getAiUsageContext } from "../ai/usage-context.ts";
import { EbayBudgetError } from "./daily-budget.ts";

export const EBAY_SEARCH_BROWSE_LIMIT = 50;
const STORED_SEARCH_BROWSE_LIMITS = new Set([25, EBAY_SEARCH_BROWSE_LIMIT]);
const VALID_ID = /^[a-zA-Z0-9_-]{1,80}$/;
interface Ledger { version: 1; searchId: string; limit: number; used: number }
export class EbaySearchBudgetError extends EbayBudgetError {}

export function requireBrowseSearchId(searchId = getAiUsageContext().searchId): string {
    if (!searchId || !VALID_ID.test(searchId)) throw new EbaySearchBudgetError(
        "A valid search ID is required before eBay Browse requests can start. Start a search in the app; follow-up work must keep that search ID so its stored request cap is shared.");
    return searchId;
}

// A distinct search gets its own persistent allowance. A repeated search ID,
// process restart or later calendar day never resets already-reserved calls.
// Existing searches retain their original stored cap when the default changes.
export function createSearchBrowseBudget({ directory }: { directory: string }) {
    const serial = createLimiter(1);
    const fileFor = (id: string) => path.join(directory, `${createHash("sha256").update(id).digest("hex")}.json`);
    const read = async (id: string): Promise<Ledger> => {
        let value: unknown;
        try { value = JSON.parse(await fs.readFile(fileFor(id), "utf8")); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, searchId: id, limit: EBAY_SEARCH_BROWSE_LIMIT, used: 0 };
            throw new EbaySearchBudgetError("The eBay per-search request accounting could not be read. No Browse request was sent.");
        }
        const ledger = value as Partial<Ledger> | null;
        if (!ledger || ledger.version !== 1 || ledger.searchId !== id || typeof ledger.limit !== "number" || !STORED_SEARCH_BROWSE_LIMITS.has(ledger.limit) ||
            !Number.isSafeInteger(ledger.used) || ledger.used! < 0 || ledger.used! > ledger.limit) {
            throw new EbaySearchBudgetError("The eBay per-search request accounting is invalid. No Browse request was sent.");
        }
        return ledger as Ledger;
    };
    return {
        async status(searchId?: string): Promise<EbaySearchAllowance | null> {
            if (searchId === undefined) return null;
            const id = requireBrowseSearchId(searchId), ledger = await read(id);
            return { searchId: id, limit: ledger.limit, used: ledger.used, remaining: ledger.limit - ledger.used };
        },
        reserve(searchId: string | undefined, reserveDaily: () => Promise<void>, signal?: AbortSignal): Promise<void> {
            const id = requireBrowseSearchId(searchId);
            return serial(async () => {
                signal?.throwIfAborted();
                try {
                    await withFileLease(fileFor(id), async () => {
                        const ledger = await read(id);
                        signal?.throwIfAborted();
                        if (ledger.used >= ledger.limit) throw new EbaySearchBudgetError(
                            `This search has reached its ${ledger.limit}-request eBay Browse cap. Cached listings and saved analysis remain available; a new search has a separate cap and still shares eBay's daily allowance.`);
                        // A rejected search cannot spend the daily quota, and a
                        // rejected daily reservation cannot spend this search.
                        await reserveDaily();
                        // Persist before dispatch. Failed/uncertain requests are
                        // never refunded: eBay may already have counted them.
                        await writeJsonAtomic(fileFor(id), { ...ledger, used: ledger.used + 1 });
                    }, { signal, timeoutError: () => new EbaySearchBudgetError(
                        "The eBay per-search request accounting is locked. No Browse request was sent. Stop all app instances and inspect a retained lock after a crash; keep its budget ledger.") });
                } catch (error) {
                    signal?.throwIfAborted();
                    if (error instanceof EbayBudgetError) throw error;
                    throw new EbaySearchBudgetError("The eBay per-search request accounting could not be saved. No Browse request was sent.");
                }
            });
        },
    };
}

const budgets = new Map<string, ReturnType<typeof createSearchBrowseBudget>>();
function currentBudget() {
    const account = createHash("sha256").update(process.env.EBAY_CLIENT_ID?.trim() ?? "missing").digest("hex");
    let budget = budgets.get(account);
    if (!budget) {
        budget = createSearchBrowseBudget({ directory: path.join(DATA_DIR, "ebay-search-budgets", account) });
        budgets.set(account, budget);
    }
    return budget;
}
export function browseSearchAllowance() { return currentBudget().status(getAiUsageContext().searchId); }
export function reserveSearchBrowseRequest(reserveDaily: () => Promise<void>, signal?: AbortSignal) {
    return currentBudget().reserve(getAiUsageContext().searchId, reserveDaily, signal);
}
