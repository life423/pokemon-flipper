import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "../lib/paths.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { getSqlRepositories, storageBackend, StorageUnavailableError } from "../storage/index.ts";

// A busy SQLite connection, including its lock timeout, runs off the HTTP event loop.
let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();

function marketRequest(request: { key: string; now: number; since?: number; body?: unknown; once?: boolean }): Promise<any> {
    if (!worker) {
        const started = new Worker(new URL("./market-cache-worker.mjs", import.meta.url),
            { workerData: path.join(DATA_DIR, "market-data.sqlite"), execArgv: [] });
        worker = started;
        const stopped = (cause: Error) => {
            if (worker !== started) return;
            worker = undefined;
            for (const task of pending.values()) task.reject(cause);
            pending.clear();
        };
        started.on("error", stopped);
        started.on("exit", code => stopped(new Error("Market cache worker exited (" + code + ").")));
        started.on("message", ({ id, value, error }) => {
            const task = pending.get(id);
            pending.delete(id);
            if (error) task?.reject(new Error(error)); else task?.resolve(value);
            if (!pending.size) started.unref();
        });
    }
    const active = worker;
    const id = ++sequence;
    return new Promise((resolve, reject) => {
        active.ref();
        pending.set(id, { resolve, reject });
        try { active.postMessage({ ...request, id }); }
        catch (error) { pending.delete(id); if (!pending.size) active.unref(); reject(error); }
    });
}

export function marketDataPath(path: string) {
    return /^\/cards\/\d+\/(sales\/volume|prices\/history)\?/.test(path);
}
export async function readMarketData(key: string, hours: number) {
    if (storageBackend() === "azure-sql") return readCache(key, hours);
    try {
        const now = Date.now();
        return await marketRequest({ key, now, since: now - hours * 3600000 });
    } catch (cause) { throw new StorageUnavailableError("Market history could not be read.", { cause }); }
}
export async function saveMarketData(key: string, body: unknown) {
    if (storageBackend() === "azure-sql") return writeCache(key, body);
    try {
        await marketRequest({ key, now: Date.now(), body });
    } catch (cause) { throw new StorageUnavailableError("Market history could not be saved.", { cause }); }
}

// Consume the day's request before dispatch, including across restarts or two app instances.
export async function reserveMarketImport(key: string): Promise<boolean> {
    const now = Date.now();
    if (storageBackend() === "azure-sql") {
        const repo = await getSqlRepositories();
        const ownerId = randomUUID();
        const claim = await repo.claimTask({ key, type: "MARKET_IMPORT_RESERVATION", inputHash: createHash("sha256").update(key).digest("hex"), ownerId });
        if (!claim.claimed) return false;
        await repo.completeTask(key, ownerId, { at: now });
        return true;
    }
    return marketRequest({ key, now, body: { at: now }, once: true });
}
