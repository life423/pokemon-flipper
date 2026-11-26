import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "../lib/paths.ts";
import { aiSpending } from "./spending.ts";
import { getBudgetContext, getAiDispatchSignal, type AiUsageContext } from "./usage-context.ts";
import type { AiUsageDay, AiUsageStage } from "../../shared/ai-usage.ts";
import { sqlAiDispatch } from "./sql-dispatch.ts";
import { requireLiveProvider } from "../lib/saved-provider-evidence.ts";

export interface AiAttempt extends AiUsageContext {
    at: string;
    step: string;
    model: string;
    requestedModel: string;
    images: number;
    status: number | null;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number | null;
    cacheWrite30mTokens: number | null;
    cacheWrite12hTokens: number | null;
    reasoningOutputTokens: number | null;
    usageReported: boolean;
    inputHash: string | null;
    responseId: string | null;
    requestId: string | null;
    serviceTier: string | null;
    responseStatus: string | null;
    hasRefusal: boolean;
}

const file = () => path.join(DATA_DIR, "ai-usage", `${new Date(Date.now()).toISOString().slice(0, 10)}.ndjson`);
const text = (value: unknown): string | null => typeof value === "string" ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

async function save(attempt: AiAttempt) {
    try {
        const destination = file();
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.appendFile(destination, JSON.stringify(attempt) + "\n");
    } catch {
        console.error("AI usage could not be recorded; provider result is unchanged.");
    }
}

function usageFields(result: any) {
    const usage = result?.usage;
    const details = usage?.input_tokens_details;
    const writes = count(details?.cache_write_tokens);
    return {
        inputTokens: count(usage?.input_tokens) ?? 0,
        outputTokens: count(usage?.output_tokens) ?? 0,
        cachedInputTokens: count(details?.cached_tokens) ?? 0,
        cacheWriteTokens: writes,
        cacheWrite30mTokens: count(details?.cache_write_tokens_details?.ttl_30m_tokens) ?? (writes === 0 ? 0 : null),
        cacheWrite12hTokens: count(details?.cache_write_tokens_details?.ttl_12h_tokens) ?? (writes === 0 ? 0 : null),
        reasoningOutputTokens: count(usage?.output_tokens_details?.reasoning_tokens),
        usageReported: count(usage?.input_tokens) !== null && count(usage?.output_tokens) !== null,
    };
}

// Each SDK transport attempt is logged separately. The request fingerprint is
// irreversible; prompts, image URLs, seller text and authorization stay out.
export const trackedAiFetch: typeof fetch = async (input, init) => {
    const started = Date.now();
    const rawBody = typeof init?.body === "string" ? init.body : null;
    let body: any;
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = {}; }
    const images = Array.isArray(body?.input) ? body.input.flatMap((part: any) => Array.isArray(part?.content) ? part.content : []).filter((part: any) => part?.type === "input_image").length : 0;
    const base = {
        ...getBudgetContext(),
        at: new Date(started).toISOString(),
        step: text(body?.metadata?.app_step) ?? text(body?.text?.format?.name) ?? "unknown",
        model: text(body?.model) ?? "unknown",
        requestedModel: text(body?.model) ?? "unknown",
        images,
        inputHash: rawBody === null ? null : createHash("sha256").update(rawBody).digest("hex"),
    };
    // This is the final outbound boundary, including SDK retries. A denied
    // local request must never reach the provider or appear as paid usage.
    const dispatchSignal = getAiDispatchSignal();
    dispatchSignal?.throwIfAborted();
    requireLiveProvider("OPENAI");
    let reservation: Awaited<ReturnType<typeof aiSpending.reserve>> = null;
    return sqlAiDispatch(body, async beforeSend => {
        reservation = await aiSpending.reserve(body, getBudgetContext());
        // Stop may arrive while waiting for the spending lock/preflight/fsync.
        // Keep the conservative reservation, but never send a cancelled request.
        dispatchSignal?.throwIfAborted();
        await beforeSend();
        dispatchSignal?.throwIfAborted();
        try { return await globalThis.fetch(input, init); }
        catch (error) {
            await save({ ...base, ...usageFields(null), status: null, durationMs: Date.now() - started,
                responseId: null, requestId: null, serviceTier: null, responseStatus: null, hasRefusal: false });
            throw error;
        }
    }, dispatchSignal, async (response, result) => {
        // A failed/unknown reconciliation keeps its full conservative reservation.
        // The accepted provider answer remains available for normal checkpoints.
        await aiSpending.settle(reservation, result).catch(() => console.error("AI spending reconciliation could not finish; its reservation was retained."));
        const hasRefusal = Array.isArray(result?.output) && result.output.some((part: any) =>
            Array.isArray(part?.content) && part.content.some((item: any) => item?.type === "refusal"));
        await save({
            ...base, ...usageFields(result), model: text(result?.model) ?? base.model,
            status: response.status, durationMs: Date.now() - started,
            responseId: text(result?.id), requestId: response.headers.get("x-request-id"),
            serviceTier: text(result?.service_tier), responseStatus: text(result?.status), hasRefusal,
        });
    });
};

function addReported(total: number | null | undefined, value: unknown): number | null {
    const reported = count(value);
    return total === null || reported === null ? null : (total ?? 0) + reported;
}

