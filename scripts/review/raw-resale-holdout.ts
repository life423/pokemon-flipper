import { parseListingLink } from "../../shared/listing-link.ts";
import { isRawCondition } from "../../shared/conditions.ts";
import { readyForPricing } from "../../shared/identity.ts";
import { cardLanguageStatus } from "../../shared/card-language.ts";
import { median } from "../../shared/sold-evidence.ts";
import type { Evaluation } from "../../shared/types.ts";
import type { RawResaleForecast } from "../../server/analysis/raw-resale-forecast.ts";

export const ebayId = (id?: string | null) => parseListingLink(id)?.itemId.split("|")[1];
export const marketKey = (f: Pick<RawResaleForecast, "identity" | "variant" | "condition">) =>
    JSON.stringify([String(f.identity.recordId), f.identity.printing, f.identity.finish, f.variant, f.condition]);

// Older app versions saved condition-specific eBay quotes but never recorded
// a presentation forecast or the competing ask. Leave both fields unknown.
export function archivedForecasts(e: Evaluation, savedAt?: string): RawResaleForecast[] {
    const id = e.identity, raw = e.rawPricing;
    if (!id?.recordId || !readyForPricing(id) || id.notThisCard || cardLanguageStatus("", [id.language]) !== "ENGLISH" ||
        !raw?.variant || raw.status !== "PRICED" || raw.printing !== id.printing || raw.finish !== id.finish || !ebayId(e.listing.id)) return [];
    const checked = Date.parse(e.pricesCheckedAt ?? "");
    return (raw.prices ?? []).flatMap(row => {
        const comps = row.comps;
        if (row.basis !== "EBAY_SOLD" || !isRawCondition(row.condition) || !Number.isFinite(row.price) || row.price <= 0 ||
            !comps?.sales.length || comps.grader !== "RAW" || comps.grade !== row.condition || !Number.isFinite(checked)) return [];
        const at = Math.max(checked, ...[row.updatedAt, e.answeredAt, savedAt].filter((s): s is string => !!s).map(s => Date.parse(s)));
        if (!Number.isFinite(at) || comps.sales.some(s => !(Date.parse(s.soldAt) <= at))) return [];
        return [{ version: 1, source: "archived sold estimate", identity: id, variant: raw.variant!,
            condition: row.condition, baseline: row.price, expected: null, competitor: null, listingId: e.listing.id,
            issuedAt: new Date(at).toISOString(), trainingIds: comps.sales.flatMap(s => s.url && ebayId(s.url) ? [s.url] : []) } satisfies RawResaleForecast];
    });
}

export interface LaterSale { id: string; market: string; date: string; price: number; method: "fixed_price" | "best_offer_accepted" }
export function scoreRawForecasts(forecasts: RawResaleForecast[], sales: LaterSale[]) {
    const ordered = [...forecasts].sort((a,b) => b.issuedAt.localeCompare(a.issuedAt) || a.listingId.localeCompare(b.listingId));
    const byMarket = new Map<string, RawResaleForecast[]>();
    for (const forecast of ordered) {
        const key = marketKey(forecast);
        if (!byMarket.has(key)) byMarket.set(key, []);
        byMarket.get(key)!.push(forecast);
    }
    const rows = [];
    for (const sale of sales) {
        const at = Date.parse(sale.date);
        if (!Number.isFinite(at) || !(sale.price > 0)) continue;
        const day = new Date(at).toISOString().slice(0,10);
        const prior = byMarket.get(sale.market)?.filter(f => f.issuedAt.slice(0,10) < day && at - Date.parse(f.issuedAt) <= 90 * 86400000 &&
            ebayId(f.listingId) !== sale.id && !f.trainingIds.some(id => ebayId(id) === sale.id)) ?? [];
        for (const source of ["finalist","archived sold estimate"] as const) {
            const f = prior.find(candidate => candidate.source === source);
            if (f) rows.push({ source, method: sale.method, sale: sale.id, sold: sale.price, date: sale.date, forecastAt: f.issuedAt,
                market: sale.market, baseline: f.baseline, expected: f.expected, competitor: f.competitor?.delivered ?? null });
        }
    }
    const summary = [];
    for (const source of ["archived sold estimate","finalist"] as const) for (const method of ["fixed_price","best_offer_accepted"] as const) {
        const group = rows.filter(r => r.source === source && r.method === method);
        const errors = (mode: "baseline" | "expected", matchedOnly = false) => {
            const diffs = group.flatMap(r => r[mode] === null || matchedOnly && r.expected === null ? [] : [r[mode]! - r.sold]);
            const mean = (a: number[]) => a.length ? Math.round(100 * a.reduce((s,n) => s+n,0) / a.length) / 100 : null;
            return { n: diffs.length, meanSignedUsd: mean(diffs), meanAbsoluteUsd: mean(diffs.map(Math.abs)),
                medianSignedUsd: diffs.length ? median(diffs) : null };
        };
        summary.push({ source, method, markets: new Set(group.map(r => r.market)).size, baseline: errors("baseline"),
            ...(source === "finalist" && { expected: errors("expected"), pairedBaseline: errors("baseline", true) }) });
    }
    return { summary, rows };
}
