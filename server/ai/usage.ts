import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../lib/paths.ts";

export interface AiAttempt { at: string; step: string; model: string; images: number; status: number | null; durationMs: number; inputTokens: number; outputTokens: number; cachedInputTokens: number }
const file = () => path.join(DATA_DIR, "ai-usage", `${new Date(Date.now()).toISOString().slice(0, 10)}.ndjson`);
async function save(attempt: AiAttempt) {
    try { const destination = file(); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.appendFile(destination, JSON.stringify(attempt) + "\n"); }
    catch { console.error("AI usage could not be recorded; provider result is unchanged."); }
}
// SDK retries pass through this transport individually. Logs contain counts and
// stage/model names only, never prompts, images, keys or seller text.
export const trackedAiFetch: typeof fetch = async (input, init) => {
    const started = Date.now(); let body: any;
    try { body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; } catch { body = {}; }
    const base = { at: new Date(started).toISOString(), step: body.metadata?.app_step ?? body.text?.format?.name ?? "unknown", model: body.model ?? "unknown",
        images: (body.input ?? []).flatMap((part: any) => part.content ?? []).filter((part: any) => part.type === "input_image").length };
    let response: Response;
    try { response = await globalThis.fetch(input, init); }
    catch (error) { await save({ ...base, status: null, durationMs: Date.now() - started, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }); throw error; }
    const result = await response.clone().json().catch(() => null);
    await save({ ...base, status: response.status, durationMs: Date.now() - started, inputTokens: result?.usage?.input_tokens ?? 0,
        outputTokens: result?.usage?.output_tokens ?? 0, cachedInputTokens: result?.usage?.input_tokens_details?.cached_tokens ?? 0 });
    return response;
};

export async function aiUsageToday() {
    let lines: string;
    try { lines = await fs.readFile(file(), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") lines = ""; else throw error; }
    const stages = new Map<string, { step: string; model: string; calls: number; failed: number; images: number; inputTokens: number; outputTokens: number; cachedInputTokens: number }>();
    for (const line of lines.split("\n").filter(Boolean)) {
        let row: AiAttempt; try { row = JSON.parse(line); } catch { continue; }
        const key = `${row.step}:${row.model}`;
        const stage = stages.get(key) ?? { step: row.step, model: row.model, calls: 0, failed: 0, images: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
        stage.calls++; if (row.status === null || row.status >= 400) stage.failed++;
        stage.images += row.images; stage.inputTokens += row.inputTokens; stage.outputTokens += row.outputTokens; stage.cachedInputTokens += row.cachedInputTokens;
        stages.set(key, stage);
    }
    return { dayUtc: new Date(Date.now()).toISOString().slice(0, 10), calls: [...stages.values()].reduce((sum, stage) => sum + stage.calls, 0), stages: [...stages.values()] };
}
