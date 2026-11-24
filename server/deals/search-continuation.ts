import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../lib/paths.ts";
import { writeJsonAtomic } from "../lib/atomic-json.ts";
import { withFileLease } from "../lib/file-lease.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import type { ListingSummary } from "../../shared/types.ts";
import type { SearchContinuation } from "../../shared/search-continuation.ts";
import type { SearchOptions, SearchSummary } from "./find-deals.ts";
import type { SourceDispositionRow, ScreenedOverflowRow } from "../../shared/search-diagnostic.ts";
import type { ListingFilters } from "../../shared/listing-filters.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface DiscoverySourceCursor {
    query: string;
    sort: "newlyListed" | "price" | "endingSoonest";
    filters: ListingFilters;
    offset: number;
    total: number;
}
export type DiscoveryRequest = Pick<SearchOptions, "minPrice" | "filters" | "targets" | "includeOffers" | "automaticPhotos" | "marketplaceOrder" | "asOf" | "newOnly"> & { search: string };
export interface DiscoveryBacklog {
    rootSearchId: string;
    request: DiscoveryRequest;
    pending: ListingSummary[];
    seenIds: string[];
    sources: DiscoverySourceCursor[];
    total: number;
    sourceLimitReached?: boolean;
}
export interface DiscoveryBatchReceipt {
    summary: SearchSummary;
    listings: ListingSummary[];
    dispositions: SourceDispositionRow[];
    overflow: ScreenedOverflowRow[];
}
interface SavedBatch { version: 1; searchId: string; savedAt: string; state: DiscoveryBacklog; runningPid?: number; receipt?: DiscoveryBatchReceipt }

export function createDiscoveryContinuationStore(directory = path.join(DATA_DIR, "search-continuations")) {
    const share = createSharedWork();
    const owners = new Map<string, string>();
    const file = (token: string) => {
        if (!UUID.test(token)) throw new Error("The saved search continuation is invalid.");
        return path.join(directory, `${token}.json`);
    };
    const read = async (token: string): Promise<SavedBatch> => {
        const saved = await fs.readFile(file(token), "utf8").then(JSON.parse).catch(error => {
            if (error.code === "ENOENT") throw new Error("The saved search continuation is unavailable. Start a new search.");
            throw error;
        }) as SavedBatch;
        if (saved.version !== 1 || !UUID.test(saved.searchId) || !UUID.test(saved.state?.rootSearchId) ||
            !Array.isArray(saved.state.pending) || !Array.isArray(saved.state.sources) || !Array.isArray(saved.state.seenIds) || !saved.state.request?.search)
            throw new Error("The saved search continuation could not be read safely.");
        return saved;
    };
    return {
        async create(state: DiscoveryBacklog): Promise<SearchContinuation> {
            if (!UUID.test(state.rootSearchId)) throw new Error("A search account is required to preserve the remaining listings.");
            const token = randomUUID(), searchId = randomUUID();
            await fs.mkdir(directory, { recursive: true });
            await writeJsonAtomic(file(token), { version: 1, searchId, savedAt: new Date().toISOString(), state } satisfies SavedBatch);
            await writeJsonAtomic(path.join(directory, `${searchId}.owner.json`), { rootSearchId: state.rootSearchId });
            owners.set(searchId, state.rootSearchId);
            return { token, searchId, pending: state.pending.length, moreSource: state.sources.length > 0,
                ...(state.sourceLimitReached && { sourceLimitReached: true }) };
        },
        async budgetOwner(searchId: string | undefined): Promise<string | undefined> {
            if (!searchId || !UUID.test(searchId)) return undefined;
            if (owners.has(searchId)) return owners.get(searchId);
            const value = await fs.readFile(path.join(directory, `${searchId}.owner.json`), "utf8").then(JSON.parse).catch(error => {
                if (error.code === "ENOENT") return null;
                throw error;
            });
            if (!value) return undefined;
            if (!UUID.test(value.rootSearchId)) throw new Error("The continuation's original research account is invalid.");
            owners.set(searchId, value.rootSearchId);
            return value.rootSearchId;
        },
        async run(token: string, searchId: string | undefined, work: (state: DiscoveryBacklog, signal: AbortSignal) => Promise<DiscoveryBatchReceipt>, signal?: AbortSignal) {
            const owner = await read(token);
            if (owner.searchId !== searchId) throw new Error("This continuation belongs to a different discovery record.");
            let executed = false;
            const receipt = await share(token, async active => {
                const saved = await read(token);
                if (saved.searchId !== searchId) throw new Error("This continuation belongs to a different discovery record.");
                if (saved.receipt) return saved.receipt;
                let completed: DiscoveryBatchReceipt | undefined;
                await withFileLease(file(token), async () => {
                    const latest = await read(token);
                    if (latest.receipt) { completed = latest.receipt; return; }
                    if (latest.runningPid) {
                        let alive = true;
                        try { process.kill(latest.runningPid, 0); } catch { alive = false; }
                        if (alive) throw new Error("This saved discovery batch is already running. Its research is being kept.");
                    }
                    await writeJsonAtomic(file(token), { ...latest, runningPid: process.pid });
                }, { signal: active, timeoutError: () => new Error("The continuation is busy. No duplicate batch was started.") });
                if (completed) return completed;
                // Bookkeeping leases never contain provider requests.
                executed = true;
                try {
                    const result = await work(saved.state, active);
                    await withFileLease(file(token), async () => {
                        await writeJsonAtomic(file(token), result.summary.continuation?.blocked ? saved : { ...saved, receipt: result });
                    }, { timeoutError: () => new Error("The completed discovery batch could not be saved.") });
                    return result;
                } catch (error) {
                    await writeJsonAtomic(file(token), saved).catch(() => {});
                    throw error;
                }
            }, signal);
            return { receipt: structuredClone(receipt), reused: !executed };
        },
    };
}
export const discoveryContinuations = createDiscoveryContinuationStore();
