import type { Identity, MarketActivity } from "../../shared/types.ts";
import type { PricedCard } from "./types.ts";
import { variantFor } from "./raw-prices.ts";

interface VolumeRow { date: string; currency: string; variant: string | null; graded: boolean; sales: number }
export function summarizeVolume(rows: unknown[], variant: string, graded: boolean, complete: boolean, now = Date.now()): MarketActivity {
    const days = new Map<string, number>();
    for (const value of rows) {
        const row = value as VolumeRow | null;
        if (!row || row.currency !== "USD" || row.variant !== variant || row.graded !== graded ||
            !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isInteger(row.sales) || row.sales < 0) continue;
        const age = now - Date.parse(row.date);
        if (!Number.isFinite(age) || age < 0 || age >= 30 * 86400000) continue;
        days.set(row.date, row.sales);
    }
    const observedSales = [...days.values()].reduce((a, b) => a + b, 0);
    return { status: "AVAILABLE", scope: graded ? "GRADED" : "RAW", variant, periodDays: 30, observedSales,
        activeDays: [...days.values()].filter(n => n > 0).length, dailyAverage: observedSales / 30,
        newestSale: [...days].filter(([, count]) => count > 0).map(([date]) => date).sort().at(-1) ?? null,
        checkedAt: new Date(now).toISOString(), complete };
}

export async function activityFor(card: PricedCard | null, identity: Identity, graded: boolean, fetchVolume: (recordId: number | string, variant: string, graded: boolean) => Promise<{ data: unknown[]; pagination?: { total_pages?: number } }>): Promise<MarketActivity | undefined> {
    const { variant } = variantFor(card, identity);
    if (!variant || identity.status !== "IDENTIFIED" || card?.source !== "pkmnprices") return undefined;
    try {
        const result = await fetchVolume(variant.recordId, variant.name, graded);
        return summarizeVolume(result.data, variant.name, graded, result.pagination?.total_pages === 1 || result.pagination?.total_pages === 0);
    } catch {
        return { status: "UNAVAILABLE", scope: graded ? "GRADED" : "RAW", variant: variant.name, periodDays: 30,
            observedSales: 0, activeDays: 0, dailyAverage: 0, newestSale: null, complete: false, checkedAt: new Date().toISOString(),
            reason: "eBay sales volume is unavailable from the provider or your plan. Dated comparable sales are shown when available." };
    }
}
