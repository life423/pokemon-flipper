import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./paths.ts";
import { writeJsonAtomic } from "./atomic-json.ts";
import { storageBackend, readCacheEntry, writeCacheEntry, StorageUnavailableError } from "../storage/index.ts";

// Saved API responses and AI readings, so the same lookup isn't paid for
// (or rate-limited) twice. Each caller picks how long its answers last.
const CACHE_DIR = path.join(DATA_DIR, "price-cache");

interface CacheEntry { key: string; savedAt: string; data: unknown }
interface CacheOptions {
    directory?: string;
    backend?: () => "file" | "azure-sql";
    sql?: { readCacheEntry(key: string): Promise<CacheEntry | null>; writeCacheEntry(entry: CacheEntry): Promise<void> };
    now?: () => number;
}

// A confirmed missing/expired entry may need provider work. An unavailable or
// corrupt store must propagate instead of disguising itself as that cache miss.
export function createCacheStore({ directory = CACHE_DIR, backend = storageBackend,
    sql = { readCacheEntry, writeCacheEntry }, now = () => Date.now() }: CacheOptions = {}) {
    function cacheFile(key: string): string {
        const name = createHash("sha1").update(key).digest("hex");
        return path.join(directory, `${name}.json`);
    }

    return {
        async read<T = any>(key: string, maxAgeHours: number): Promise<T | null> {
            let saved: unknown;
            const selected = backend();
            if (selected === "azure-sql") saved = await sql.readCacheEntry(key);
            else {
                try { saved = JSON.parse(await fs.readFile(cacheFile(key), "utf8")); }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                    throw new StorageUnavailableError("Saved API or AI evidence could not be read. No replacement provider request is authorized.", { cause: error });
                }
            }
            if (saved === null && selected === "azure-sql") return null;
            const entry = saved as Partial<CacheEntry> | undefined;
            // Old cache wrappers may omit key. An explicit wrong key or invalid
            // timestamp is damaged accounting, not permission to buy new work.
            if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
                entry.key !== undefined && entry.key !== key || typeof entry.savedAt !== "string" ||
                !Number.isFinite(Date.parse(entry.savedAt)) || !Object.hasOwn(entry, "data")) {
                throw new StorageUnavailableError("Saved API or AI evidence is invalid. Its original record was kept; no replacement provider request is authorized.");
            }
            const ageHours = (now() - Date.parse(entry.savedAt)) / 3600000;
            return ageHours >= 0 && ageHours < maxAgeHours ? entry.data as T : null;
        },
        async write(key: string, data: unknown): Promise<void> {
            const entry = { key, savedAt: new Date(now()).toISOString(), data };
            if (backend() === "azure-sql") await sql.writeCacheEntry(entry);
            else await writeJsonAtomic(cacheFile(key), entry);
        },
    };
}

const cache = createCacheStore();

// T is what was saved; the caller knows its shape.
export async function readCache<T = any>(key: string, maxAgeHours: number): Promise<T | null> {
    return cache.read<T>(key, maxAgeHours);
}

export async function writeCache(key: string, data: unknown): Promise<void> {
    await cache.write(key, data);
}
