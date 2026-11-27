import { createHash } from "node:crypto";
import { requireLiveProvider } from "../lib/saved-provider-evidence.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { readMarketData, saveMarketData } from "./market-cache.ts";
import type { TradedCard } from "./traded-cards.ts";
const share = createSharedWork();
const base = "https://silphcoanalytics.xyz/api/v3/";
type Json = Record<string, unknown>;
const object = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const positive = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
const text = (v: unknown) => typeof v === "string" ? v : "";
async function request(path: string, params: Record<string,string>, signal: AbortSignal) {
    const secret = process.env.SILPHCO_API_KEY?.trim();
    if (!secret) return null;
    const url = new URL(path, base);
    url.search = new URLSearchParams(params).toString();
    const account = createHash("sha256").update(secret).digest("hex").slice(0,24);
    const key = "silph-v1:" + account + ":" + createHash("sha256").update(url.href).digest("hex");
    const hours = params.agg === "movers" ? 24 : path === "listings" ? 0.5 : 6;
    return share(key, async active => {
        const cached = await readMarketData(key, hours);
        if (cached !== null && cached !== undefined) return cached;
        const pauseKey = "silph-backoff:" + account;
        const pause = await readMarketData(pauseKey, 24);
        if (typeof pause === "number" && pause > Date.now()) return null;
        active.throwIfAborted();
        requireLiveProvider("SILPHCO");
        const stop = AbortSignal.any([active, AbortSignal.timeout(params.agg === "movers" ? 25_000 : 12_000)]);
        let body: unknown;
        try {
            const response = await fetch(url, { headers: { Authorization: "Bearer " + secret, Accept: "application/json" }, redirect: "error", signal: stop });
            if (response.status === 429) {
                const retry = response.headers.get("retry-after");
                const until = retry && /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry ?? "");
                await saveMarketData(pauseKey, Number.isFinite(until) && until > Date.now() ? until : Date.now() + 60_000);
            }
            if (!response.ok) {
                await response.body?.cancel();
                if (response.status === 401 || response.status === 403) await saveMarketData(pauseKey, Date.now() + 5 * 60_000);
                if (response.status === 404 || response.status === 400) await saveMarketData(key, { unavailable: true });
                return null;
            }
            body = await response.json();
        } catch (error) {
            active.throwIfAborted();
            if (!(error instanceof TypeError || error instanceof SyntaxError || stop.aborted)) throw error;
            return null;
        }
        if (!object(body).data) return null;
        await saveMarketData(key, body);
        return body;
    }, signal);
}

// The set board pools conditions and editions. It supplies search leads only.
export async function silphSetSeeds(setId: string, name: string, signal: AbortSignal, fetchData = request): Promise<TradedCard[]> {
    if (!/^[a-z0-9.]{1,24}$/i.test(setId)) return [];
    const response = object(await fetchData("sales", { set_id: setId, agg: "movers", language: "en", marketplace: "ebay" }, signal));
    const rows = object(response.data).rows;
    if (response.contract !== "sales.v2" || object(response.request).set_id !== setId || !Array.isArray(rows) || rows.length !== 1) return [];
    const board = object(rows[0]);
    const hints = new Map<string, { card: TradedCard; activity: number }>();
    for (const group of [board.top_volume, board.top_gainers]) {
        for (const item of Array.isArray(group) ? group : []) {
            const row = object(item), sku = text(row.tcg_card_id), number = sku.slice(setId.length + 1);
            if (!sku.startsWith(setId + "-") || !/^[a-z]*[0-9]+[a-z]*$/i.test(number) || !text(row.name).trim() ||
                row.trust !== "ok" || row.capped !== false || !positive(row.n_sales) || !positive(row.n_sales_prior_7d)) continue;
            hints.set(sku, { card: { name: text(row.name), number, set: name, mover: "Silph Co set activity" },
                activity: Math.min(row.n_sales, row.n_sales_prior_7d) });
        }
    }
    return [...hints.values()].sort((a,b) => b.activity - a.activity).map(row => row.card);
}

export { request as silphRequest };
