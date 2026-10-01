import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../lib/paths.ts";

// Saved API responses, so the same lookup isn't paid for twice in a day.
const CACHE_DIR = path.join(DATA_DIR, "price-cache");

function cacheFile(key: string): string {
    const name = createHash("sha1").update(key).digest("hex");
    return path.join(CACHE_DIR, `${name}.json`);
}

// T is what was saved; the caller knows its shape.
export async function readCache<T = any>(key: string, maxAgeHours: number): Promise<T | null> {
    try {
        const saved = JSON.parse(await fs.readFile(cacheFile(key), "utf8"));
        const ageHours = (Date.now() - Date.parse(saved.savedAt)) / 3600000;
        return ageHours < maxAgeHours ? saved.data : null;
    } catch {
        return null;
    }
}

export async function writeCache(key: string, data: unknown): Promise<void> {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(
        cacheFile(key),
        JSON.stringify({ key, savedAt: new Date().toISOString(), data })
    );
}
