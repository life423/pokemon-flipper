import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "../lib/paths.ts";
import { aiSpending } from "./spending.ts";
import { getAiUsageContext, getAiDispatchSignal, type AiUsageContext } from "./usage-context.ts";
import type { AiUsageDay, AiUsageStage } from "../../shared/ai-usage.ts";
import { sqlAiDispatch } from "./sql-dispatch.ts";

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
        ...getAiUsageContext(),
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
    return sqlAiDispatch(body, async beforeSend => {
        const reservation = await aiSpending.reserve(body, getAiUsageContext());
        // Stop may arrive while waiting for the spending lock/preflight/fsync.
        // Keep the conservative reservation, but never send a cancelled request.
        dispatchSignal?.throwIfAborted();
        await beforeSend();
        dispatchSignal?.throwIfAborted();
        let response: Response;
        try { response = await globalThis.fetch(input, init); }
        catch (error) {
            await save({ ...base, ...usageFields(null), status: null, durationMs: Date.now() - started,
                responseId: null, requestId: null, serviceTier: null, responseStatus: null, hasRefusal: false });
            throw error;
        }
        const result: any = await response.clone().json().catch(() => null);
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
        return response;
    }, dispatchSignal);
};

function addReported(total: number | null | undefined, value: unknown): number | null {
    const reported = count(value);
    return total === null || reported === null ? null : (total ?? 0) + reported;
}

export async function aiUsageToday(searchId?: string): Promise<AiUsageDay> {
    let lines: string;
    try { lines = await fs.readFile(file(), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") lines = ""; else throw error; }
    const stages = new Map<string, AiUsageStage>();
    let unattributedCalls = 0;
    for (const line of lines.split("\n").filter(Boolean)) {
        let row: Partial<AiAttempt>;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.step !== "string" || typeof row.model !== "string") continue;
        if (searchId !== undefined && row.searchId !== searchId) continue;
        if (!row.searchId) unattributedCalls++;
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
    return { dayUtc: new Date(Date.now()).toISOString().slice(0, 10), ...(searchId === undefined ? {} : { searchId }), unattributedCalls,
        calls: [...stages.values()].reduce((sum, stage) => sum + stage.calls, 0), stages: [...stages.values()] };
}
