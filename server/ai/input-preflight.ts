import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../lib/paths.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { assertSqlStorageReady, StorageUnavailableError } from "../storage/index.ts";
import { getAiDispatchSignal, getAiUsageContext, type AiUsageContext } from "./usage-context.ts";

export interface AiInputProof { inputHash: string; inputTokens: number }
export const aiInputHash = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");
export class InputPreflightError extends Error {
    readonly code = "AI_BUDGET";
}
interface CountEvent extends AiUsageContext { at: string; inputHash: string; model: string; status: number | null; inputTokens: number | null; durationMs: number }
interface Options {
    fetch?: typeof fetch;
    read?: (key: string) => Promise<unknown>;
    write?: (key: string, proof: AiInputProof) => Promise<void>;
    checkAllowed?: () => Promise<void>;
    ready?: () => Promise<void>;
    signal?: () => AbortSignal | undefined;
    record?: (event: CountEvent) => Promise<void>;
}
const INTEGER = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const COUNT_FIELDS = ["model", "input", "instructions", "parallel_tool_calls", "personality", "reasoning", "text", "tools", "tool_choice", "truncation"] as const;
const GENERATION_FIELDS = new Set([...COUNT_FIELDS, "max_output_tokens", "metadata", "service_tier", "prompt_cache_options", "store", "tools", "tool_choice", "previous_response_id", "conversation", "stream", "background"]);
const INLINE_IMAGE = /^data:image\/(?:jpeg|png|webp|gif);base64,[a-z0-9+/]+={0,2}$/i;
const fail = (message: string): never => { throw new InputPreflightError(`${message} No paid AI generation was authorized.`); };

// GPT-5.6 cache writes are priced by the documented TTL. Reject legacy
// retention fields, longer TTLs and unverified breakpoint/policy overrides.
export function verifiedCacheOptions(body: any): boolean {
    const options = body?.prompt_cache_options;
    return Boolean(body && !Object.hasOwn(body, "prompt_cache_retention") && options && typeof options === "object" && !Array.isArray(options) &&
        ["explicit", "implicit"].includes(options.mode) && options.ttl === "30m" && Object.keys(options).length === 2 &&
        Object.keys(options).every(key => key === "mode" || key === "ttl"));
}

// URLs and file IDs can change between counting and generation. The provider
// counts the exact text, instructions, schema and inline image bytes instead.
function countPayload(body: any): Record<string, unknown> {
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.model !== "string" || !verifiedCacheOptions(body) ||
        Object.keys(body).some(key => !GENERATION_FIELDS.has(key)) || body.tools?.length || body.tool_choice && body.tool_choice !== "none" ||
        body.previous_response_id || body.conversation || body.stream || body.background || body.truncation && body.truncation !== "disabled") {
        return fail("The AI request contains unsupported counting or mutable-context fields.");
    }
    let encodedBytes = 0;
    const input = body.input;
    const immutable = typeof input === "string" || Array.isArray(input) && input.every((item: any) => {
        if (!item || item.type && item.type !== "message" || item.role && !["user", "developer", "system"].includes(item.role) ||
            Object.keys(item).some(key => !["type", "role", "content"].includes(key))) return false;
        if (typeof item.content === "string") return true;
        return Array.isArray(item.content) && item.content.every((part: any) => {
            if (part?.type === "input_text") return typeof part.text === "string" && Object.keys(part).every(key => ["type", "text"].includes(key));
            if (part?.type !== "input_image" || typeof part.image_url !== "string" || !INLINE_IMAGE.test(part.image_url) ||
                Object.keys(part).some(key => !["type", "image_url", "detail"].includes(key)) || part.detail && !["auto", "low", "high", "original"].includes(part.detail)) return false;
            encodedBytes += part.image_url.length;
            return encodedBytes <= 32 * 1024 * 1024;
        });
    });
    if (!immutable) return fail("Exact AI counting requires supported text and immutable inline listing images.");
    return Object.fromEntries(COUNT_FIELDS.filter(key => body[key] !== undefined).map(key => [key, body[key]]));
}
async function recordCount(event: CountEvent) {
    const file = path.join(DATA_DIR, "ai-input-preflight", `${event.at.slice(0, 10)}.ndjson`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(event) + "\n");
}

export function createAiInputPreflight({ fetch: request = (...args) => globalThis.fetch(...args),
    read = key => readCache(key, 24), write = writeCache, checkAllowed = async () => {}, ready = assertSqlStorageReady,
    signal = getAiDispatchSignal, record = recordCount }: Options = {}) {
    const share = createSharedWork();
    return async (body: unknown): Promise<AiInputProof> => {
        const waiting = signal();
        waiting?.throwIfAborted();
        await checkAllowed();
        const inputHash = aiInputHash(body);
        const payload = countPayload(body);
        // Copy before awaiting: a mutable caller cannot change the bytes counted.
        const serialized = JSON.stringify(payload);
        const model = String(payload.model);
        const proof = await share(inputHash, async active => {
            active.throwIfAborted();
            const key = `ai:input-token-proof:v1:${inputHash}`;
            const saved = await read(key);
            if (saved !== null) {
                const cached = saved as AiInputProof;
                if (!cached || cached.inputHash !== inputHash || !INTEGER(cached.inputTokens)) return fail("The saved exact AI token proof is invalid; its evidence was retained.");
                return cached;
            }
            await ready();
            await checkAllowed();
            active.throwIfAborted();
            const apiKey = process.env.OPENAI_API_KEY?.trim();
            if (!apiKey) return fail("An OpenAI API key is required for exact input counting.");
            const started = Date.now();
            let status: number | null = null, inputTokens: number | null = null;
            try {
                // This transport can call only the non-generating count endpoint.
                // It never enters the generation wrapper and has no retry loop.
                const response = await request("https://api.openai.com/v1/responses/input_tokens", {
                    method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
                    body: serialized, signal: AbortSignal.any([active, AbortSignal.timeout(15_000)]),
                });
                status = response.status;
                if (!response.ok) return fail(`Exact AI input counting was unavailable (${response.status}).`);
                const result: any = await response.json();
                if (result?.object !== "response.input_tokens" || !INTEGER(result.input_tokens)) return fail("Exact AI input counting returned an invalid proof.");
                inputTokens = result.input_tokens;
                const accepted: AiInputProof = { inputHash, inputTokens: result.input_tokens };
                // Accepted count results remain reusable even if their consumer
                // stopped; the spending guard checks cancellation before dispatch.
                try { await write(key, accepted); }
                catch (cause) { throw new StorageUnavailableError("The exact AI input count could not be saved. No paid AI generation was authorized.", { cause }); }
                return accepted;
            } catch (error) {
                if (active.aborted) throw active.reason;
                if (error instanceof InputPreflightError || error instanceof StorageUnavailableError) throw error;
                return fail("Exact AI input counting could not finish.");
            } finally {
                try { await record({ ...getAiUsageContext(), at: new Date(started).toISOString(), inputHash, model, status, inputTokens, durationMs: Date.now() - started }); }
                catch (cause) { throw new StorageUnavailableError("The exact AI counting audit could not be saved. No paid AI generation was authorized.", { cause }); }
            }
        }, waiting);
        waiting?.throwIfAborted();
        await checkAllowed();
        if (aiInputHash(body) !== inputHash) return fail("The AI request changed after exact input counting.");
        return proof;
    };
}
