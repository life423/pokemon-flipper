import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DATA_DIR } from "../lib/paths.ts";
import { getAiDispatchSignal, type AiUsageContext } from "./usage-context.ts";
import { aiInputHash, createAiInputPreflight, verifiedCacheOptions, type AiInputProof } from "./input-preflight.ts";
export { aiInputHash } from "./input-preflight.ts";
export type { AiInputProof } from "./input-preflight.ts";

export class AiSpendingError extends Error {
    constructor(readonly code: "AI_PAUSED" | "AI_BUDGET", message: string, options?: ErrorOptions) { super(message, options); }
}
export function aiSpendingFailure(error: unknown): AiSpendingError | null {
    const seen = new Set<unknown>();
    for (let current = error; current && typeof current === "object" && !seen.has(current);) {
        seen.add(current);
        const value = current as { code?: unknown; message?: unknown; cause?: unknown };
        if (value.code === "AI_PAUSED" || value.code === "AI_BUDGET") return current instanceof AiSpendingError ? current
            : new AiSpendingError(value.code, typeof value.message === "string" ? value.message : "Paid AI is paused by the local spending guard.");
        current = value.cause;
    }
    return null;
}

interface Control { version: 1; paused: boolean; perSearchCapUsd: number | null; ledgerId: string; pauseReason?: string }
interface Attempt {
    id: string; inputHash: string; model: string; createdAt: string;
    maxInputTokens: number; maxOutputTokens: number; reservedNanoUsd: number;
    heldNanoUsd: number; state: "RESERVED" | "SETTLED";
}
interface Account { capNanoUsd: number; heldNanoUsd: number; attempts: Attempt[] }
interface Ledger { version: 1; id: string; searches: Record<string, Account> }
export interface AiReservation { ledgerId: string; searchId: string; attemptId: string }
// Only a trusted, exact preflight can supply this proof. Never trust a token
// number in seller data, request metadata, JSON length or image dimensions.
interface Options { directory?: string; preflight?: (body: unknown) => Promise<AiInputProof> }
const NANO_USD = 1_000_000_000;
export const AI_SEARCH_HARD_CAP_USD = 0.02;
export const MAX_STANDARD_INPUT_TOKENS = 272_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// USD / million tokens, represented exactly as nano-USD / token. Only the
// verified default tier and 30-minute/in-memory write rates are supported.
const RATES: Record<string, { input: number; cached: number; write: number; output: number }> = {
    "gpt-5.6-terra": { input: 2000, cached: 200, write: 2500, output: 12000 },
    "gpt-5.6-luna": { input: 200, cached: 20, write: 250, output: 1200 },
    "gpt-6-luna": { input: 100, cached: 10, write: 125, output: 500 },
};
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const fail = (message: string, cause?: unknown): never => { throw new AiSpendingError("AI_BUDGET", `${message} Cached results and screened candidates remain available.`, cause === undefined ? undefined : { cause }); };

