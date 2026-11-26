import { PRICE_SEARCH_MODEL, priceSearchTools } from "./web-search-policy.ts";
import OpenAI from "openai";
import { setTimeout as delay } from "node:timers/promises";
import type { Usage } from "../analysis/types.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { ProviderError } from "../lib/http.ts";
import { aiPolicy, TEXT_MODEL, AI_REQUEST_CONCURRENCY, BOUNDED_VISION_MODEL, BOUNDED_MAX_OUTPUT_TOKENS } from "./policy.ts";
import { trackedAiFetch } from "./usage.ts";
import { inlineEbayImage } from "./image-input.ts";
import { aiRateLimitDelayMs, createAiCreditGate } from "./errors.ts";
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
// Shared across searches, photo analysis, and comp checks.
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

export class MalformedStructuredOutputError extends SyntaxError {
    constructor(step: string, readonly usage: Usage, cause: unknown) {
        super(`${step}: the completed response did not contain one valid JSON value.`, { cause });
        this.name = "MalformedStructuredOutputError";
    }
}

export class StructuredOutputLimitError extends Error {
    constructor(step: string, readonly usage: Usage) {
        super(`${step}: response was cut off (max_output_tokens)`);
        this.name = "StructuredOutputLimitError";
    }
}

// Structured output is only trusted when the response finished
// normally and the model didn't refuse.
function readStructuredOutput(response: OpenAI.Responses.Response, step: string): unknown {
    const refusal = (response.output ?? [])
        .flatMap((item) => (item as { content?: { type: string; refusal?: string }[] }).content ?? [])
        .find((part) => part.type === "refusal");

    if (response.status === "incomplete") {
        if (response.incomplete_details?.reason === "max_output_tokens" && !refusal) {
            throw new StructuredOutputLimitError(step, readUsage(response));
        }
        throw new Error(
            `${step}: response was cut off (${response.incomplete_details?.reason ?? "unknown reason"})`
        );
    }
    if (response.status !== "completed") {
        throw new Error(`${step}: response did not complete (${response.status ?? "unknown status"})`);
    }

    if (refusal) {
        throw new Error(`${step}: model refused (${refusal.refusal})`);
    }

    try {
        return JSON.parse(response.output_text);
    } catch (error) {
        if (error instanceof SyntaxError) throw new MalformedStructuredOutputError(step, readUsage(response), error);
        throw error;
    }
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
    webPriceSearch = false,
    model: explicitModel,
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
    // One compact immutable assessment for the bounded search workflow.
    bounded?: boolean;
    webPriceSearch?: boolean | "catalog";
    // Explicit bounded comparisons/refinements can select a verified model.
    // Normal callers keep their configured policy; the spending guard still
    // requires exact model rates, immutable input and the original search cap.
    model?: string;
}): Promise<{ result: T; usage: Usage; sourceUrls?: string[] }> {
    if (webPriceSearch && (!bounded || explicitModel !== PRICE_SEARCH_MODEL || photos.length)) throw new Error("Web price research requires its bounded text-only request.");
    if (explicitModel !== undefined && !bounded) throw new Error("An explicit model is supported only for bounded research.");
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
        const selectedModel = explicitModel ?? BOUNDED_VISION_MODEL;
        const policy = bounded ? { model: selectedModel, maxOutputTokens: BOUNDED_MAX_OUTPUT_TOKENS, effort: "none" as const,
            supportsReasoning: /^(?:gpt-[56](?:[.-]|$)|o\d)/.test(selectedModel) } : aiPolicy(schemaName);
        const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const immutablePhotos: Photo[] = [];
        const downloadSignal = waitingSignal ? AbortSignal.any([requestSignal, waitingSignal]) : requestSignal;
        // Preflight and generation must see the same image bytes.
        let encodedLength = 0;
        for (const photo of photos) {
            downloadSignal.throwIfAborted();
            const url = photo.url.startsWith("data:image/") ? photo.url : await inlineEbayImage(photo.url, downloadSignal);
            encodedLength += url.length;
            if (encodedLength > 32 * 1024 * 1024) throw new Error("The selected photos exceed the assessment input limit.");
            immutablePhotos.push({ ...photo, url });
        }
        const sendOnce = () => withAiDispatchSignal(waitingSignal, () => getClient().responses.create({
            model: policy.model,
            service_tier: "default",
            // GPT-5.6+ uses the current TTL API. Explicit mode avoids paying
            // cache-write charges for unique listing images without breakpoints.
            ...{ prompt_cache_options: { mode: "explicit", ttl: "30m" } as const },
            store: false,
            ...(instructions ? { instructions } : {}),
            max_output_tokens: bounded ? Math.min(maxOutputTokens ?? policy.maxOutputTokens, BOUNDED_MAX_OUTPUT_TOKENS) : maxOutputTokens ?? policy.maxOutputTokens,
            ...(policy.supportsReasoning ? { reasoning: { effort: webPriceSearch ? "low" : policy.effort } } : {}),
            ...(webPriceSearch ? priceSearchTools(webPriceSearch === "catalog") : {}),
            metadata: { app_step: step },
            input: [{ role: "user" as const, content: [{ type: "input_text" as const, text: prompt }, ...photoInputs(immutablePhotos)] }],
            text: { format: { type: "json_schema" as const, name: schemaName, strict: true, schema } },
        }, { signal: requestSignal, maxRetries: 0 }));
        const send = async () => {
            const retries = bounded ? 0 : maxRetries ?? 1;
            for (let attempt = 0; ; attempt++) {
                waitingSignal?.throwIfAborted();
                creditGate.check();
                try { return await sendOnce(); }
                catch (error) {
                    const storage = storageFailure(error);
                    if (storage) throw storage;
                    const spending = aiSpendingFailure(error);
                    if (spending) throw spending;
                    creditGate.reject(error);
                    const transient = error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.APIError &&
                        (error.status === 429 || error.status === 408 || error.status >= 500);
                    if (!transient || attempt >= retries) throw error;
                    const pause = error instanceof OpenAI.APIError && error.status === 429 ? aiRateLimitDelayMs(error.headers) : 1500;
                    if (error instanceof OpenAI.APIError && error.status === 429) coolingUntil = Math.max(coolingUntil, Date.now() + pause);
                    await delay(pause, undefined, { signal: dispatchSignal ? AbortSignal.any([requestSignal, dispatchSignal]) : requestSignal });
                }
            }
        };
        try {
            return await send();
        } catch (error) {
            waitingSignal?.throwIfAborted();
            creditGate.reject(error);
            if (deadline.aborted) throw new ProviderError(`${step} timed out after two minutes. Please retry later.`, { cause: error });
            if (error instanceof OpenAI.APIError && error.status === 429) {
                coolingUntil = Math.max(coolingUntil, Date.now() + aiRateLimitDelayMs(error.headers));
                throw new ProviderError("AI service is rate limited. Please retry this listing later.", { cause: error, retryAfterMs: coolingUntil - Date.now() });
            }
            throw error;
        }
    });

    return {
        result: readStructuredOutput(response, step) as T,
        ...(webPriceSearch ? { sourceUrls: webSearchSources(response.output) } : {}),
        usage: readUsage(response),
    };
}

// URLs invented in generated JSON cannot enter the evidence list. The hosted
// tool supplies the consulted URLs and the API annotates citations separately.
export function webSearchSources(output: OpenAI.Responses.Response["output"]): string[] {
    const calls = output.filter(item => item.type === "web_search_call");
    if (calls.length !== 1 || calls[0].status !== "completed") throw new Error("OpenAI did not complete the required price search.");
    const urls = new Set<string>();
    for (const item of output) {
        if (item.type === "web_search_call" && item.action.type === "search") {
            for (const source of item.action.sources ?? []) if (source.type === "url") urls.add(source.url);
        }
        if (item.type === "message") for (const part of item.content) {
            if (part.type === "output_text") for (const citation of part.annotations) if (citation.type === "url_citation") urls.add(citation.url);
        }
    }
    return [...urls];
}
