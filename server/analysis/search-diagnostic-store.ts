import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
    SEARCH_DIAGNOSTIC_OUTCOMES, SEARCH_DIAGNOSTIC_REASONS, SEARCH_DIAGNOSTIC_STATUSES, SOURCE_REJECTION_REASONS,
    type SearchCompetition, type SearchDiagnosticDiscovery, type SearchDiagnosticOverflow, type SearchDiagnosticResult, type SearchDiagnosticRow, type SourceDispositionRow,
} from "../../shared/search-diagnostic.ts";
import { FIRST_REVIEW_COUNT } from "../../shared/search-review-selection.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { DEVELOPMENT_SEARCH_LIMIT, SEARCH_SOURCE_PAGE_LIMIT } from "../../shared/research-policy.ts";
import { writeJsonAtomic } from "../lib/atomic-json.ts";
import { withFileLease } from "../lib/file-lease.ts";
import { DATA_DIR } from "../lib/paths.ts";
import { StorageUnavailableError, storageBackend } from "../storage/index.ts";
import { sqlSearchDiagnostics } from "../storage/search-diagnostics.ts";

const SEARCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LISTING_ID = /^[\w|\-]{1,120}$/;
const MAX_SEARCHES = 50;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORD_SIZE = 64 * 1024;
const MAX_OVERFLOW_ROWS = 2 * SEARCH_SOURCE_PAGE_LIMIT - DEVELOPMENT_SEARCH_LIMIT;

export interface SavedSearchDiagnosticDiscovery {
    searchId: string;
    savedAt: string;
    discovery: SearchDiagnosticDiscovery;
}

export interface SavedSearchDiagnostic<T> extends SavedSearchDiagnosticDiscovery {
    rows: SearchDiagnosticRow[];
    data: T;
}

interface Entry<T> extends SavedSearchDiagnosticDiscovery {
    snapshot?: Pick<SavedSearchDiagnostic<T>, "savedAt" | "rows" | "data"> & Partial<SavedSearchDiagnosticDiscovery>;
    result?: SearchDiagnosticResult;
}
interface Ledger<T> { version: 1; entries: Entry<T>[] }

export class SearchDiagnosticInputError extends Error {}

export function isSearchDiagnosticId(value: unknown): value is string {
    return typeof value === "string" && SEARCH_ID.test(value);
}

function requireSearchId(value: unknown): asserts value is string {
    if (!isSearchDiagnosticId(value)) throw new SearchDiagnosticInputError("A valid completed search ID is required.");
}