async function readJson(file: string): Promise<any | null> {
    try { return JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return fail("Paid AI is blocked because its spending control or ledger could not be read.", error); }
}
async function durableJson(file: string, value: unknown) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await fs.open(temporary, "wx"); await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
        await handle.sync(); await handle.close(); handle = undefined;
        await fs.rename(temporary, file);
        const directory = await fs.open(path.dirname(file), "r");
        try { await directory.sync(); } finally { await directory.close(); }
    } finally { await handle?.close().catch(() => {}); await fs.rm(temporary, { force: true }).catch(() => {}); }
}
function capInNanoUsd(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > AI_SEARCH_HARD_CAP_USD || !Number.isSafeInteger(Math.floor(value * NANO_USD))) return fail("Paid AI needs an explicit per-search dollar cap between $0 and $0.02 before it can resume.");
    return Math.floor(value * NANO_USD);
}
function validateControl(value: any): Control {
    if (!value || value.version !== 1 || typeof value.paused !== "boolean" || !(value.perSearchCapUsd === null || typeof value.perSearchCapUsd === "number")) return fail("Paid AI is blocked because its spending control is invalid.");
    if (value.perSearchCapUsd !== null) capInNanoUsd(value.perSearchCapUsd);
    return value;
}
function validateLedger(value: any, id: string): Ledger {
    if (!UUID.test(id) || !value || value.version !== 1 || value.id !== id || !value.searches || typeof value.searches !== "object" || Array.isArray(value.searches)) return fail("Paid AI is blocked because its spending ledger is missing or invalid; it was not reset.");
    for (const [searchId, account] of Object.entries(value.searches) as [string, Account][]) {
        if (!UUID.test(searchId) || !account || !count(account.capNanoUsd) || !count(account.heldNanoUsd) || !Array.isArray(account.attempts)) return fail("Paid AI is blocked because a saved search budget is invalid.");
        let total = 0;
        const ids = new Set<string>();
        for (const attempt of account.attempts) {
            if (!attempt || !UUID.test(attempt.id) || typeof attempt.inputHash !== "string" || !Object.hasOwn(RATES, attempt.model) || !count(attempt.maxInputTokens) || !count(attempt.maxOutputTokens) || !count(attempt.reservedNanoUsd) || !count(attempt.heldNanoUsd) || !["RESERVED", "SETTLED"].includes(attempt.state)) return fail("Paid AI is blocked because a saved reservation is invalid.");
            const rates = RATES[attempt.model];
            if (ids.has(attempt.id) || attempt.reservedNanoUsd !== attempt.maxInputTokens * Math.max(rates.input, rates.write) + attempt.maxOutputTokens * rates.output ||
                attempt.state === "RESERVED" && attempt.heldNanoUsd < attempt.reservedNanoUsd || attempt.state === "SETTLED" && attempt.heldNanoUsd > attempt.reservedNanoUsd) return fail("Paid AI is blocked because a saved reservation no longer agrees with its original bound.");
            ids.add(attempt.id);
            total += attempt.heldNanoUsd;
        }
        if (!count(total) || total !== account.heldNanoUsd) return fail("Paid AI is blocked because its budget totals disagree; the ledger was kept.");
    }
    return value;
}

