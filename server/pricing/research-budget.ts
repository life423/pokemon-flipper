import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { DATA_DIR } from "../lib/paths.ts";
import { writeJsonAtomic } from "../lib/atomic-json.ts";
import { withFileLease } from "../lib/file-lease.ts";
import { createKeyedLock } from "../lib/keyed-lock.ts";
import { getAiUsageContext, type AiUsageContext } from "../ai/usage-context.ts";
import { recordProviderUsage } from "../lib/provider-usage.ts";
import type { PricingResearchUsage } from "../../shared/pricing-usage.ts";

// New searches receive more research headroom. A stored search keeps the
// allowance under which its requests were reserved, including exhausted IDs.
export const PRICE_RESEARCH_LIMIT = 256;
const STORED_PRICE_RESEARCH_LIMITS = new Set([64, 128, PRICE_RESEARCH_LIMIT]);
type FailureReason = "LIMIT" | "SCOPE" | "ACCOUNT" | "STORAGE" | "LOCK" | "STATE";
export class PriceResearchBudgetError extends Error {
    readonly code = "PRICE_RESEARCH_BUDGET";
    readonly retryable = false;
    constructor(message: string, readonly reason: FailureReason) { super(message); }
}
export interface PriceRequestReservation {
    complete(response: Response, body: unknown): Promise<void>;
    unresolved(): Promise<void>;
}
type Endpoint = "CATALOG" | "CARD" | "SOLD_LISTINGS" | "OTHER";
interface Attempt {
    id: string;
    requestHash: string;
    endpoint: Endpoint;
    listingId: string | null;
    reservedAt: string;
    completedAt: string | null;
    state: "PENDING" | "COMPLETE" | "UNRESOLVED";
    status: number | null;
    headers: Record<string, number>;
    rows: number | null;
}
interface Ledger { version: 1; searchId: string; limit: number; attempts: Attempt[] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const LISTING = /^[a-zA-Z0-9_|:-]{1,200}$/;
const HEADERS = new Set(["x-credits-charged", "x-credits-limit", "x-credits-remaining", "x-credits-balance", "x-credits-reset", "x-rate-limit", "x-rate-remaining", "x-rate-reset"]);
const ATTEMPT_KEYS = new Set(["id", "requestHash", "endpoint", "listingId", "reservedAt", "completedAt", "state", "status", "headers", "rows"]);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const stopped = new AsyncLocalStorage<AbortSignal | undefined>();
export function withPriceResearchSignal<T>(signal: AbortSignal | undefined, work: () => T): T { return stopped.run(signal, work); }
export function getPriceResearchSignal(): AbortSignal | undefined { return stopped.getStore(); }
function scope(searchId: string | undefined): string {
    if (!searchId || !UUID.test(searchId)) throw new PriceResearchBudgetError("A valid search UUID is required before price research can start. Follow-up work must keep the original search ID and its request allowance.", "SCOPE");
    return searchId.toLowerCase();
}
function capError(limit: Ledger["limit"]): PriceResearchBudgetError {
    return new PriceResearchBudgetError(`This search has reached its ${limit}-request price-research allowance. Saved market evidence remains available; this is a search limit, not exhausted provider credits.`, "LIMIT");
}
function request(path: string): { requestHash: string; endpoint: Endpoint } {
    if (typeof path !== "string" || !/^\/(?!\/)/.test(path) || /[\r\n\\]/.test(path)) throw new PriceResearchBudgetError("The price-research endpoint is invalid. No provider request was authorized.", "STATE");
    const pathname = path.split("?", 1)[0];
    return { requestHash: hash(path), endpoint: pathname.endsWith("/listings/ebay") ? "SOLD_LISTINGS"
        : /^\/(?:cards|sets)$/.test(pathname) ? "CATALOG" : /^\/cards\/[^/]+$/.test(pathname) ? "CARD" : "OTHER" };
}
function numericHeaders(response: Response): Record<string, number> {
    const headers: Record<string, number> = {};
    for (const name of HEADERS) {
        const raw = response.headers.get(name);
        if (raw === null || !/^\d+$/.test(raw)) continue;
        const value = Number(raw); if (count(value)) headers[name] = value;
    }
    return headers;
}
function returnedRows(body: unknown): number | null {
    if (!body || typeof body !== "object") return null;
    const object = body as Record<string, unknown>;
    if (Array.isArray(object.data)) return object.data.length;
    const item = object.data && typeof object.data === "object" && !Array.isArray(object.data) ? object.data as Record<string, unknown> : object;
    return (typeof item.id === "number" || typeof item.id === "string") && ("name" in item || "number" in item || "prices" in item) ? 1 : null;
}
function validAttempt(value: unknown): value is Attempt {
    const attempt = value as Attempt | null;
    if (!attempt || typeof attempt !== "object" || Object.keys(attempt).some(key => !ATTEMPT_KEYS.has(key)) || !UUID.test(attempt.id) || !HASH.test(attempt.requestHash) ||
        !["CATALOG", "CARD", "SOLD_LISTINGS", "OTHER"].includes(attempt.endpoint) ||
        attempt.listingId !== null && (typeof attempt.listingId !== "string" || !LISTING.test(attempt.listingId)) ||
        !date(attempt.reservedAt) || !["PENDING", "COMPLETE", "UNRESOLVED"].includes(attempt.state) ||
        !attempt.headers || typeof attempt.headers !== "object" || Array.isArray(attempt.headers) ||
        Object.entries(attempt.headers).some(([key, value]) => !HEADERS.has(key) || !count(value)) ||
        attempt.rows !== null && !count(attempt.rows)) return false;
    if (attempt.state === "COMPLETE") return date(attempt.completedAt) && Number.isInteger(attempt.status) && attempt.status! >= 100 && attempt.status! <= 599;
    return attempt.completedAt === null && attempt.status === null && attempt.rows === null && Object.keys(attempt.headers).length === 0;
}
function summarize(ledger: Ledger): PricingResearchUsage {
    const completed = ledger.attempts.filter(attempt => attempt.state === "COMPLETE");
    const observed = completed.filter(attempt => ["x-credits-limit", "x-credits-remaining", "x-credits-balance", "x-credits-reset"].some(key => attempt.headers[key] !== undefined)).at(-1);
    const provider = observed?.headers;
    return { searchId: ledger.searchId, limit: ledger.limit, used: ledger.attempts.length, remaining: ledger.limit - ledger.attempts.length,
        completed: completed.length, pending: ledger.attempts.filter(attempt => attempt.state === "PENDING").length,
        unresolved: ledger.attempts.filter(attempt => attempt.state === "UNRESOLVED").length,
        reportedCredits: completed.reduce((sum, attempt) => sum + (attempt.headers["x-credits-charged"] ?? 0), 0),
        unreportedCreditAttempts: ledger.attempts.filter(attempt => attempt.headers["x-credits-charged"] === undefined).length,
        returnedRows: completed.reduce((sum, attempt) => sum + (attempt.rows ?? 0), 0),
        unreportedRowAttempts: ledger.attempts.filter(attempt => attempt.rows === null).length,
        provider: provider ? { limit: provider["x-credits-limit"] ?? null, remaining: provider["x-credits-remaining"] ?? null,
            balance: provider["x-credits-balance"] ?? null, resetSeconds: provider["x-credits-reset"] ?? null, observedAt: observed!.completedAt! } : null };
}

// This local namespace is derived from the configured key, not a provider
// account identity. Key rotation/independent replicas need shared authority;
// neither a calendar change nor a process restart resets this search ledger.
export function createPriceResearchBudget({ directory, now = Date.now, providerKey, observeProviderUsage = recordProviderUsage }: {
    directory: string; now?: () => number; providerKey?: string; observeProviderUsage?: typeof recordProviderUsage;
}) {
    const locked = createKeyedLock();
    const fileFor = (id: string) => path.join(directory, `${hash(id)}.json`);
    async function read(id: string): Promise<Ledger> {
        let value: unknown;
        try { value = JSON.parse(await fs.readFile(fileFor(id), "utf8")); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, searchId: id, limit: PRICE_RESEARCH_LIMIT, attempts: [] };
            throw new PriceResearchBudgetError("The price-research accounting could not be read. No new provider request was authorized.", "STORAGE");
        }
        const ledger = value as Ledger | null;
        if (!ledger || Object.keys(ledger).some(key => !["version", "searchId", "limit", "attempts"].includes(key)) || ledger.version !== 1 || ledger.searchId !== id ||
            !STORED_PRICE_RESEARCH_LIMITS.has(ledger.limit) || !Array.isArray(ledger.attempts) ||
            ledger.attempts.length > ledger.limit || !ledger.attempts.every(validAttempt) || new Set(ledger.attempts.map(attempt => attempt.id.toLowerCase())).size !== ledger.attempts.length ||
            !Number.isSafeInteger(ledger.attempts.reduce((sum, attempt) => sum + (attempt.headers["x-credits-charged"] ?? 0), 0)))
            throw new PriceResearchBudgetError("The price-research accounting is invalid. Its evidence was kept and no new provider request was authorized.", "STATE");
        return ledger;
    }
    async function edit<T>(id: string, work: (ledger: Ledger) => Promise<T>, signal?: AbortSignal): Promise<T> {
        return locked(id, async () => {
            signal?.throwIfAborted();
            try { return await withFileLease(fileFor(id), () => read(id).then(work), { signal,
                timeoutError: () => new PriceResearchBudgetError("The price-research ledger is locked. No new request was authorized; retain the ledger when inspecting a crashed process.", "LOCK") }); }
            catch (error) {
                signal?.throwIfAborted();
                if (error instanceof PriceResearchBudgetError) throw error;
                throw new PriceResearchBudgetError("The price-research accounting could not be saved. No additional provider request was authorized.", "STORAGE");
            }
        });
    }
    return {
        async summary(searchId?: string): Promise<PricingResearchUsage | null> { return searchId === undefined ? null : summarize(await read(scope(searchId))); },
        async assertAvailable(searchId: string | undefined, signal?: AbortSignal): Promise<void> {
            signal?.throwIfAborted(); const ledger = await read(scope(searchId)); signal?.throwIfAborted();
            if (ledger.attempts.length >= ledger.limit) throw capError(ledger.limit);
        },
        async reserve(path: string, context: AiUsageContext, signal?: AbortSignal): Promise<PriceRequestReservation> {
            signal?.throwIfAborted(); const id = scope(context.searchId), target = request(path);
            const attempt: Attempt = { ...target, id: randomUUID(), listingId: context.listingId && LISTING.test(context.listingId) ? context.listingId : null,
                reservedAt: new Date(now()).toISOString(), completedAt: null, state: "PENDING", status: null, headers: {}, rows: null };
            await edit(id, async ledger => {
                signal?.throwIfAborted(); if (ledger.attempts.length >= ledger.limit) throw capError(ledger.limit);
                await writeJsonAtomic(fileFor(id), { ...ledger, attempts: [...ledger.attempts, attempt] });
            }, signal);
            signal?.throwIfAborted();
            return {
                complete: async (response, body) => {
                    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new PriceResearchBudgetError("The price response has no usable HTTP status; its request remains unresolved.", "STATE");
                    const result = { status: response.status, headers: numericHeaders(response), rows: returnedRows(body) };
                    const observation = await edit(id, async ledger => {
                        const saved = ledger.attempts.find(value => value.id === attempt.id);
                        if (!saved) throw new PriceResearchBudgetError("The reserved price request is missing from its ledger. No additional request was authorized.", "STATE");
                        if (saved.state === "COMPLETE") {
                            if (JSON.stringify({ status: saved.status, headers: saved.headers, rows: saved.rows }) !== JSON.stringify(result)) throw new PriceResearchBudgetError("A completed price request cannot be replaced with different accounting.", "STATE");
                            return;
                        }
                        if (!Number.isSafeInteger(ledger.attempts.filter(value => value.id !== attempt.id).reduce((sum, value) => sum + (value.headers["x-credits-charged"] ?? 0), 0) + (result.headers["x-credits-charged"] ?? 0)))
                            throw new PriceResearchBudgetError("The reported provider credits exceed safe accounting precision; the request remains unresolved.", "STATE");
                        Object.assign(saved, result, { state: "COMPLETE", completedAt: new Date(now()).toISOString() });
                        // Completion order is durable even when responses share
                        // the same millisecond or the machine clock moves back.
                        ledger.attempts = [...ledger.attempts.filter(value => value.id !== saved.id), saved];
                        await writeJsonAtomic(fileFor(id), ledger);
                        return { headers: { ...saved.headers }, completedAt: saved.completedAt! };
                    });
                    // Record only a newly completed durable response. Its reset
                    // seconds belong to that observation time, not a later poll.
                    // Monitoring never turns an accepted paid response into an
                    // error or a reason to purchase replacement evidence.
                    if (observation && providerKey?.trim()) try {
                        const limit = observation.headers["x-credits-limit"], remaining = observation.headers["x-credits-remaining"], resetSeconds = observation.headers["x-credits-reset"];
                        if (count(limit) && limit > 0 && count(remaining) && remaining <= limit && count(resetSeconds) && resetSeconds > 0) {
                            const resetsAt = new Date(Date.parse(observation.completedAt) + resetSeconds * 1000).toISOString();
                            await observeProviderUsage("PKMNPRICES", providerKey, { limit, remaining, observedAt: observation.completedAt, resetsAt });
                        }
                    } catch { /* Durable pricing evidence remains authoritative when monitoring is unavailable. */ }
                },
                unresolved: async () => edit(id, async ledger => {
                    const saved = ledger.attempts.find(value => value.id === attempt.id);
                    if (!saved) throw new PriceResearchBudgetError("The reserved price request is missing from its ledger.", "STATE");
                    if (saved.state !== "PENDING") return;
                    saved.state = "UNRESOLVED"; await writeJsonAtomic(fileFor(id), ledger);
                }),
            };
        },
    };
}
const budgets = new Map<string, ReturnType<typeof createPriceResearchBudget>>();
function currentBudget() {
    const key = process.env.PKMNPRICES_API_KEY?.trim();
    if (!key) throw new PriceResearchBudgetError("A configured price-service key is required before uncached price research can start.", "ACCOUNT");
    const account = hash(key);
    let budget = budgets.get(account);
    if (!budget) { budget = createPriceResearchBudget({ directory: path.join(DATA_DIR, "price-research-budgets", account), providerKey: key }); budgets.set(account, budget); }
    return budget;
}
export function priceResearchSummary(searchId = getAiUsageContext().searchId) {
    if (searchId === undefined) return Promise.resolve(null);
    scope(searchId); return currentBudget().summary(searchId);
}
export function assertPriceResearchAvailable(signal = getPriceResearchSignal()) {
    signal?.throwIfAborted(); scope(getAiUsageContext().searchId);
    return currentBudget().assertAvailable(getAiUsageContext().searchId, signal);
}
export function reservePriceRequest(path: string, signal = getPriceResearchSignal()) {
    signal?.throwIfAborted(); scope(getAiUsageContext().searchId);
    return currentBudget().reserve(path, getAiUsageContext(), signal);
}
