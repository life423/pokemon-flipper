import type { HuntProgress } from "../../shared/ai-usage.ts";
import type { DealHuntAction } from "../../shared/deal-hunt.ts";
import { DEVELOPMENT_SEARCH_LIMIT } from "../../shared/research-policy.ts";

const ACTIVE_TTL_MS = 30 * 60_000;
const FINISHED_TTL_MS = 5 * 60_000;
const MAX_RECORDS = 128;
type TerminalPhase = "completed" | "stopped" | "failed";
type ActivePhase = Exclude<HuntProgress["phase"], TerminalPhase>;

export interface HuntProgressObserver {
    stage(phase: ActivePhase, cohort?: string, action?: HuntProgress["action"]): void;
    guidance?(reason: string): void;
    source(discovered: number, screened: number, scans?: number, queuedInLastQuery?: number): void;
    retain(count: number): void;
    checked(listingId: string, action: DealHuntAction): void;
    candidates?(rows: NonNullable<HuntProgress["candidates"]>): void;
}

export function createHuntProgressStore(now = Date.now) {
    const records = new Map<string, HuntProgress>();
    const keyOf = (budgetSearchId: string, searchId: string) => `${budgetSearchId}:${searchId}`;
    const expired = (record: HuntProgress) => now() - Date.parse(record.updatedAt) > (record.completedAt ? FINISHED_TTL_MS : ACTIVE_TTL_MS);

    function read(budgetSearchId: string | undefined, searchId = budgetSearchId): HuntProgress | undefined {
        if (!budgetSearchId || !searchId) return;
        const key = keyOf(budgetSearchId, searchId);
        const record = records.get(key);
        if (!record) return;
        if (expired(record)) { records.delete(key); return; }
        return structuredClone(record);
    }

    async function observe<T>(budgetSearchId: string, searchId: string, signal: AbortSignal, work: (progress: HuntProgressObserver) => Promise<T>): Promise<T> {
        signal.throwIfAborted();
        const key = keyOf(budgetSearchId, searchId);
        for (const [id, record] of records) if (expired(record)) records.delete(id);
        records.delete(key);
        if (records.size >= MAX_RECORDS) records.delete(records.keys().next().value!);
        const startedAt = new Date(now()).toISOString();
        const record: HuntProgress = { searchId, phase: "planning", startedAt, updatedAt: startedAt,
            discovered: 0, screened: 0, retained: 0, reviewed: 0, photos: 0, scans: 0 };
        records.set(key, record);
        const checked = new Set<string>();
        const photoChecks = new Set<string>();
        const update = (change: Partial<HuntProgress>) => {
            if (!record.completedAt && records.get(key) === record) Object.assign(record, change, { updatedAt: new Date(now()).toISOString() });
        };
        const finish = (phase: TerminalPhase) => update({ phase, completedAt: new Date(now()).toISOString(), cohort: undefined, action: undefined });
        const stop = () => finish("stopped");
        // The shared hunt stops when the final subscriber leaves. Later paid
        // saves can finish without changing the terminal progress snapshot.
        signal.addEventListener("abort", stop, { once: true });
        try {
            const result = await work({
                guidance: reason => update({ guidance: reason.slice(0, 240) }),
                stage: (phase, cohort, action) => update({ phase, cohort: cohort?.replace(/\s+/g, " ").trim().slice(0, 140), action,
                    ...(phase === "planning" && { guidance: undefined }) }),
                source: (discovered, screened, scans = 0, queuedInLastQuery) => update({
                    ...(queuedInLastQuery !== undefined && { queuedInLastQuery }),
                    discovered: record.discovered + discovered, screened: record.screened + screened, scans: record.scans + scans,
                }),
                retain: retained => update({ retained }),
                candidates: rows => update({ candidates: structuredClone([...new Map(rows.map(row => [row.id, row])).values()]
                    .slice(-DEVELOPMENT_SEARCH_LIMIT)) }),
                checked: (listingId, action) => {
                    checked.add(listingId);
                    if (action === "inspect_photos") photoChecks.add(listingId);
                    if (record.reviewed !== checked.size || record.photos !== photoChecks.size) {
                        update({ reviewed: checked.size, photos: photoChecks.size });
                    }
                },
            });
            finish("completed");
            return result;
        } catch (error) {
            finish(signal.aborted ? "stopped" : "failed");
            throw error;
        } finally {
            signal.removeEventListener("abort", stop);
        }
    }

    return { read, observe };
}

export const huntProgress = createHuntProgressStore();
