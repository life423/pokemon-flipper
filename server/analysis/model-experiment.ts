import { createHash } from "node:crypto";
import { runStructured, type Photo } from "../ai/openai.ts";
import { BOUNDED_MAX_OUTPUT_TOKENS } from "../ai/policy.ts";
import { getAiUsageContext, withAiUsageContext } from "../ai/usage-context.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { StorageUnavailableError } from "../storage/index.ts";
import type { Usage } from "./types.ts";

// Diagnostic evidence stays separate from accepted production assessments.
export interface ExperimentRequest {
    step: string;
    prompt: string;
    instructions?: string;
    photos: Photo[];
    schemaName: string;
    schema: Record<string, unknown>;
    maxOutputTokens?: number;
}
interface ExperimentInput {
    sourceKey: string;
    model: string;
    request: ExperimentRequest;
}
export interface ModelExperimentOptions<T> extends ExperimentInput {
    validate(value: unknown): T;
    signal?: AbortSignal;
}
interface AcceptedExperiment {
    version: 1;
    key: string;
    model: string;
    answeredAt: string;
    result: unknown;
    usage: Usage;
}
type RunRequest = ExperimentRequest & { model: string; bounded: true; maxRetries: 0; dispatchSignal: AbortSignal };
interface Dependencies {
    run(request: RunRequest): Promise<{ result: unknown; usage: Usage }>;
    cached(key: string, maxAgeHours: number): Promise<unknown | null>;
    save(key: string, value: unknown): Promise<void>;
    now(): number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const count = (value: unknown) => value === null || Number.isSafeInteger(value) && (value as number) >= 0;
function invalid(cause?: unknown): never {
    throw new StorageUnavailableError("Saved model-experiment evidence is invalid. It was preserved; no replacement request is authorized.", { cause });
}
function normalizedRequest(request: ExperimentRequest): ExperimentRequest & { maxOutputTokens: number } {
    const maximum = request.maxOutputTokens ?? BOUNDED_MAX_OUTPUT_TOKENS;
    if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new RangeError("An experiment needs a positive integer output limit.");
    // A mutable CDN URL is not evidence of the bytes examined. Freeze source
    // images before constructing an experiment so its key covers actual pixels.
    if (request.photos.some(photo => !photo.url.startsWith("data:image/"))) throw new Error("Model experiments require saved inline image bytes, not remote photo URLs.");
    return { step: request.step, prompt: request.prompt, ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
        photos: request.photos.map(photo => ({ url: photo.url, ...(photo.label === undefined ? {} : { label: photo.label }) })),
        schemaName: request.schemaName, schema: structuredClone(request.schema), maxOutputTokens: Math.min(maximum, BOUNDED_MAX_OUTPUT_TOKENS) };
}
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
    return value;
}
export function modelExperimentKey({ sourceKey, model, request }: ExperimentInput): string {
    if (!sourceKey.trim() || !model.trim()) throw new Error("A model experiment needs its source evidence key and exact model.");
    const input = { sourceKey, model, request: normalizedRequest(request) };
    return `analysis-experiment:v1:${createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex")}`;
}
function acceptedRecord(value: unknown, key: string, model: string, now: number): AcceptedExperiment {
    const saved = value as Partial<AcceptedExperiment> | null;
    if (!saved || typeof saved !== "object" || Array.isArray(saved) || saved.version !== 1 || saved.key !== key || saved.model !== model ||
        typeof saved.answeredAt !== "string" || !Number.isFinite(Date.parse(saved.answeredAt)) || Date.parse(saved.answeredAt) > now ||
        !Object.hasOwn(saved, "result") || !saved.usage || !count(saved.usage.inputTokens) || !count(saved.usage.outputTokens)) return invalid();
    return structuredClone(saved as AcceptedExperiment);
}

export function createModelExperimentRunner(overrides: Partial<Dependencies> = {}) {
    const deps: Dependencies = { run: request => runStructured<unknown>(request), cached: readCache, save: writeCache, now: Date.now, ...overrides };
    const share = createSharedWork();
    return async function experiment<T>({ sourceKey, model, request, validate, signal }: ModelExperimentOptions<T>): Promise<{
        result: T; usage: Usage; reused: boolean; answeredAt: string; key: string;
    }> {
        signal?.throwIfAborted();
        const snapshot = normalizedRequest(request), key = modelExperimentKey({ sourceKey, model, request: snapshot });
        const context = { ...getAiUsageContext() };
        const answer = await share(JSON.stringify([context.searchId ?? null, key]), workSignal => withAiUsageContext(context, async () => {
            workSignal.throwIfAborted();
            const previous = await deps.cached(key, Infinity);
            workSignal.throwIfAborted();
            if (previous !== null) return { record: acceptedRecord(previous, key, model, deps.now()), reused: true };
            if (!context.searchId || !UUID.test(context.searchId)) throw new Error("A model experiment needs the original capped search ID before new work can start.");
            // Dispatch-only cancellation permits a paid answer already accepted
            // by the provider to finish saving. Never pass a response-abort signal.
            const accepted = await deps.run({ ...snapshot, model, bounded: true, maxRetries: 0, dispatchSignal: workSignal });
            const record: AcceptedExperiment = { version: 1, key, model, answeredAt: new Date(deps.now()).toISOString(),
                result: structuredClone(accepted.result), usage: structuredClone(accepted.usage) };
            // Save even an invalid accepted answer: reopening must not buy it again.
            await deps.save(key, record);
            return { record: acceptedRecord(record, key, model, deps.now()), reused: false };
        }), signal);
        signal?.throwIfAborted();
        let result: T;
        try { result = validate(structuredClone(answer.record.result)); }
        catch (cause) { return invalid(cause); }
        return { result, usage: structuredClone(answer.record.usage), reused: answer.reused, answeredAt: answer.record.answeredAt, key };
    };
}