export function createAiSpendingGuard({ directory = DATA_DIR, preflight }: Options = {}) {
    const controlFile = path.join(directory, "ai-spending.json"), ledgerFile = path.join(directory, "ai-spending-ledger.json");
    const lockFile = path.join(directory, "ai-spending.lock");
    async function locked<T>(work: () => Promise<T>): Promise<T> {
        try { await fs.mkdir(directory, { recursive: true }); }
        catch (error) { return fail("Paid AI cannot access its spending directory.", error); }
        let lock;
        for (let attempt = 0; ; attempt++) {
            try { lock = await fs.open(lockFile, "wx"); break; }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") return fail("Paid AI cannot secure its spending ledger.", error);
                // Never steal a possibly-live lock. A crash while holding the
                // lock fails closed for inspection instead of resetting spend.
                if (attempt >= 80) return fail("Paid AI spending is locked or was interrupted. No paid request was sent; inspect the retained ledger and lock.");
                await delay(25);
            }
        }
        try { await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return await work(); }
        catch (error) { if ((error as Error)?.name === "AbortError") throw error; const failure = aiSpendingFailure(error); if (failure) throw failure; return fail("Paid AI could not durably update its spending ledger. No new work is authorized.", error); }
        finally {
            try { await lock.close(); await fs.rm(lockFile, { force: true }); }
            catch (error) { fail("Paid AI could not release its spending lock; no further dispatch is authorized.", error); }
        }
    }
    async function control(): Promise<Control | null> {
        const value = await readJson(controlFile); return value === null ? null : validateControl(value);
    }
    async function ledger(settings: Control): Promise<Ledger> {
        if (typeof settings.ledgerId !== "string" || !UUID.test(settings.ledgerId)) return fail("The AI spending guard needs its persistent ledger initialized before paid work can resume.");
        return validateLedger(await readJson(ledgerFile), settings.ledgerId);
    }
    return {
        async status() {
            const value = await control();
            if (!value && await readJson(ledgerFile) !== null) return { enabled: true, configured: false, paused: true, perSearchCapUsd: null,
                pauseReason: "The initialized AI spending control is missing; paid work remains blocked and its ledger was kept." };
            if (!value) return { enabled: true, configured: false, paused: true, perSearchCapUsd: AI_SEARCH_HARD_CAP_USD,
                pauseReason: "Paid AI is paused because its persistent spending guard is not configured. Cached results and screened candidates remain available." };
            return { enabled: true, configured: true, paused: value.paused, perSearchCapUsd: value.perSearchCapUsd, pauseReason: value.pauseReason ?? null };
        },
        async summary(searchId?: string) {
            if (searchId !== undefined && !UUID.test(searchId)) return fail("A valid search ID is required to read its spending summary.");
            const settings = await control();
            if (!settings) {
                if (await readJson(ledgerFile) !== null) return fail("The initialized AI spending control is missing; its ledger was kept.");
                return { configured: false, paused: true, searchId: searchId ?? null, capUsd: AI_SEARCH_HARD_CAP_USD,
                    committedUsd: 0, settledUsd: 0, heldUsd: 0, remainingUsd: searchId ? AI_SEARCH_HARD_CAP_USD : null, attempts: 0, unsettledAttempts: 0 };
            }
            const book = await ledger(settings);
            const accounts = searchId ? book.searches[searchId] ? [book.searches[searchId]] : [] : Object.values(book.searches);
            const attempts = accounts.flatMap(account => account.attempts);
            const committed = accounts.reduce((sum, account) => sum + account.heldNanoUsd, 0);
            const held = attempts.filter(attempt => attempt.state === "RESERVED").reduce((sum, attempt) => sum + attempt.heldNanoUsd, 0);
            const cap = settings.perSearchCapUsd === null ? null : Math.min(capInNanoUsd(settings.perSearchCapUsd), searchId && accounts[0] ? accounts[0].capNanoUsd : Infinity);
            return { configured: true, paused: settings.paused, searchId: searchId ?? null, capUsd: cap === null ? null : cap / NANO_USD,
                committedUsd: committed / NANO_USD, settledUsd: (committed - held) / NANO_USD, heldUsd: held / NANO_USD,
                remainingUsd: searchId && cap !== null ? Math.max(0, cap - committed) / NANO_USD : null,
                attempts: attempts.length, unsettledAttempts: attempts.filter(attempt => attempt.state === "RESERVED").length };
        },
        // Local/operator configuration only. HTTP requests cannot reset a search
        // or recreate a missing ledger. Production is initialized paused.
        async configure(update: { paused: boolean; perSearchCapUsd: number | null; pauseReason?: string }) {
            return locked(async () => {
                if (!update.paused || update.perSearchCapUsd !== null) capInNanoUsd(update.perSearchCapUsd);
                const old = await control();
                const stored = old?.ledgerId ? await ledger(old) : await readJson(ledgerFile);
                const book: Ledger = stored ? validateLedger(stored, stored.id) : { version: 1, id: randomUUID(), searches: {} };
                await durableJson(ledgerFile, book);
                await durableJson(controlFile, { version: 1, ...update, ledgerId: book.id });
            });
        },
        async reserve(body: any, context: AiUsageContext): Promise<AiReservation | null> {
            const signal = getAiDispatchSignal();
            signal?.throwIfAborted();
            const initial = await control();
            // A missing initialized control must not reset its ledger or spend.
            if (initial === null) {
                if (await readJson(ledgerFile) !== null) return fail("The initialized AI spending control is missing; paid work remains blocked.");
                throw new AiSpendingError("AI_PAUSED", "Paid AI is paused because its persistent spending guard is not configured. Cached results and screened candidates remain available.");
            }
            const validateRequest = (settings: Control, book: Ledger) => {
                if (settings.paused) throw new AiSpendingError("AI_PAUSED", settings.pauseReason ?? "Paid AI is paused locally. Saved results remain available.");
                const cap = capInNanoUsd(settings.perSearchCapUsd);
                if (!context.searchId || !UUID.test(context.searchId)) return fail("Paid AI needs a valid search ID so every request is charged to a capped search.");
                const account = book.searches[context.searchId] ?? { capNanoUsd: cap, heldNanoUsd: 0, attempts: [] };
                account.capNanoUsd = Math.min(account.capNanoUsd, cap);
                const rates = typeof body?.model === "string" && Object.hasOwn(RATES, body.model) ? RATES[body.model] : null;
                if (!rates || body.service_tier !== "default") return fail("Paid AI is blocked because the requested model or service tier has no verified spending bound.");
                if (!verifiedCacheOptions(body)) return fail("Paid AI requires verified 30-minute cache options with no legacy retention or policy overrides.");
                if (body.tools?.length || body.previous_response_id || body.conversation || body.stream || body.background) return fail("Paid AI cannot bound tool, conversation or streaming charges for this request.");
                if (!count(body.max_output_tokens) || body.max_output_tokens === 0) return fail("Paid AI needs a bounded maximum output before dispatch.");
                const minimum = body.max_output_tokens * rates.output;
                if (!count(minimum) || minimum > account.capNanoUsd - account.heldNanoUsd) return fail("This request's maximum output alone exceeds the search's remaining AI budget. No paid request was sent.");
                const immutableInput = typeof body.input === "string" || Array.isArray(body.input) && body.input.every((item: any) =>
                    item && (!item.type || item.type === "message") && Object.keys(item).every(key => ["type", "role", "content"].includes(key)) &&
                    (typeof item.content === "string" || Array.isArray(item.content) && item.content.every((part: any) =>
                        part?.type === "input_text" && typeof part.text === "string" && Object.keys(part).every(key => ["type", "text"].includes(key)) ||
                        part?.type === "input_image" && typeof part.image_url === "string" && part.image_url.startsWith("data:image/") && Object.keys(part).every(key => ["type", "image_url", "detail"].includes(key)))));
                if (!immutableInput) return fail("Paid AI cannot prove an input bound for mutable image URLs or unsupported input items. Exact immutable-input preflight is required.");
                return { account, rates, minimum };
            };
            // Validate cheap rejection rules before counting. The remote count
            // never holds the local spending lock; independent searches continue.
            validateRequest(initial, await ledger(initial));
            if (!preflight) return fail("Paid AI is blocked because an exact input-token preflight is not configured. Image URLs and text length are not a safe token bound.");
            const inputHash = aiInputHash(body);
            const proof = await preflight(body);
            signal?.throwIfAborted();
            if (proof.inputHash !== inputHash || aiInputHash(body) !== inputHash || !count(proof.inputTokens)) return fail("The exact AI input bound does not match this request. No paid request was sent.");
            if (proof.inputTokens > MAX_STANDARD_INPUT_TOKENS) return fail("This request crosses the verified standard-context price boundary.");
            return locked(async () => {
                signal?.throwIfAborted();
                const settings = await control();
                if (!settings) return fail("The active AI spending control disappeared; no paid request was sent.");
                if (settings.ledgerId !== initial.ledgerId || aiInputHash(body) !== inputHash) return fail("The AI request or spending ledger changed during input counting.");
                const book = await ledger(settings);
                // Re-read all concurrent reservations, lower caps and pauses.
                const { account, rates, minimum } = validateRequest(settings, book);
                const amount = proof.inputTokens * Math.max(rates.input, rates.write) + minimum;
                if (!count(amount) || amount > account.capNanoUsd - account.heldNanoUsd) return fail("This request would exceed the search's remaining AI budget. No paid request was sent.");
                const attempt: Attempt = { id: randomUUID(), inputHash, model: body.model, createdAt: new Date().toISOString(),
                    maxInputTokens: proof.inputTokens, maxOutputTokens: body.max_output_tokens, reservedNanoUsd: amount, heldNanoUsd: amount, state: "RESERVED" };
                account.heldNanoUsd += amount; account.attempts.push(attempt); book.searches[context.searchId!] = account;
                await durableJson(ledgerFile, book);
                const latest = await control();
                if (!latest || latest.paused) throw new AiSpendingError("AI_PAUSED", "Paid AI was paused before dispatch. The conservative reservation was retained.");
                if (capInNanoUsd(latest.perSearchCapUsd) < account.heldNanoUsd) return fail("The search cap was lowered before dispatch. Its conservative reservation was retained.");
                signal?.throwIfAborted();
                return { ledgerId: book.id, searchId: context.searchId!, attemptId: attempt.id };
            });
        },
        async settle(reservation: AiReservation | null, result: any) {
            if (!reservation) return;
            await locked(async () => {
                const settings = await control();
                if (!settings || settings.ledgerId !== reservation.ledgerId) return fail("The AI spending ledger changed after dispatch. Its reservation was retained.");
                const book = await ledger(settings), account = book.searches[reservation.searchId];
                const attempt = account?.attempts.find(item => item.id === reservation.attemptId);
                if (!attempt) return fail("The paid AI reservation is missing; inspect the retained spending ledger.");
                if (attempt.state === "SETTLED") return;
                const usage = result?.usage, details = usage?.input_tokens_details;
                // Incomplete/unknown billing never releases reserved funds.
                if (result?.model !== attempt.model || result?.service_tier !== "default" || !count(usage?.input_tokens) || !count(usage?.output_tokens) || !count(details?.cached_tokens) || !count(details?.cache_write_tokens)) return;
                const cached = details.cached_tokens, writes = details.cache_write_tokens;
                if (cached + writes > usage.input_tokens) return;
                if (writes && (details.cache_write_tokens_details?.ttl_30m_tokens !== writes || details.cache_write_tokens_details?.ttl_12h_tokens !== 0)) return;
                const rates = RATES[attempt.model];
                const actual = (usage.input_tokens - cached - writes) * rates.input + cached * rates.cached + writes * rates.write + usage.output_tokens * rates.output;
                if (!count(actual)) return;
                if (usage.input_tokens > attempt.maxInputTokens || usage.output_tokens > attempt.maxOutputTokens || actual > attempt.reservedNanoUsd) {
                    await durableJson(controlFile, { ...settings, paused: true, pauseReason: "Paid AI is paused because reported usage exceeded its verified reservation. Inspect the retained ledger before resuming." });
                    // Preserve a discrepancy even if the provider/preflight
                    // broke its bound; never conceal it by refunding the hold.
                    account.heldNanoUsd += Math.max(actual, attempt.heldNanoUsd) - attempt.heldNanoUsd;
                    attempt.heldNanoUsd = Math.max(actual, attempt.heldNanoUsd);
                    await durableJson(ledgerFile, book); return;
                }
                account.heldNanoUsd -= attempt.heldNanoUsd - actual;
                attempt.heldNanoUsd = actual; attempt.state = "SETTLED";
                await durableJson(ledgerFile, book);
            });
        },
    };
}
const productionPreflight = createAiInputPreflight({ checkAllowed: async () => {
    const current = await aiSpending.status();
    if (current.paused) throw new AiSpendingError("AI_PAUSED", current.pauseReason ?? "Paid AI remains paused.");
} });
export const aiSpending = createAiSpendingGuard({ preflight: productionPreflight });
