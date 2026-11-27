import { readBoundedText } from "../lib/http.ts";
import { createHash } from "node:crypto";
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
    return readBoundedText(response, 2_000_000);
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
