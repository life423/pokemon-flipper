import { dollars } from "../format.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../search-diagnostic.ts";
import { verifiedSlabMarketKey } from "../slab-market.ts";
import { median } from "../sold-evidence.ts";
import type { Evaluation } from "../types.ts";
import { MONEY_CONFIG } from "./config.ts";
import { acquisitionCost, netFromSale } from "./underwriting.ts";

const day = 86_400_000;
const validPrice = (price: number) => Number.isFinite(price) && price > 0;

function recent(date: string | null | undefined, now: number, maxAge: number): boolean {
    const age = now - Date.parse(date ?? "");
    return Number.isFinite(age) && age >= 0 && age <= maxAge;
}

function fallbackEstimate(value: Evaluation, now: number) {
    const tracker = value.trackerPriceReference, stats = tracker?.gradedMarket;
    if (tracker?.printingLabel && stats && stats.grader === value.slab?.grader && stats.grade === value.slab?.grade &&
        validPrice(stats.priceUsd) && Number.isSafeInteger(stats.reportedSales) && stats.reportedSales > 0 && recent(stats.lastSaleAt, now, 90 * day)) {
        const filtered = stats.filteredEstimate;
        const weekly = stats.statistic === "7_DAY_MEDIAN" && recent(stats.lastSaleAt, now, 7 * day);
        const useFiltered = !weekly && filtered && validPrice(filtered.priceUsd) && Number.isInteger(filtered.days) &&
            filtered.days > 0 && filtered.days <= 90 && recent(stats.lastSaleAt, now, filtered.days * day);
        if (weekly || useFiltered || stats.statistic === "HISTORICAL_MEDIAN") {
            const statistic = weekly ? "7-day median" : useFiltered ? `${filtered.days}-day provider estimate · ${filtered.confidence.toLowerCase()} confidence` : "historical median";
            return { price: useFiltered ? filtered.priceUsd : stats.priceUsd, source: "Pokémon Price Tracker", count: stats.reportedSales, date: stats.lastSaleAt.slice(0, 10),
                basis: `${tracker.printingLabel} · ${statistic}`, countLabel: stats.reportedSales === 1 ? "reported sale across all dates" : "reported sales across all dates" };
        }
    }
    // Supplemental research validates cited transactions against this exact card and grade.
    const seen = new Set<string>();
    const sales = value.webPriceResearch?.observations.filter(sale => {
        if (sale.kind !== "SOLD" || !sale.url || seen.has(sale.url) || !validPrice(sale.priceUsd) || !recent(sale.date, now, 90 * day)) return false;
        seen.add(sale.url);
        return true;
    });
    if (!sales?.length) return null;
    const date = sales.map(sale => sale.date!).sort().at(-1)!;
    return { price: median(sales.map(sale => sale.priceUsd)), source: "Cited web sales", count: sales.length, date: date.slice(0, 10),
        basis: `${value.identity?.printingLabel ?? value.identity?.printing} · ${sales.length === 1 ? "single sale" : "median of cited sales"}`, countLabel: sales.length === 1 ? "sale" : "sales" };
}

// A buyer can compare a thin resale market without promoting a reference to a priced path.
export function slabBuyGuidance(value: Evaluation | null, now: number) {
    if (!value || value.underwriting?.verdict !== "CANT_PRICE" || value.underwriting.best || value.listing.availability === "UNAVAILABLE" ||
        !verifiedSlabMarketKey(value, { allowScratchedCase: true })) return null;
    const estimate = fallbackEstimate(value, now);
    if (!estimate) return null;
    const { listing } = value;
    const slab = value.slab!;
    const evidence = `${estimate.source} · ${estimate.basis}. ${estimate.count} ${estimate.countLabel} · latest ${estimate.date}.`;
    const caseNote = slab.caseCondition === "SCRATCHED" ? "The holder has visible scratches. The estimate includes no adjustment for the case." : null;
    const grade = `${slab.grader} ${slab.grade}`;
    const { price, shipping } = listing;
    if (listing.buyingOption !== "FIXED_PRICE" || price == null || !validPrice(price) || shipping == null || !Number.isFinite(shipping) || shipping < 0 ||
        value.underwriting.shippingUnconfirmed || !recent(listing.termsCheckedAt, now, 90 * day)) {
        return { ...estimate, grade, evidence, caseNote, headline: "Estimated market value", explanation: "A current purchase price and shipping quote are needed to compare the cost with this estimate." };
    }
    const cost = acquisitionCost(price, shipping, MONEY_CONFIG.buying);
    const proceeds = netFromSale(estimate.price, "graded", MONEY_CONFIG.selling);
    const difference = proceeds - cost;
    const headline = difference > 0 ? "Possible margin at the estimate" : "Wait at this price";
    const quote = recent(listing.termsCheckedAt, now, BEST_BUY_TERMS_MAX_AGE_MS) ? "estimated purchase total" : "last checked purchase total";
    const comparison = difference === 0 ? `equal to the ${dollars(cost)} ${quote}` : `${dollars(Math.abs(difference))} ${difference > 0 ? "above" : "below"} the ${dollars(cost)} ${quote}`;
    const explanation = `Reselling at ${dollars(estimate.price)} would leave ${dollars(proceeds)} after fees and postage, ${comparison}.`;
    return { ...estimate, grade, evidence, caseNote, headline, explanation };
}
