import type { Evaluation } from "../../shared/types.ts";
import type { DailyPrice, MarketHistory } from "../../shared/price-history.ts";
import { CONDITION_NAMES, isRawCondition } from "../../shared/conditions.ts";
import { huntPhotoIdentityIssue } from "../analysis/deal-hunt-market-checks.ts";
import { observedSoldSales } from "../../shared/sales-activity.ts";
import { verifiedSlabMarketKey } from "../../shared/slab-market.ts";
import { observedCardKind } from "../../shared/photo-evidence.ts";
import { releaseIssue } from "../../shared/base-set-release.ts";
import { photoMatchedRawPrice, unsupportedVariantReason } from "../../shared/money/price-evidence.ts";
import { dailyRawHistory } from "./pkmnprices.ts";

const dayMs = 86400000;
function median(values: number[]) {
    values.sort((a,b) => a-b);
    const mid = Math.floor(values.length / 2);
    return (values[mid]! + values[Math.floor((values.length - 1) / 2)]!) / 2;
}

export function weeklyOutlook(points: DailyPrice[], now: number): Pick<MarketHistory, "outlook" | "reason"> {
    const end = Math.floor(now / dayMs);
    const weeks: (number | null)[] = [];
    for (let i = 0; i < 12; i++) {
        const sample = points.filter(p => {
            const age = end - Date.parse(p.day) / dayMs;
            return age >= 7*i && age < 7*i + 7;
        });
        weeks.push(sample.length >= 4 ? median(sample.map(p => p.price)) : null);
    }
    const unavailable = (reason: string) => ({ outlook: "Insufficient evidence", reason });
    if (!points.length || now - Date.parse(points[points.length-1].day) > 3 * dayMs || weeks[0] === null || weeks[1] === null)
        return unavailable("Recent price observations are too sparse for a seven-day estimate.");
    let trials = 0, momentumError = 0, flatError = 0;
    for (let i = 0; i + 2 < weeks.length; i++) {
        const [observed, previous, older] = weeks.slice(i, i+3);
        if (observed == null || previous == null || older == null) continue;
        trials++;
        momentumError += Math.abs(observed - (2*previous - older));
        flatError += Math.abs(observed - previous);
    }
    if (trials < 5 || momentumError >= flatError)
        return unavailable("The recent trend has too little history or failed to improve on a flat estimate in prior weeks.");
    const change = weeks[0]! / weeks[1]! - 1;
    return { outlook: Math.abs(change) < .02 ? "Roughly flat" : change > 0 ? "Upward bias" : "Downward bias",
        reason: "Seven-day estimate from weekly medians. Tested against a flat estimate across " + trials + " earlier weeks." };
}

export async function marketHistory(value: Evaluation, now = Date.now(), history = dailyRawHistory): Promise<MarketHistory> {
    const id = value.identity, kind = observedCardKind(value);
    const unavailable = (reason: string): MarketHistory => ({source:"",scope:"",points:[],outlook:"Insufficient evidence",reason});
    if (!id || !id.name || !kind || id.notThisCard || huntPhotoIdentityIssue(value) || releaseIssue(value) || unsupportedVariantReason(value)) return unavailable("The photos need to establish the exact printing.");
    let source: string, scope: string;
    const days = new Map<string, number[]>(), conflicts = new Set<string>();
    if (kind === "graded") {
        const comp = value.slabPricing?.summary;
        if (!verifiedSlabMarketKey(value) || !comp || comp.grader !== value.slab?.grader || Number(comp.grade) !== Number(value.slab.grade) ||
            value.slabPricing?.printing !== id.printing) return unavailable("No exact slab sales series is available.");
        source = "Recorded eBay sales · daily median in USD"; scope = comp.grader + " " + comp.grade;
        for (const sale of observedSoldSales(comp.activitySales ?? comp.sales, now, {maxDays:90,slab:true})) {
            const day = new Date(sale.at).toISOString().slice(0,10);
            days.set(day, [...(days.get(day) ?? []), sale.price]);
        }
    } else {
        const condition = value.condition?.rawCondition, pricing = value.rawPricing;
        if (value.photoCheck && isRawCondition(condition) && pricing?.printing === id.printing && pricing?.finish === id.finish) {
            const receipts = pricing?.prices?.filter(row => row.condition === condition && photoMatchedRawPrice(row.comps, condition) !== null)
                .flatMap(row => row.comps?.sales ?? []) ?? [];
            const sales = observedSoldSales(receipts, now);
            for (const sale of sales) {
                const day = new Date(sale.at).toISOString().slice(0, 10);
                days.set(day, [...(days.get(day) ?? []), sale.price]);
            }
            if (days.size >= 4 && sales[0].at >= now - 14 * dayMs) {
                const points = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, prices]) => ({ day, price: median(prices) }));
                return { source: "Photo-matched eBay sales · daily median in USD", scope: CONDITION_NAMES[condition], points,
                    ...weeklyOutlook(points, now) };
            }
            days.clear();
        }
        if (!value.photoCheck || !/^\d+$/.test(String(id.recordId)) || !isRawCondition(condition) || condition === "MINT" ||
            pricing?.source !== "pkmnprices" || pricing.printing !== id.printing || pricing.finish !== id.finish || !pricing.variant)
            return unavailable("The assessed condition and printing need an exact TCGplayer history series.");
        const label = CONDITION_NAMES[condition];
        source = "TCGplayer via PKMNPrices · daily average in USD"; scope = pricing.variant + " · " + label;
        const rows = (await history(String(id.recordId), pricing.variant, label)).data ?? [];
        for (const row of rows) {
            if (row?.currency !== "USD" || row.source !== "tcgplayer" || row.variant !== pricing.variant || row.condition !== label ||
                !Number.isFinite(row.avg) || row.avg <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
            const ts = Date.parse(row.date);
            if (!Number.isFinite(ts) || new Date(ts).toISOString().slice(0,10) !== row.date || ts > now || now - ts > 90*dayMs) continue;
            if (days.has(row.date) && days.get(row.date)![0] !== row.avg) conflicts.add(row.date);
            days.set(row.date,[row.avg]);
        }
    }
    const points = [...days].filter(([day])=>!conflicts.has(day)).sort(([a],[b])=>a.localeCompare(b))
        .map(([day,values])=>({day,price:median(values)}));
    return {source,scope,points,...weeklyOutlook(points,now)};
}
