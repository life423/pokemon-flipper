import { acceptedSoldCondition, corroboratedSoldCondition, type SoldConditionReading } from "../server/ai/sold-condition.ts";
import { uniqueSoldComps, matchesSoldTarget, compProblem } from "../server/pricing/sold-comps.ts";
import type { Comp } from "../server/pricing/types.ts";
import type { RawResaleForecast } from "../server/analysis/raw-resale-forecast.ts";
import { cardLanguageStatus } from "../shared/card-language.ts";
import { finishClaim } from "../shared/finish.ts";
import { archiveFiles, archivedEvaluation, flipPasses } from "./review/flip-archive.ts";
import { archivedForecasts, ebayId, marketKey, scoreRawForecasts, type LaterSale } from "./review/raw-resale-holdout.ts";

const forecasts = new Map<string, RawResaleForecast>();
const transactions = new Map<string, Comp[]>();
const readings = new Map<string, { primary: SoldConditionReading; corroboration?: SoldConditionReading; photos: string[] }[]>();
const confirmations = new Map<string, SoldConditionReading>();
const savedReadings: { key: string; id: string; photos: string[]; primary: SoldConditionReading }[] = [];
const embedded = new Map<string, Set<string>>();
const now = Date.now();
function add(f: RawResaleForecast) {
    if (Date.parse(f.issuedAt) <= now) forecasts.set(JSON.stringify([f.source, f.listingId, f.issuedAt, marketKey(f)]), f);
}
function readEvaluation(record: Parameters<typeof archivedEvaluation>[0] & { savedAt?: string }) {
    const value = archivedEvaluation(record);
    if (!value) return;
    for (const f of archivedForecasts(value, record.savedAt)) {
        add(f);
        for (const row of value.rawPricing?.prices ?? []) {
            if (row.condition !== f.condition || row.comps?.grade !== f.condition || row.comps.grader !== "RAW") continue;
            for (const sale of row.comps.sales) {
                const id = ebayId(sale.url);
                if (!id || sale.photoCondition !== f.condition || !sale.conditionEvidence?.some(note => note.trim())) continue;
                const markets = embedded.get(id) ?? new Set();
                markets.add(marketKey(f));
                embedded.set(id, markets);
            }
        }
    }
}
for await (const record of archiveFiles("evaluations")) readEvaluation(record);
for await (const record of archiveFiles("price-cache")) {
    readEvaluation(record);
    const key = String(record.key), data = record.data;
    const page = /^pkmnprices:\/cards\/(\d+)\/listings\/ebay\?/.exec(key);
    if (page && Array.isArray(data?.data)) {
        const rows = transactions.get(page[1]) ?? [];
        for (const sale of data.data) if (sale.id != null || ebayId(sale.listing_url)) rows.push(sale);
        transactions.set(page[1], rows);
    } else if (key.startsWith("sold-condition:")) {
        if (key.includes(":verification-v1:") && data?.card) confirmations.set(key, data);
        else if (data?.primary && Array.isArray(data.photos) && data.photos.length && ebayId(data.listingId))
            savedReadings.push({ key, id: data.listingId, photos: data.photos, primary: data.primary });
    }
}
for (const saved of savedReadings) {
    const matches = [...confirmations].filter(([key]) => key.startsWith(saved.key + ":verification-v1:") && key.endsWith(":" + saved.id));
    const rows = readings.get(ebayId(saved.id)!) ?? [];
    rows.push({ ...saved, corroboration: matches[0]?.[1] });
    readings.set(ebayId(saved.id)!, rows);
}
for await (const { events } of flipPasses()) for (const event of events) {
    const f = event.evidence.rawForecast as RawResaleForecast | undefined;
    if (event.event === "observation" && event.evidence.action === "review_resale" && f?.version === 1 && f.source === "finalist") add(f);
}

const markets = new Map([...forecasts.values()].map(f => [marketKey(f), f]));
const sales = new Map<string, LaterSale>();
const conflicts = new Set<string>();
const unverified = new Set<string>();
// Resolve revisions and retractions by the provider's transaction ID first.
// A syndicated duplicate with another source ID can still be the same eBay item.
const unique = new Map([...transactions].map(([product, rows]) => [product, uniqueSoldComps(uniqueSoldComps(rows).flatMap(sale => {
    const id = ebayId(sale.listing_url);
    return id ? [{ ...sale, id }] : [];
}))]));
for (const [market, f] of markets) {
    const i = f.identity;
    for (const s of unique.get(String(i.recordId)) ?? []) {
        const at = Date.parse(s.sold_at), id = ebayId(s.listing_url)!;
        if (!(at <= now) || s.grader || s.grade || s.variant !== f.variant || s.currency !== "USD" ||
            s.sale_type !== "fixed_price" && s.sale_type !== "best_offer_accepted" ||
            cardLanguageStatus(s.title) === "OTHER" || !["NOT_STATED",i.finish].includes(finishClaim(s.title)) ||
            !matchesSoldTarget(s, { name: i.name!, setName: i.set!, cardNumber: i.cardNumber!, requireTitleIdentity: true }) ||
            compProblem({ ...s, grader: "RAW", grade: f.condition }, { printing: i.printing, finish: i.finish, cardName: i.name,
                cardNumber: i.cardNumber, setName: i.set, grader: "RAW", grade: f.condition, now: at })) continue;
        const conditions = new Set((readings.get(id) ?? []).flatMap(r => {
            const proof = acceptedSoldCondition(r.primary, i, r.photos.length) ??
                (r.corroboration && corroboratedSoldCondition(r.primary, r.corroboration, i, r.photos.length));
            return proof ? [proof.condition] : [];
        }));
        const embeddedMarkets = embedded.get(id);
        if ((embeddedMarkets?.size ?? 0) > 1 || conditions.size > 1) { conflicts.add(id); continue; }
        if (!conditions.has(f.condition) && !embeddedMarkets?.has(market)) { unverified.add(id); continue; }
        if (conditions.size && !conditions.has(f.condition) || embeddedMarkets?.size && !embeddedMarkets.has(market)) {
            conflicts.add(id); continue;
        }
        if (sales.has(id) && sales.get(id)!.market !== market) conflicts.add(id);
        sales.set(id, { id, market, date: s.sold_at, price: s.price, method: s.sale_type });
    }
}
for (const id of conflicts) sales.delete(id);
for (const id of conflicts) unverified.delete(id);
for (const id of sales.keys()) unverified.delete(id);
const report = scoreRawForecasts([...forecasts.values()], [...sales.values()]);
console.log(JSON.stringify({ forecasts: forecasts.size, markets: markets.size,
    recordedFinalistForecasts: [...forecasts.values()].filter(f => f.source === "finalist").length,
    photoMatchedSaleIds: sales.size, unresolvedSaleIds: unverified.size, conflictingSaleIds: conflicts.size,
    laterSaleIdsScored: new Set(report.rows.map(r => r.sale)).size, summary: report.summary,
    ...(process.argv.includes("--details") && { rows: report.rows }) }, null, 2));
