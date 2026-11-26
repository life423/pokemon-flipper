import { createHash } from "node:crypto";
import { trackSharedWork } from "../lib/shared-work.ts";
import { readMarketData, reserveMarketImport, saveMarketData } from "./market-cache.ts";

const central = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit" });

export function marketImportSchedule(keyPrefix: string, now: number) {
    const parts = Object.fromEntries(central.formatToParts(now).map(part => [part.type, part.value]));
    const day = [parts.year, parts.month, parts.day].join("-");
    // All instances agree on today's minute, including after a restart or DST change.
    const minute = createHash("sha256").update(keyPrefix + day).digest().readUInt16BE() % 60;
    return { day, due: Number(parts.hour) * 60 + Number(parts.minute) >= 5 * 60 + minute };
}

export interface MarketImportOptions { now?: number; signal?: AbortSignal; fetchPage?: typeof fetch }

export async function fetchMarketHtml(url: string, fetchPage: typeof fetch, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetchPage(url, { redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(new URL(url).hostname + " returned HTTP " + response.status);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2_000_000) {
            await reader.cancel();
            throw new Error("Market page exceeded the expected size.");
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

export async function importMarketDay<T>(prefix: string, now: number, collect: () => Promise<T>): Promise<T | null> {
    const key = prefix + marketImportSchedule(prefix, now).day;
    if (!await reserveMarketImport(key + ":attempt")) return readMarketData(key, 72);
    const snapshot = await collect();
    await saveMarketData(key, snapshot);
    return snapshot;
}

export async function recentMarketDay<T>(prefix: string, now: number): Promise<T | null> {
    const today = marketImportSchedule(prefix, now).day;
    const yesterday = new Date(Date.parse(today + "T12:00:00Z") - 86_400_000).toISOString().slice(0, 10);
    for (const day of [today, yesterday]) {
        const snapshot = await readMarketData(prefix + day, 48);
        if (snapshot) return snapshot;
    }
    return null;
}

export function scheduleMarketImport(prefix: string, signal: AbortSignal, run: (options: { now: number; signal: AbortSignal }) => Promise<unknown>) {
    let attemptedDay = "";
    const tick = () => {
        const now = Date.now(), { day, due } = marketImportSchedule(prefix, now);
        if (!due || day === attemptedDay || signal.aborted) return;
        attemptedDay = day;
        void trackSharedWork(run({ now, signal })).catch(error => {
            if (!signal.aborted) console.error("Daily market import failed for " + prefix, error);
        });
    };
    const timer = setInterval(tick, 60_000);
    timer.unref();
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
    tick();
}
