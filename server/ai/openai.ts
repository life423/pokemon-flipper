import OpenAI from "openai";
import { setTimeout as delay } from "node:timers/promises";
import type { Usage } from "../analysis/types.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { ProviderError } from "../lib/http.ts";
import { aiPolicy, TEXT_MODEL, AI_REQUEST_CONCURRENCY, BOUNDED_VISION_MODEL, BOUNDED_MAX_OUTPUT_TOKENS } from "./policy.ts";
import { trackedAiFetch } from "./usage.ts";
import { canRetryImageDownload, inlineEbayImage } from "./image-fallback.ts";
import { createAiCreditGate } from "./errors.ts";
import { aiSpendingFailure } from "./spending.ts";
import { withAiDispatchSignal } from "./usage-context.ts";
import { storageFailure } from "../lib/storage-failure.ts";

// A photo to send, with an optional label for the view it shows.
export interface Photo {
    url: string;
    label?: string;
}

export const MODEL = TEXT_MODEL;

let client: OpenAI | null = null;
// Shared across searches, photo analysis, title batches, and comp checks.
const limitRequests = createLimiter(AI_REQUEST_CONCURRENCY);
let coolingUntil = 0;
const creditGate = createAiCreditGate();

// Created on first use, so the server still starts (and listings
// still load) when OPENAI_API_KEY is missing.
function getClient(): OpenAI {
    client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: "https://api.openai.com/v1", timeout: 90_000, maxRetries: 0, fetch: trackedAiFetch });
    return client;
}

// Each photo is preceded by a numbered label so the model can
// refer to photos by number.
function photoInputs(photos: Photo[]) {
    return photos.flatMap((photo, index) => [
        {
            type: "input_text" as const,
            text: photo.label
                ? `Photo ${index + 1} (${photo.label}):`
                : `Photo ${index + 1}:`,
        },
        { type: "input_image" as const, image_url: photo.url, detail: "high" as const },
    ]);
}

// Structured output is only trusted when the response finished
// normally and the model didn't refuse.
function readStructuredOutput(response: OpenAI.Responses.Response, step: string): unknown {
    if (response.status === "incomplete") {
        throw new Error(
            `${step}: response was cut off (${response.incomplete_details?.reason ?? "unknown reason"})`
        );
    }

    const refusal = (response.output ?? [])
        .flatMap((item) => (item as { content?: { type: string; refusal?: string }[] }).content ?? [])
        .find((part) => part.type === "refusal");

    if (refusal) {
        throw new Error(`${step}: model refused (${refusal.refusal})`);
    }

    return JSON.parse(response.output_text);
}

function readUsage(response: OpenAI.Responses.Response): Usage {
    return {
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
    };
}

