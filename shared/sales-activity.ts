import { hasSpecialSlabTitle } from "./grade-qualifier.ts";
import { parseListingLink } from "./listing-link.ts";
import type { CompSale } from "./types.ts";

export const SALES_ACTIVITY_DAYS = 60;
export const SALES_ACTIVITY_MS = SALES_ACTIVITY_DAYS * 86_400_000;
const day = 86_400_000;
const confirmedTypes = new Set(["auction", "fixed_price", "best_offer_accepted"]);

export interface ObservedSale {
    id: string;
    at: number;
    price: number;
    sale: CompSale;
}

// Callers establish the exact card/printing/finish/condition or grade scope.
// A quote or provider aggregate cannot become a counted transaction here.
export function observedSoldSales(sales: readonly CompSale[], now: number, { maxDays = 90, slab = false } = {}): ObservedSale[] {
    const distinct = new Map<string, ObservedSale>();
    const conflicting = new Set<string>();
    for (const sale of sales) {
        const id = parseListingLink(sale.url)?.itemId.split("|")[1];
        const at = Date.parse(sale.soldAt), age = now - at;
        if (!id || !confirmedTypes.has(sale.saleType ?? "") || !Number.isFinite(age) || age < 0 || age > maxDays * day ||
            !Number.isFinite(sale.price) || sale.price <= 0 || "currency" in sale && sale.currency !== "USD" ||
            slab && hasSpecialSlabTitle(sale.title)) continue;
        const previous = distinct.get(id);
        if (previous && (previous.at !== at || previous.price !== sale.price)) conflicting.add(id);
        distinct.set(id, { id, at, price: sale.price, sale });
    }
    return [...distinct.values()].filter(sale => !conflicting.has(sale.id)).sort((a, b) => b.at - a.at);
}

export function observedSalesActivity(sales: readonly CompSale[], now: number, options?: Parameters<typeof observedSoldSales>[2]) {
    const observations = observedSoldSales(sales, now, options);
    const count = (days: number) => observations.filter(sale => now - sale.at <= days * day).length;
    return { observations, sales7: count(7), sales30: count(30), sales60: count(SALES_ACTIVITY_DAYS), sales90: count(90),
        latestSaleAt: observations[0] ? new Date(observations[0].at).toISOString() : null };
}
