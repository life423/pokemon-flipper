import { parentPort, workerData } from "node:worker_threads";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

mkdirSync(dirname(workerData), { recursive: true });
const db = new DatabaseSync(workerData);
db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY, fetched INTEGER NOT NULL, body TEXT NOT NULL)");
const read = db.prepare("SELECT body FROM responses WHERE key=? AND fetched BETWEEN ? AND ?");
const write = db.prepare("INSERT INTO responses VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET fetched=excluded.fetched, body=excluded.body");
parentPort.on("message", ({ id, key, now, since, body }) => {
    try {
        if (since !== undefined) {
            const row = read.get(key, since, now);
            parentPort.postMessage({ id, value: row ? JSON.parse(row.body) : null });
        } else {
            write.run(key, now, JSON.stringify(body));
            parentPort.postMessage({ id });
        }
    } catch (err) { parentPort.postMessage({ id, error: err.message }); }
});
parentPort.on("close", () => db.close());