function count(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function overflowRecord(overflow: SearchDiagnosticOverflow, retainedIds: readonly string[], unresolved: number, screened: number): SearchDiagnosticOverflow {
    if (overflow?.version !== 1 || overflow.stage !== "SCREENING" || !Array.isArray(overflow.rows) ||
        overflow.rows.length === 0 || overflow.rows.length > MAX_OVERFLOW_ROWS || overflow.rows.length + retainedIds.length > screened) {
        throw new SearchDiagnosticInputError("Completed search has invalid overflow totals or stage.");
    }
    const ids = new Set(retainedIds);
    let blocked = 0;
    const rows = overflow.rows.map(row => {
        if (!row || typeof row.id !== "string" || !LISTING_ID.test(row.id) || ids.has(row.id) ||
            row.reason !== "DISPLAY_LIMIT" && !SEARCH_DIAGNOSTIC_REASONS.includes(row.reason)) {
            throw new SearchDiagnosticInputError("Completed search has an invalid overflow listing or reason.");
        }
        ids.add(row.id);
        if (row.reason !== "DISPLAY_LIMIT") blocked++;
        return { id: row.id, reason: row.reason };
    });
    if (blocked !== unresolved) throw new SearchDiagnosticInputError("Completed search has inconsistent unresolved overflow totals.");
    return { version: 1, stage: "SCREENING", rows };
}

function sourceRows(rows: SourceDispositionRow[], accountedIds: readonly string[]): SourceDispositionRow[] {
    if (!Array.isArray(rows) || rows.length + accountedIds.length > 2 * SEARCH_SOURCE_PAGE_LIMIT) {
        throw new SearchDiagnosticInputError("Completed search has invalid source coverage totals.");
    }
    const ids = new Set(accountedIds);
    return rows.map(row => {
        if (!row || typeof row.id !== "string" || !LISTING_ID.test(row.id) || ids.has(row.id)) {
            throw new SearchDiagnosticInputError("Completed search has an invalid source listing or reason.");
        }
        ids.add(row.id);
        if (row.outcome === "REJECTED" && SOURCE_REJECTION_REASONS.includes(row.reason)) {
            return { id: row.id, outcome: row.outcome, reason: row.reason };
        }
        if (row.outcome === "NOT_REACHED" && row.reason === "ENOUGH_CANDIDATES") {
            return { id: row.id, outcome: row.outcome, reason: row.reason };
        }
        throw new SearchDiagnosticInputError("Completed search has an invalid source listing or reason.");
    });
}

export function competitionRecord(value: SearchCompetition): SearchCompetition {
    const { title, url, price, shipping, ceiling, identity, pricing, image, seller, checkedAt, coverage, concerns } = value ?? {};
    const money = (amount: unknown): amount is number => typeof amount === "number" && Number.isFinite(amount) && amount >= 0;
    const link = parseListingLink(url);
    if (typeof title !== "string" || !title.trim() || title.length > 2000 || !link ||
        !money(price) || price === 0 || !money(shipping) || !money(ceiling) || !["PHOTO", "LABEL", "LISTING"].includes(identity) ||
        pricing !== undefined && (!pricing || !money(pricing.resale) || pricing.resale === 0 || !money(pricing.totalCost) ||
            !Number.isFinite(pricing.profit) || pricing.roi !== null && !Number.isFinite(pricing.roi) || !count(pricing.sales) || pricing.sales < 1) ||
        checkedAt !== undefined && (typeof checkedAt !== "string" || !Number.isFinite(Date.parse(checkedAt))) ||
        coverage !== undefined && (!coverage || !count(coverage.found) || !count(coverage.checked) || coverage.checked > coverage.found) ||
        concerns !== undefined && (!Array.isArray(concerns) || concerns.length > 16 || concerns.some(note => typeof note !== "string" || note.length > 1200))) {
        throw new SearchDiagnosticInputError("Completed search has an invalid Buy It Now comparison.");
    }
    if (image !== undefined) {
        let photo: URL;
        try { photo = new URL(image); } catch { throw new SearchDiagnosticInputError("Completed search has an invalid comparison photo."); }
        if (typeof image !== "string" || image.length > 2048 || photo.protocol !== "https:" || photo.username || photo.password || photo.port ||
            !(photo.hostname === "ebayimg.com" || photo.hostname.endsWith(".ebayimg.com"))) {
            throw new SearchDiagnosticInputError("Completed search has an invalid comparison photo.");
        }
    }
    if (seller !== undefined && seller !== null && (typeof seller !== "object" ||
        seller.username !== null && (typeof seller.username !== "string" || seller.username.length > 200) ||
        seller.feedbackScore !== null && !count(seller.feedbackScore) ||
        seller.feedbackPercentage !== null && (!money(seller.feedbackPercentage) || seller.feedbackPercentage > 100))) {
        throw new SearchDiagnosticInputError("Completed search has an invalid comparison seller.");
    }
    return { title, url: link.url, price, shipping, ceiling, identity,
        ...(pricing && { pricing: { resale: pricing.resale, totalCost: pricing.totalCost, profit: pricing.profit, roi: pricing.roi, sales: pricing.sales } }),
        ...(image !== undefined && { image }), ...(seller !== undefined && { seller: seller === null ? null : {
            username: seller.username, feedbackScore: seller.feedbackScore, feedbackPercentage: seller.feedbackPercentage,
        } }), ...(checkedAt !== undefined && { checkedAt }),
        ...(coverage && { coverage: { found: coverage.found, checked: coverage.checked } }),
        ...(concerns && { concerns: [...concerns] }),
    };
}

function discoveryRecord(value: SearchDiagnosticDiscovery): SearchDiagnosticDiscovery {
    const { total, found, screened, priceExcluded, unresolvedOverflow, overflow, skipped, deferred, previouslySeen, soldPurchaseCeiling, pricePass, marketplaceOrder, retainedIds } = value;
    const { sourceCoverage, sourceDispositions, reviewSelection } = value;
    if (![total, found, skipped, deferred].every(count) ||
        ![screened, priceExcluded, unresolvedOverflow, previouslySeen].every(number => number === undefined || count(number)) ||
        (marketplaceOrder !== undefined && marketplaceOrder !== "newest" && marketplaceOrder !== "lowest" && marketplaceOrder !== "ending") ||
        (sourceCoverage !== undefined && sourceCoverage !== "COMPLETE" && sourceCoverage !== "PARTIAL") ||
        (sourceCoverage === undefined) !== (sourceDispositions === undefined) ||
        (soldPurchaseCeiling !== undefined && (!Number.isFinite(soldPurchaseCeiling) || soldPurchaseCeiling < 0)) ||
        !Array.isArray(retainedIds) || retainedIds.length > DEVELOPMENT_SEARCH_LIMIT ||
        retainedIds.some(id => typeof id !== "string" || !LISTING_ID.test(id)) || new Set(retainedIds).size !== retainedIds.length ||
        pricePass !== undefined && (!pricePass || !["COMPLETE", "UNAVAILABLE"].includes(pricePass.status) ||
            !count(pricePass.newListings) || !count(pricePass.candidates))) {
        throw new SearchDiagnosticInputError("Completed search discovery has invalid diagnostic totals or retained listings.");
    }
    if (reviewSelection !== undefined && (!reviewSelection || !["ai", "rules"].includes(reviewSelection.source) ||
        !Array.isArray(reviewSelection.listingIds) || reviewSelection.listingIds.length > FIRST_REVIEW_COUNT ||
        new Set(reviewSelection.listingIds).size !== reviewSelection.listingIds.length ||
        reviewSelection.listingIds.some(id => !retainedIds.includes(id)))) {
        throw new SearchDiagnosticInputError("Photo review selections must identify distinct retained listings.");
    }
    const cleanOverflow = overflow === undefined ? undefined : overflowRecord(overflow, retainedIds, unresolvedOverflow ?? 0, screened ?? found);
    return { total, found, skipped, deferred,
        ...(screened === undefined ? {} : { screened }),
        ...(priceExcluded === undefined ? {} : { priceExcluded }),
        ...(unresolvedOverflow === undefined ? {} : { unresolvedOverflow }),
        ...(cleanOverflow && { overflow: cleanOverflow }),
        ...(sourceDispositions !== undefined && { sourceCoverage,
            sourceDispositions: sourceRows(sourceDispositions, [...retainedIds, ...(cleanOverflow?.rows.map(row => row.id) ?? [])]) }),
        ...(marketplaceOrder === undefined ? {} : { marketplaceOrder }),
        ...(previouslySeen === undefined ? {} : { previouslySeen }),
        ...(soldPurchaseCeiling === undefined ? {} : { soldPurchaseCeiling }),
        ...(pricePass === undefined ? {} : { pricePass: { status: pricePass.status, newListings: pricePass.newListings, candidates: pricePass.candidates } }),
        ...(value.competition === undefined ? {} : { competition: competitionRecord(value.competition) }),
        ...(reviewSelection && { reviewSelection: { source: reviewSelection.source, listingIds: [...reviewSelection.listingIds] } }),
        retainedIds: [...retainedIds] };
}

export function validateSearchDiagnosticRows(value: unknown, retainedIds: readonly string[]): SearchDiagnosticRow[] {
    if (!Array.isArray(value) || value.length !== retainedIds.length || value.length > DEVELOPMENT_SEARCH_LIMIT) {
        throw new SearchDiagnosticInputError("The diagnostic must account for every listing retained in this search.");
    }
    const retained = new Set(retainedIds);
    const rows = new Map<string, SearchDiagnosticRow>();
    for (const row of value) {
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new SearchDiagnosticInputError("A diagnostic row is invalid.");
        const { id, outcome, reason, photoChecked, priced, profit } = row;
        if (typeof id !== "string" || !retained.has(id) || rows.has(id) ||
            !SEARCH_DIAGNOSTIC_OUTCOMES.includes(outcome) || !SEARCH_DIAGNOSTIC_REASONS.includes(reason) ||
            photoChecked !== undefined && typeof photoChecked !== "boolean" || priced !== undefined && typeof priced !== "boolean" ||
            profit !== undefined && (typeof profit !== "number" || !Number.isFinite(profit))) {
            throw new SearchDiagnosticInputError("A diagnostic row has an unexpected listing ID, outcome, or reason.");
        }
        // Explicitly project the allowed fields. Seller text and provider
        // errors never become part of the saved record or a model prompt.
        rows.set(id, { id, outcome, reason,
            ...(photoChecked === undefined ? {} : { photoChecked }),
            ...(priced === undefined ? {} : { priced }),
            ...(profit === undefined ? {} : { profit }) });
    }
    return retainedIds.map(id => rows.get(id)!);
}

function validateEntry<T>(entry: Entry<T>) {
    requireSearchId(entry.searchId);
    if (typeof entry.savedAt !== "string" || !Number.isFinite(Date.parse(entry.savedAt))) throw new Error("Invalid search timestamp.");
    discoveryRecord(entry.discovery);
    if (entry.snapshot) {
        const snapshot = entry.snapshot;
        if (snapshot.searchId !== undefined && snapshot.searchId !== entry.searchId || typeof snapshot.savedAt !== "string" ||
            !Number.isFinite(Date.parse(snapshot.savedAt)) || !Object.hasOwn(snapshot, "data")) throw new Error("Invalid diagnostic snapshot.");
        validateSearchDiagnosticRows(snapshot.rows, entry.discovery.retainedIds);
    }
    if (entry.result && (!entry.snapshot || entry.result.searchId !== entry.searchId ||
        !SEARCH_DIAGNOSTIC_STATUSES.includes(entry.result.status))) throw new Error("Invalid diagnostic review.");
}

export function createSearchDiagnosticStore<T>({
    directory = path.join(DATA_DIR, "search-diagnostics"), now = Date.now, maxAgeMs = MAX_AGE_MS, maxSearches = MAX_SEARCHES, backend = storageBackend,
}: { directory?: string; now?: () => number; maxAgeMs?: number; maxSearches?: number; backend?: typeof storageBackend } = {}) {
    if (!Number.isSafeInteger(maxSearches) || maxSearches < 1 || maxSearches > MAX_SEARCHES ||
        !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > MAX_AGE_MS) throw new RangeError("Invalid search diagnostic retention.");
    const file = path.join(directory, "index.json");
    const sql = async () => {
        const { getSqlExecutor } = await import("../storage/client.ts");
        return sqlSearchDiagnostics<Entry<T>>(await getSqlExecutor(), validateEntry);
    };
    const read = async (): Promise<Ledger<T>> => {
        try {
            const value = JSON.parse(await fs.readFile(file, "utf8")) as Ledger<T>;
            if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_SEARCHES ||
                new Set(value.entries.map(entry => entry.searchId)).size !== value.entries.length) {
                throw new Error("Invalid search diagnostic index.");
            }
            value.entries.forEach(validateEntry);
            return value;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
            throw new StorageUnavailableError("Saved search diagnostics could not be read.", { cause: error });
        }
    };
    const active = (entry: Entry<T>, at = now()) => Date.parse(entry.savedAt) > at - maxAgeMs;
    async function find(searchId: string): Promise<Entry<T> | null> {
        requireSearchId(searchId);
        const entry = backend() === "azure-sql" ? await (await sql()).get(searchId) : (await read()).entries.find(e => e.searchId === searchId);
        return entry && active(entry) ? entry : null;
    }
    async function edit<R>(searchId: string, change: (entries: Entry<T>[], at: number) => R): Promise<R> {
        if (backend() === "azure-sql") {
            const at = now();
            return (await sql()).edit(searchId, new Date(at - maxAgeMs), maxSearches, entries => change(entries, at));
        }
        return withFileLease(file, async () => {
            const at = now();
            const book = await read();
            const before = JSON.stringify(book);
            const entries = book.entries.filter(entry => active(entry, at));
            const result = change(entries, at);
            const retained = entries.slice(0, maxSearches);
            const updated = { version: 1, entries: retained };
            if (before !== JSON.stringify(updated)) await writeJsonAtomic(file, updated);
            return result;
        }, { timeoutError: () => new StorageUnavailableError("Saved search diagnostics are busy.") });
    }
    const discoveryFrom = ({ searchId, savedAt, discovery }: Entry<T>) => ({ searchId, savedAt, discovery: discoveryRecord(discovery) });
    function snapshotFrom(entry: Entry<T>): SavedSearchDiagnostic<T> | null {
        if (!entry.snapshot) return null;
        const discovery = discoveryRecord(entry.discovery);
        return { ...entry.snapshot, searchId: entry.searchId, discovery, rows: validateSearchDiagnosticRows(entry.snapshot.rows, discovery.retainedIds) };
    }
    function requireRecordSize(value: unknown) {
        if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RECORD_SIZE) throw new Error("The search diagnostic exceeds its saved size limit.");
    }
    return {
        async importLocalDiagnostics() {
            if (backend() !== "azure-sql") throw new Error("Select Azure SQL to import saved search diagnostics.");
            const saved = (await read()).entries.filter(entry => active(entry));
            const target = await sql();
            let imported = 0;
            let verified = 0;
            for (const entry of saved) {
                const snapshot = entry.snapshot && { savedAt: entry.snapshot.savedAt, rows: entry.snapshot.rows, data: entry.snapshot.data };
                await target.edit(entry.searchId, new Date(now() - maxAgeMs), maxSearches, items => {
                    const existing = items[0];
                    if (!existing) {
                        items.push({ ...entry, snapshot });
                        imported++;
                    } else {
                        if (!isDeepStrictEqual(existing.discovery, entry.discovery)) throw new Error("Saved search discovery differs between the source and database.");
                        if (existing.snapshot && snapshot && !isDeepStrictEqual(snapshotFrom(existing), snapshotFrom(entry)))
                            throw new Error("Saved search decisions differ between the source and database.");
                        if (!existing.snapshot && snapshot) existing.snapshot = snapshot;
                        if (!existing.result || existing.result.status === "unavailable" && entry.result?.status === "complete")
                            existing.result = entry.result;
                    }
                });
                const check = await target.get(entry.searchId);
                if (!check || !isDeepStrictEqual(entry.discovery, check.discovery) ||
                    snapshot && !isDeepStrictEqual(snapshotFrom(entry), snapshotFrom(check)) || entry.result && !check.result)
                    throw new Error("Imported search evidence could not be verified in Azure SQL.");
                verified++;
            }
            return { local: saved.length, imported, verified };
        },
        async saveDiscovery(searchId: string, discovery: SearchDiagnosticDiscovery, verifiedContinuation = false): Promise<SavedSearchDiagnosticDiscovery> {
            requireSearchId(searchId);
            const clean = discoveryRecord(discovery);
            return edit(searchId, (entries, at) => {
                const index = entries.findIndex(entry => entry.searchId === searchId);
                const previous = entries[index];
                if (previous) {
                    const old = previous.discovery;
                    // Older versions recorded the quota pause as an empty partial
                    // batch. Only a verified replay with new rows can repair it.
                    const quotaPlaceholder = old.sourceCoverage === "PARTIAL" && old.found === 0 &&
                        !old.retainedIds.length && !old.sourceDispositions?.length && !previous.snapshot && !previous.result;
                    if (!verifiedContinuation || !quotaPlaceholder || !clean.retainedIds.length) return discoveryFrom(previous);
                    entries.splice(index, 1);
                }
                const entry = { searchId, savedAt: new Date(at).toISOString(), discovery: clean };
                entries.unshift(entry);
                return entry;
            });
        },
        async loadDiscovery(searchId: string): Promise<SavedSearchDiagnosticDiscovery | null> {
            const entry = await find(searchId);
            return entry ? discoveryFrom(entry) : null;
        },
        async recentAssessedListingIds(): Promise<string[]> {
            const entries = backend() === "azure-sql" ? await (await sql()).recent(new Date(now() - maxAgeMs), maxSearches)
                : (await read()).entries.filter(entry => active(entry));
            const rows = entries.map(entry => entry.snapshot?.rows ?? []);
            const result = new Set<string>();
            // Sample across searches so one set's 50 copies cannot crowd out the rest.
            for (const eligible of [(r: SearchDiagnosticRow) => r.priced, (r: SearchDiagnosticRow) => r.photoChecked]) {
                const searches = rows.map(group => group.filter(eligible));
                for (let i = 0; i < DEVELOPMENT_SEARCH_LIMIT; i++) {
                    for (const search of searches) {
                        if (search[i]) result.add(search[i].id);
                        if (result.size === 3 * DEVELOPMENT_SEARCH_LIMIT) return [...result];
                    }
                }
            }
            return [...result];
        },
        async saveSnapshot(searchId: string, rows: unknown, data: T): Promise<SavedSearchDiagnostic<T> | null> {
            requireSearchId(searchId);
            return edit(searchId, (entries, at) => {
                const entry = entries.find(entry => entry.searchId === searchId);
                if (!entry) return null;
                const cleanRows = validateSearchDiagnosticRows(rows, entry.discovery.retainedIds);
                const previous = snapshotFrom(entry);
                if (previous) return previous;
                const snapshot = { ...discoveryFrom(entry), savedAt: new Date(at).toISOString(), rows: cleanRows, data };
                const stored = { savedAt: snapshot.savedAt, rows: cleanRows, data };
                requireRecordSize(stored);
                entry.snapshot = stored;
                return snapshot;
            });
        },
        async loadSnapshot(searchId: string): Promise<SavedSearchDiagnostic<T> | null> {
            const entry = await find(searchId);
            return entry ? snapshotFrom(entry) : null;
        },
        async saveResult(searchId: string, result: SearchDiagnosticResult): Promise<SearchDiagnosticResult | null> {
            requireSearchId(searchId);
            if (result.searchId !== searchId) throw new SearchDiagnosticInputError("The review belongs to another search.");
            if (!SEARCH_DIAGNOSTIC_STATUSES.includes(result.status)) throw new SearchDiagnosticInputError("Invalid diagnostic result status.");
            return edit(searchId, entries => {
                const entry = entries.find(entry => entry.searchId === searchId);
                if (!entry?.snapshot) return null;
                // Across app processes, an unavailable result can arrive before
                // the caller holding the paid request finishes saving its answer.
                if (entry.result && !(entry.result.status === "unavailable" && result.status === "complete")) return entry.result;
                requireRecordSize(result);
                entry.result = result;
                return result;
            });
        },
        async loadResult(searchId: string): Promise<SearchDiagnosticResult | null> {
            return (await find(searchId))?.result ?? null;
        },
    };
}
