import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./paths.ts";
import { writeJsonAtomic } from "./atomic-json.ts";
import { storageBackend, readCacheEntry, readCacheEntries, writeCacheEntry, StorageUnavailableError } from "../storage/index.ts";

// Saved API responses and AI readings, so the same lookup isn't paid for
// (or rate-limited) twice. Each caller picks how long its answers last.
const CACHE_DIR = path.join(DATA_DIR, "price-cache");

interface CacheEntry { key: string; savedAt: string; data: unknown }
interface CacheOptions {
    directory?: string;
    backend?: () => "file" | "azure-sql";
    sql?: { readCacheEntry(key: string): Promise<CacheEntry | null>; readCacheEntries?(keys: string[]): Promise<CacheEntry[]>; writeCacheEntry(entry: CacheEntry): Promise<void> };
    now?: () => number;
}

// A confirmed missing/expired entry may need provider work. An unavailable or
// corrupt store must propagate instead of disguising itself as that cache miss.
export function createCacheStore({ directory = CACHE_DIR, backend = storageBackend,
    sql = { readCacheEntry, readCacheEntries, writeCacheEntry }, now = () => Date.now() }: CacheOptions = {}) {
    function cacheFile(key: string): string {
        const name = createHash("sha1").update(key).digest("hex");
        return path.join(directory, `${name}.json`);
    }

    function value<T>(saved: unknown, key: string, maxAgeHours: number): T | null {
        const entry = saved as Partial<CacheEntry> | undefined;
        if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
            entry.key !== undefined && entry.key !== key || typeof entry.savedAt !== "string" ||
            !Number.isFinite(Date.parse(entry.savedAt)) || !Object.hasOwn(entry, "data")) {
            throw new StorageUnavailableError("Saved API or AI evidence is invalid. Its original record was kept; no replacement provider request is authorized.");
        }
        const ageHours = (now() - Date.parse(entry.savedAt)) / 3600000;
        return ageHours >= 0 && ageHours < maxAgeHours ? entry.data as T : null;
    }

    async function sqlBatch(keys: string[]): Promise<(CacheEntry | null)[]> {
        const unique = [...new Set(keys)];
        const entries = await sql.readCacheEntries!(unique);
        const byKey = new Map<string, CacheEntry>();
        for (const entry of entries) {
            if (!entry || !unique.includes(entry.key) || byKey.has(entry.key))
                throw new StorageUnavailableError("The saved cache batch has an invalid identity. No replacement provider request was authorized.");
            byKey.set(entry.key, entry);
        }
        return keys.map(key => byKey.get(key) ?? null);
    }

    const pendingReads: { key: string; resolve(value: CacheEntry | null): void; reject(error: unknown): void }[] = [];
    let scheduled = false;
    async function flushReads() {
        scheduled = false;
        const pending = pendingReads.splice(0, 500);
        try {
            const entries = await sqlBatch(pending.map(read => read.key));
            pending.forEach((read, index) => read.resolve(entries[index]));
        } catch (error) { pending.forEach(read => read.reject(error)); }
        if (pendingReads.length && !scheduled) { scheduled = true; queueMicrotask(() => void flushReads()); }
    }
    function sqlRead(key: string): Promise<CacheEntry | null> {
        if (!sql.readCacheEntries) return sql.readCacheEntry(key);
        // Concurrent saved-evidence lookups share one SQL request. No persistent
        // memo is kept, so later price corrections and writes remain visible.
        return new Promise((resolve, reject) => {
            pendingReads.push({ key, resolve, reject });
            if (!scheduled) { scheduled = true; queueMicrotask(() => void flushReads()); }
        });
    }

    const store = {
        async read<T = any>(key: string, maxAgeHours: number): Promise<T | null> {
            let saved: unknown;
            const selected = backend();
            if (selected === "azure-sql") saved = await sqlRead(key);
            else {
                try { saved = JSON.parse(await fs.readFile(cacheFile(key), "utf8")); }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                    throw new StorageUnavailableError("Saved API or AI evidence could not be read. No replacement provider request is authorized.", { cause: error });
                }
            }
            if (saved === null && selected === "azure-sql") return null;
            return value<T>(selected === "azure-sql" ? structuredClone(saved) : saved, key, maxAgeHours);
        },
        async readMany<T = any>(keys: string[], maxAgeHours: number): Promise<(T | null)[]> {
            if (!keys.length) return [];
            if (backend() !== "azure-sql" || !sql.readCacheEntries) return Promise.all(keys.map(key => store.read<T>(key, maxAgeHours)));
            const entries = await sqlBatch(keys);
            return entries.map((entry, index) => entry === null ? null : structuredClone(value<T>(entry, keys[index], maxAgeHours)));
        },
        async write(key: string, data: unknown): Promise<void> {
            const entry = { key, savedAt: new Date(now()).toISOString(), data };
            if (backend() === "azure-sql") await sql.writeCacheEntry(entry);
            else await writeJsonAtomic(cacheFile(key), entry);
        },
    };
    return store;
}

const cache = createCacheStore();

// T is what was saved; the caller knows its shape.
export async function readCache<T = any>(key: string, maxAgeHours: number): Promise<T | null> {
    return cache.read<T>(key, maxAgeHours);
}

export async function readCacheMany<T = any>(keys: string[], maxAgeHours: number): Promise<(T | null)[]> {
    return cache.readMany<T>(keys, maxAgeHours);
}

export async function writeCache(key: string, data: unknown): Promise<void> {
    await cache.write(key, data);
}