function addAttempt(stages: Map<string, AiUsageStage>, row: Partial<AiAttempt>) {
    const step = text(row.step) ?? "unknown", model = text(row.model) ?? "unknown", serviceTier = text(row.serviceTier);
    const key = JSON.stringify([step, model, serviceTier]);
    const stage = stages.get(key) ?? { step, model, serviceTier, calls: 0, failed: 0, images: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
        cacheWriteTokens: 0, cacheWrite30mTokens: 0, cacheWrite12hTokens: 0, reasoningOutputTokens: 0, unreportedUsageCalls: 0, unreportedCacheWriteCalls: 0 };
    stage.calls++;
    if (row.status === null || (row.status ?? 0) >= 400 || ["incomplete", "failed", "cancelled"].includes(row.responseStatus ?? "") || row.hasRefusal) stage.failed++;
    stage.images += count(row.images) ?? 0;
    stage.inputTokens += count(row.inputTokens) ?? 0;
    stage.outputTokens += count(row.outputTokens) ?? 0;
    stage.cachedInputTokens += count(row.cachedInputTokens) ?? 0;
    stage.cacheWriteTokens = addReported(stage.cacheWriteTokens, row.cacheWriteTokens);
    stage.cacheWrite30mTokens = addReported(stage.cacheWrite30mTokens, row.cacheWrite30mTokens);
    stage.cacheWrite12hTokens = addReported(stage.cacheWrite12hTokens, row.cacheWrite12hTokens);
    stage.reasoningOutputTokens = addReported(stage.reasoningOutputTokens, row.reasoningOutputTokens);
    const legacyReported = row.status !== null && (row.status ?? 500) < 400 && count(row.inputTokens) !== null && count(row.outputTokens) !== null;
    if (!(row.usageReported ?? legacyReported)) stage.unreportedUsageCalls!++;
    if (count(row.cacheWriteTokens) === null) stage.unreportedCacheWriteCalls!++;
    stages.set(key, stage);
}

function parseAttempt(line: string): Partial<AiAttempt> | null {
    try {
        const row = JSON.parse(line);
        return row && typeof row.step === "string" && typeof row.model === "string" ? row : null;
    } catch { return null; }
}

function emptyUsage() {
    return { stages: new Map<string, AiUsageStage>(), searches: new Map<string, Map<string, AiUsageStage>>(), unattributed: 0 };
}

// The NDJSON log is append-only. This index is disposable and never authorizes spending.
let index = { ...emptyUsage(), path: "", identity: "", offset: 0, size: 0, modified: 0, tail: "" };
let refreshing: Promise<void> | undefined;

async function refreshUsage(destination: string) {
    let handle;
    try {
        handle = await fs.open(destination, "r");
        const stat = await handle.stat();
        const identity = [stat.dev, stat.ino, stat.birthtimeMs].join("/");
        if (index.path !== destination || index.identity !== identity || stat.size < index.size ||
            stat.size === index.size && stat.mtimeMs !== index.modified) {
            index = { ...emptyUsage(), path: destination, identity, offset: 0, size: 0, modified: 0, tail: "" };
        }
        if (stat.size === index.size) return;
        // Index only newline-terminated records. A legacy final line is overlaid on
        // snapshots until completed, so a concurrent partial append cannot be counted twice.
        let cursor = index.offset, carry = Buffer.alloc(0);
        const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, stat.size - cursor));
        while (cursor < stat.size) {
            const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - cursor), cursor);
            if (!bytesRead) throw new Error("The AI usage log changed during a read.");
            cursor += bytesRead;
            const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
            const last = data.lastIndexOf(10);
            if (last >= 0) {
                for (const line of data.toString("utf8", 0, last).split("\n")) {
                    const row = parseAttempt(line);
                    if (!row) continue;
                    addAttempt(index.stages, row);
                    if (typeof row.searchId === "string" && row.searchId) {
                        let stages = index.searches.get(row.searchId);
                        if (!stages) { stages = new Map(); index.searches.set(row.searchId, stages); }
                        addAttempt(stages, row);
                    } else index.unattributed++;
                }
            }
            carry = Buffer.from(data.subarray(last + 1));
            index.offset = cursor - carry.length;
        }
        index.tail = carry.toString("utf8");
        index.size = stat.size;
        index.modified = stat.mtimeMs;
    } catch (error) {
        index.path = "";
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        index = { ...emptyUsage(), path: destination, identity: "", offset: 0, size: 0, modified: 0, tail: "" };
    } finally { await handle?.close(); }
}

export async function aiUsageToday(searchId?: string): Promise<AiUsageDay> {
    const destination = file();
    do {
        refreshing ??= refreshUsage(destination).finally(() => { refreshing = undefined; });
        await refreshing;
    } while (index.path !== destination);
    const stages = new Map(Array.from(searchId === undefined ? index.stages : index.searches.get(searchId) ?? [],
        ([key, stage]) => [key, { ...stage }]));
    let unattributedCalls = searchId === undefined ? index.unattributed : 0;
    const tail = index.tail && parseAttempt(index.tail);
    if (tail && (searchId === undefined || tail.searchId === searchId)) {
        addAttempt(stages, tail);
        if (!tail.searchId) unattributedCalls++;
    }
    return { dayUtc: path.basename(destination, ".ndjson"), ...(searchId === undefined ? {} : { searchId }), unattributedCalls,
        calls: [...stages.values()].reduce((sum, stage) => sum + stage.calls, 0), stages: [...stages.values()] };
}