export async function runStructured<T>({
    step,
    prompt,
    instructions,
    photos,
    schemaName,
    schema,
    signal,
    dispatchSignal,
    maxRetries,
    maxOutputTokens,
    bounded = false,
}: {
    step: string;
    prompt: string;
    instructions?: string;
    photos: Photo[];
    schemaName: string;
    schema: Record<string, unknown>;
    signal?: AbortSignal;
    // Cancel queued dispatch/retries while allowing an accepted paid answer to finish.
    dispatchSignal?: AbortSignal;
    maxRetries?: number;
    maxOutputTokens?: number;
    // One compact immutable assessment for the two-cent development workflow.
    bounded?: boolean;
}): Promise<{ result: T; usage: Usage }> {
    const waitingSignal = signal && dispatchSignal ? AbortSignal.any([signal, dispatchSignal]) : signal ?? dispatchSignal;
    waitingSignal?.throwIfAborted();
    const response = await limitRequests(async () => {
        waitingSignal?.throwIfAborted();
        creditGate.check();
        // A provider cooldown defers queued work; it must not turn the entire
        // waiting queue into failed reviews when concurrency is high.
        while (Date.now() < coolingUntil) { creditGate.check(); await delay(Math.min(30_000, coolingUntil - Date.now()), undefined, { signal: waitingSignal }); }
        creditGate.check();
        const deadline = AbortSignal.timeout(120_000);
        const policy = bounded ? { model: BOUNDED_VISION_MODEL, maxOutputTokens: BOUNDED_MAX_OUTPUT_TOKENS, effort: "none" as const,
            supportsReasoning: /^(?:gpt-[56](?:[.-]|$)|o\d)/.test(BOUNDED_VISION_MODEL) } : aiPolicy(schemaName);
        const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const immutablePhotos: Photo[] = [];
        if (bounded) {
            let bytes = 0;
            for (const photo of photos) {
                waitingSignal?.throwIfAborted();
                const url = photo.url.startsWith("data:image/") ? photo.url : await inlineEbayImage(photo.url,
                    waitingSignal ? AbortSignal.any([requestSignal, waitingSignal]) : requestSignal);
                bytes += url.length;
                if (bytes > 32 * 1024 * 1024) throw new Error("The selected photos exceed the bounded assessment input limit.");
                immutablePhotos.push({ ...photo, url });
            }
        }
        const sendOnce = (images: Photo[]) => withAiDispatchSignal(waitingSignal, () => getClient().responses.create({
            model: policy.model,
            service_tier: "default",
            // GPT-5.6+ uses the current TTL API. Explicit mode avoids paying
            // cache-write charges for unique listing images without breakpoints.
            ...{ prompt_cache_options: { mode: "explicit", ttl: "30m" } as const },
            store: false,
            ...(instructions ? { instructions } : {}),
            max_output_tokens: bounded ? Math.min(maxOutputTokens ?? policy.maxOutputTokens, BOUNDED_MAX_OUTPUT_TOKENS) : maxOutputTokens ?? policy.maxOutputTokens,
            ...(policy.supportsReasoning ? { reasoning: { effort: policy.effort } } : {}),
            metadata: { app_step: step },
            input: [{ role: "user" as const, content: [{ type: "input_text" as const, text: prompt }, ...photoInputs(images)] }],
            text: { format: { type: "json_schema" as const, name: schemaName, strict: true, schema } },
        }, { signal: requestSignal, maxRetries: 0 }));
        const send = async (images: Photo[], retries = bounded ? 0 : maxRetries ?? 1) => {
            for (let attempt = 0; ; attempt++) {
                waitingSignal?.throwIfAborted();
                creditGate.check();
                try { return await sendOnce(images); }
                catch (error) {
                    const storage = storageFailure(error);
                    if (storage) throw storage;
                    const spending = aiSpendingFailure(error);
                    if (spending) throw spending;
                    creditGate.reject(error);
                    const transient = error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.APIError &&
                        (error.status === 429 || error.status === 408 || error.status >= 500);
                    if (!transient || attempt >= retries) throw error;
                    const seconds = error instanceof OpenAI.APIError ? Number(error.headers?.get("retry-after")) : 0;
                    const pause = error instanceof OpenAI.APIError && error.status === 429 ? seconds > 0 ? seconds * 1000 : 30_000 : 1500;
                    if (error instanceof OpenAI.APIError && error.status === 429) coolingUntil = Math.max(coolingUntil, Date.now() + pause);
                    await delay(pause, undefined, { signal: dispatchSignal ? AbortSignal.any([requestSignal, dispatchSignal]) : requestSignal });
                }
            }
        };
        try {
            try { return await send(bounded ? immutablePhotos : photos); }
            catch (error) {
                waitingSignal?.throwIfAborted();
                if (bounded || !photos.length || !canRetryImageDownload(error)) throw error;
                const inline: Photo[] = [];
                // Download sequentially and cap the aggregate encoded input.
                let bytes = 0;
                for (const photo of photos) {
                    waitingSignal?.throwIfAborted();
                    const url = await inlineEbayImage(photo.url, requestSignal);
                    bytes += url.length;
                    if (bytes > 32 * 1024 * 1024) throw new Error("The listing photos exceed the AI fallback size limit.");
                    inline.push({ ...photo, url });
                }
                return await send(inline, 0);
            }
        } catch (error) {
            waitingSignal?.throwIfAborted();
            creditGate.reject(error);
            if (deadline.aborted) throw new ProviderError(`${step} timed out after two minutes. Please retry later.`, { cause: error });
            if (error instanceof OpenAI.APIError && error.status === 429) {
                const retrySeconds = Number(error.headers?.get("retry-after"));
                coolingUntil = Math.max(coolingUntil, Date.now() + (retrySeconds > 0 ? retrySeconds * 1000 : 30_000));
                throw new ProviderError("AI service is rate limited. Please retry this listing later.", { cause: error, retryAfterMs: coolingUntil - Date.now() });
            }
            throw error;
        }
    });

    return {
        result: readStructuredOutput(response, step) as T,
        usage: readUsage(response),
    };
}
