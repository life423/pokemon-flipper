import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DATA_DIR } from "../lib/paths.ts";
import { getSqlRepositories, storageBackend, StorageUnavailableError, localOwner, type TaskClaim, type TaskResult } from "../storage/index.ts";
import { AiSpendingError } from "./spending.ts";

interface DispatchRepository {
    claimTask(claim: TaskClaim): Promise<TaskResult & { claimed: boolean }>;
    readTask(key: string): Promise<TaskResult | null>;
    markTaskDispatched(key: string, owner: string): Promise<void>;
    completeTask(key: string, owner: string, result: unknown): Promise<void>;
    markTaskUnknown(key: string, owner: string): Promise<void>;
    releaseTask(key: string, owner: string): Promise<void>;
}
interface SavedResponse {
    version: 1; requestHash: string; status: number;
    headers: [string, string][]; body: string;
}
interface Recovery { key: string; owner: string; response: SavedResponse }
interface Options {
    enabled?: () => boolean;
    repository?: () => Promise<DispatchRepository>;
    recoveryDirectory?: string;
    scope?: () => string;
    pollMs?: number;
    waitMs?: number;
}
const SAFE_HEADERS = new Set(["content-type", "x-request-id", "openai-version", "openai-processing-ms"]);
function savedResponse(value: unknown, hash: string): SavedResponse {
    const entry = value as SavedResponse | null;
    if (!entry || entry.version !== 1 || entry.requestHash !== hash || !Number.isInteger(entry.status) || entry.status < 200 || entry.status >= 300 ||
        !Array.isArray(entry.headers) || entry.headers.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(item => typeof item !== "string") || !SAFE_HEADERS.has(pair[0])) || typeof entry.body !== "string") {
        throw new StorageUnavailableError("Saved AI response evidence is invalid. No replacement AI request was authorized.");
    }
    try { const result = JSON.parse(entry.body); if (!result || result.status !== "completed") throw new Error(); }
    catch (cause) { throw new StorageUnavailableError("Saved AI response evidence is unreadable. No replacement AI request was authorized.", { cause }); }
    return entry;
}
const replay = (entry: SavedResponse) => new Response(entry.body, { status: entry.status, headers: [...entry.headers, ["x-pokemon-flipper-reused", "true"]] });
const unknownOutcome = () => new AiSpendingError("AI_PAUSED", "A previous AI request for this evidence has an unresolved outcome. Its claim and spending hold were kept; no duplicate request was sent.");
async function saveRecovery(file: string, value: Recovery) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await fs.open(temporary, "wx", 0o600);
        await handle.writeFile(JSON.stringify(value), "utf8"); await handle.sync();
        await handle.close(); handle = undefined;
        await fs.rename(temporary, file);
        const directory = await fs.open(path.dirname(file), "r");
        try { await directory.sync(); } finally { await directory.close(); }
    } finally { await handle?.close().catch(() => {}); await fs.rm(temporary, { force: true }).catch(() => {}); }
}

// This coordinates identical dispatches across backend processes. It does not
// replace the spending guard. No SQL transaction stays open during AI work.
export function createSqlAiDispatch({ enabled = () => storageBackend() === "azure-sql", repository = getSqlRepositories,
    recoveryDirectory = path.join(DATA_DIR, "ai-response-recovery"), scope = localOwner, pollMs = 250, waitMs = 125_000 }: Options = {}) {
    return async function dispatch(body: unknown, send: (beforeSend: () => Promise<void>) => Promise<Response>, signal?: AbortSignal): Promise<Response> {
        signal?.throwIfAborted();
        if (!enabled()) return send(async () => {});
        const hash = createHash("sha256").update(JSON.stringify([scope(), body])).digest("hex");
        const key = `ai-dispatch:v1:${hash}`;
        const recoveryFile = path.join(recoveryDirectory, `${hash}.json`);
        const repos = await repository();
        // A paid response can survive a SQL outage locally. Reconciliation
        // saves that answer under its ORIGINAL claim, never buys a new one.
        let recovery: unknown;
        try { recovery = JSON.parse(await fs.readFile(recoveryFile, "utf8")); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new StorageUnavailableError("An accepted AI response recovery record could not be read. Its task was retained.", { cause }); }
        if (recovery !== undefined) {
            const record = recovery as Recovery | null;
            if (!record || record.key !== key || typeof record.owner !== "string") throw new StorageUnavailableError("An AI recovery record has an invalid task identity.");
            const accepted = savedResponse(record.response, hash);
            const existing = await repos.readTask(key);
            if (existing?.state === "COMPLETED") {
                const completed = savedResponse(existing.result, hash);
                if (completed.body !== accepted.body || completed.status !== accepted.status) throw new StorageUnavailableError("Accepted AI recovery evidence disagrees with the saved result. Both were kept for inspection.");
            } else await repos.completeTask(key, record.owner, accepted);
            await fs.rm(recoveryFile, { force: true });
        }
        const owner = randomUUID(), started = Date.now();
        const claimInput = { key, ownerId: owner, type: "AI_GENERATION", inputHash: hash, leaseMs: 120_000 };
        let claim = await repos.claimTask(claimInput);
        while (!claim.claimed) {
            signal?.throwIfAborted();
            if (claim.state === "COMPLETED") return replay(savedResponse(claim.result, hash));
            if (["UNKNOWN", "FAILED", "CANCELLED"].includes(claim.state)) throw unknownOutcome();
            if (Date.now() - started >= waitMs) throw new AiSpendingError("AI_PAUSED", "The same AI task is already running. No duplicate request was sent; its result will remain saved for reuse.");
            await delay(pollMs, undefined, { signal });
            const current = await repos.readTask(key);
            if (!current) throw new StorageUnavailableError("The shared AI task disappeared; no replacement request was authorized.");
            if (current.state === "PENDING" || current.state === "RUNNING" && Date.parse(current.leaseUntil ?? "") <= Date.now()) {
                claim = await repos.claimTask(claimInput);
            } else claim = { ...current, claimed: false };
        }
        let dispatched = false;
        try {
            signal?.throwIfAborted();
            const response = await send(async () => {
                signal?.throwIfAborted();
                await repos.markTaskDispatched(key, owner);
                dispatched = true;
                signal?.throwIfAborted();
            });
            const text = await response.clone().text();
            let result: { status?: string } | null = null;
            try { result = JSON.parse(text); } catch {}
            if (!response.ok || result?.status !== "completed") {
                await repos.markTaskUnknown(key, owner);
                return response;
            }
            const accepted: SavedResponse = { version: 1, requestHash: hash, status: response.status,
                headers: [...response.headers.entries()].filter(([name]) => SAFE_HEADERS.has(name)), body: text };
            // Save a durable recovery copy before acknowledging SQL completion.
            let recoverySaved = false;
            try { await saveRecovery(recoveryFile, { key, owner, response: accepted }); recoverySaved = true; }
            catch { /* SQL can still durably accept the answer if local disk is unavailable. */ }
            try { await repos.completeTask(key, owner, accepted); if (recoverySaved) await fs.rm(recoveryFile, { force: true }); }
            catch {
                console.error(recoverySaved ? "An accepted AI answer is saved locally for SQL recovery; its shared claim remains held."
                    : "An accepted AI answer could not be checkpointed. Its shared claim remains held and the answer is returned to its caller.");
            }
            return response;
        } catch (error) {
            if (dispatched) await repos.markTaskUnknown(key, owner).catch(() => {});
            else await repos.releaseTask(key, owner).catch(() => {});
            throw error;
        }
    };
}
export const sqlAiDispatch = createSqlAiDispatch();
