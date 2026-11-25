import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../lib/paths.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { storageBackend, StorageUnavailableError } from "../storage/index.ts";

let opening: Promise<DatabaseSync> | undefined;
function database() {
    return opening ??= (async () => {
        await fs.mkdir(DATA_DIR, { recursive: true });
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(path.join(DATA_DIR, "market-data.sqlite"));
        try {
            db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY, fetched INTEGER NOT NULL, body TEXT NOT NULL)");
            return db;
        } catch (error) { db.close(); throw error; }
    })().catch(error => { opening = undefined; throw error; });
}

export function marketDataPath(path: string) {
    return /^\/cards\/\d+\/(sales\/volume|prices\/history)\?/.test(path);
}
export async function readMarketData(key: string, hours: number) {
    if (storageBackend() === "azure-sql") return readCache(key, hours);
    try {
        const db = await database();
        const row = db.prepare("SELECT body FROM responses WHERE key=? AND fetched BETWEEN ? AND ?").get(key, Date.now() - hours * 3600000, Date.now());
        return row ? JSON.parse(String(row.body)) : null;
    } catch (cause) { throw new StorageUnavailableError("Market history could not be read.", { cause }); }
}
export async function saveMarketData(key: string, body: unknown) {
    if (storageBackend() === "azure-sql") return writeCache(key, body);
    try {
        const db = await database();
        db.prepare("INSERT INTO responses VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET fetched=excluded.fetched, body=excluded.body").run(key, Date.now(), JSON.stringify(body));
    } catch (cause) { throw new StorageUnavailableError("Market history could not be saved.", { cause }); }
}
