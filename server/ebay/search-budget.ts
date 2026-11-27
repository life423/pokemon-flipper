import { readDataFile } from "../storage/data-file.ts";
import path from "node:path";
import { createHash } from "node:crypto";
import type { EbaySearchAllowance } from "../../shared/types.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { DATA_DIR } from "../lib/paths.ts";
import { writeJsonAtomic } from "../lib/atomic-json.ts";
import { withFileLease } from "../lib/file-lease.ts";
import { getBudgetContext } from "../lib/provider-context.ts";
import { EbayBudgetError } from "./daily-budget.ts";

// Legacy ledgers and controlled offline benchmarks still use this bound.
export const EBAY_SEARCH_BROWSE_LIMIT = 100;
const STORED_SEARCH_BROWSE_LIMITS = new Set([25, 50, EBAY_SEARCH_BROWSE_LIMIT]);
const VALID_ID = /^[a-zA-Z0-9_-]{1,80}$/;
type Ledger = { searchId: string; used: number } & (
    { version: 1; limit: number } | { version: 2; limit: null; policy: "daily-reserve"; historicalLimit: number | null }
);
export class EbaySearchBudgetError extends EbayBudgetError {}
const historicalLimit = (ledger: Ledger) => ledger.version === 1 ? ledger.limit : ledger.historicalLimit;

export function requireBrowseSearchId(searchId = getBudgetContext().searchId): string {
    if (!searchId || !VALID_ID.test(searchId)) throw new EbaySearchBudgetError(
        "A valid search ID is required before eBay Browse requests can start. Follow-up work keeps the original search's request history.");
    return searchId;
}

// Count requests under their original search across restarts and continuations.
// The daily reserve controls admission. A legacy limit remains in the record
// as historical metadata when the next reservation advances it to v2.
export function createSearchBrowseBudget({ directory }: { directory: string }) {
    const serial = createLimiter(1);
    const fileFor = (id: string) => path.join(directory, `${createHash("sha256").update(id).digest("hex")}.json`);
    const read = async (id: string): Promise<Ledger> => {
        let value: unknown;
        try { value = JSON.parse(await readDataFile(fileFor(id), "utf8")); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, policy: "daily-reserve", searchId: id, limit: null, historicalLimit: null, used: 0 };
            throw new EbaySearchBudgetError("The eBay per-search request accounting could not be read. No Browse request was sent.");
        }
        const ledger = value as Partial<Ledger> | null;
        const validPolicy = ledger?.version === 1 ? STORED_SEARCH_BROWSE_LIMITS.has(ledger.limit!) && ledger.used! <= ledger.limit! :
            ledger?.version === 2 && ledger.policy === "daily-reserve" && ledger.limit === null &&
            (ledger.historicalLimit === null || STORED_SEARCH_BROWSE_LIMITS.has(ledger.historicalLimit!));
        if (!ledger || !validPolicy || ledger.searchId !== id || !Number.isSafeInteger(ledger.used) || ledger.used! < 0) {
            throw new EbaySearchBudgetError("The eBay per-search request accounting is invalid. No Browse request was sent.");
        }
        return ledger as Ledger;
    };
    return {
        async status(searchId?: string): Promise<EbaySearchAllowance | null> {
            if (searchId === undefined) return null;
            const id = requireBrowseSearchId(searchId), ledger = await read(id);
            return { searchId: id, policy: "daily-reserve", limit: null, remaining: null, used: ledger.used, historicalLimit: historicalLimit(ledger) };
        },
        reserve(searchId: string | undefined, reserveDaily: () => Promise<void>, signal?: AbortSignal): Promise<void> {
            const id = requireBrowseSearchId(searchId);
            return serial(async () => {
                signal?.throwIfAborted();
                try {
                    await withFileLease(fileFor(id), async () => {
                        const ledger = await read(id);
                        signal?.throwIfAborted();
                        if (!Number.isSafeInteger(ledger.used + 1)) throw new EbaySearchBudgetError("eBay's search request counter is full. No Browse request was sent.");
                        await reserveDaily();
                        // Persist before dispatch. Failed/uncertain requests are
                        // never refunded: eBay may already have counted them.
                        await writeJsonAtomic(fileFor(id), { ...ledger, version: 2, policy: "daily-reserve", limit: null,
                            historicalLimit: historicalLimit(ledger), used: ledger.used + 1 });
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
export function browseSearchAllowance() { return currentBudget().status(getBudgetContext().searchId); }
export function reserveSearchBrowseRequest(reserveDaily: () => Promise<void>, signal?: AbortSignal) {
    return currentBudget().reserve(getBudgetContext().searchId, reserveDaily, signal);
}
