import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { DATA_DIR } from "../lib/paths.ts";
import type { DealHuntAction } from "../../shared/deal-hunt.ts";

export class FlipRunConflict extends Error {}
export interface FlipTask<T> {
    round?: number;
    done: DealHuntAction[];
    next: DealHuntAction[];
    evidence: T;
}

export interface FlipJournal<W, R, T> {
    checkpoint: W | null; previous: R | null;
    savePage(state: W): Promise<void>;
    task(key: string): { receipt: FlipTask<T> | null; inFlight: DealHuntAction | null } | null;
    start(key: string, action: DealHuntAction): Promise<void>;
    accept(key: string, receipt: FlipTask<T>): Promise<void>;
    finish(state: W, result: R, pending?: string[]): Promise<void>;
}

// The installation owns this journal alongside its spending accounts. Each write commits
// before dispatch or after acceptance. No SQLite transaction spans a provider request.
export async function withFlipRun<W, R, T>(file: string, leg: string, owner: string, criteria: string, signal: AbortSignal,
    work: (journal: FlipJournal<W, R, T>) => Promise<R>): Promise<R> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file), token = randomUUID();
    const write = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args);
    // Retry contention asynchronously rather than pinning the HTTP event loop in sqlite.
    async function retry<V>(operation: () => V) {
        const deadline = Date.now() + 5000;
        for (;;) {
            try { return operation(); } catch (error) {
                if (Date.now() >= deadline || ![5, 6].includes((error as { errcode?: number }).errcode ?? 0)) throw error;
                await delay(20);
            }
        }
    }
    function atomic<V>(operation: () => V) {
        db.exec("BEGIN IMMEDIATE");
        try { const result = operation(); db.exec("COMMIT"); return result; }
        catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    let claimed = false;
    try {
        await retry(() => db.exec(`PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS runs (leg TEXT PRIMARY KEY, owner TEXT NOT NULL, criteria TEXT NOT NULL,
                pid INTEGER, token TEXT, checkpoint TEXT, result TEXT);
            CREATE TABLE IF NOT EXISTS tasks (leg TEXT NOT NULL, copy TEXT NOT NULL, action TEXT, receipt TEXT, PRIMARY KEY(leg,copy));`));
        const prior = await retry(() => atomic(() => {
            signal.throwIfAborted();
            write("INSERT OR IGNORE INTO runs (leg, owner, criteria) VALUES (?,?,?)", leg, owner, criteria);
            const row = db.prepare("SELECT * FROM runs WHERE leg=?").get(leg)!;
            if (row.owner !== owner || row.criteria !== criteria) throw new FlipRunConflict("This search belongs to different settings, shipping destination or spending account.");
            if (row.pid !== null) {
                try { process.kill(Number(row.pid), 0); throw new FlipRunConflict("This search is already running."); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            }
            write("UPDATE runs SET pid=?,token=? WHERE leg=?", process.pid, token, leg);
            return { checkpoint: row.checkpoint ? JSON.parse(String(row.checkpoint)) as W : null,
                previous: row.result ? JSON.parse(String(row.result)) as R : null };
        }));
        claimed = true;
        return await work({ ...prior,
            savePage: async state => { await retry(() => write("UPDATE runs SET checkpoint=? WHERE leg=?", JSON.stringify(state), leg)); },
            task(key) {
                const entry = db.prepare("SELECT receipt, action FROM tasks WHERE leg=? AND copy=?").get(leg, key);
                return entry ? { receipt: entry.receipt ? JSON.parse(String(entry.receipt)) as FlipTask<T> : null,
                    inFlight: entry.action as DealHuntAction | null } : null;
            },
            start: async (key, action) => { await retry(() => write(`INSERT INTO tasks(leg,copy,action) VALUES (?,?,?)
                ON CONFLICT (leg,copy) DO UPDATE SET action=excluded.action`, leg, key, action)); },
            accept: async (key, receipt) => { await retry(() => write("UPDATE tasks SET receipt=?,action=NULL WHERE leg=? AND copy=?", JSON.stringify(receipt), leg, key)); },
            finish: async (state, result, pending = []) => { await retry(() => atomic(() => {
                write("UPDATE runs SET checkpoint=?,result=? WHERE leg=?", JSON.stringify(state), JSON.stringify(result), leg);
                // Keep interrupted dispatches held across inventory passes.
                write("DELETE FROM tasks WHERE leg=? AND action IS NULL AND substr(copy,1,instr(copy,':') - 1) NOT IN (SELECT value FROM json_each(?))", leg, JSON.stringify(pending));
            })); },
        });
    } finally {
        try { if (claimed) await retry(() => write("UPDATE runs SET pid=NULL,token=NULL WHERE leg=? AND token=?", leg, token)); }
        finally { db.close(); }
    }
}
export const flipRunFile = path.join(DATA_DIR, "flip-runs.sqlite");

export async function savedFlipOwner(leg: string, file = flipRunFile): Promise<string | null> {
    try { await fs.access(file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runs'").get()) return null;
        const row = db.prepare("SELECT owner FROM runs WHERE leg=?").get(leg);
        return row ? String(row.owner) : null;
    } finally { db.close(); }
}
