import { parseListingLink } from "../listing-link.ts";
import { observedSoldSales } from "../sales-activity.ts";
import { median, typicalSales, soldMarketPrice } from "../sold-evidence.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../search-diagnostic.ts";
import type { Evaluation, PricedPath } from "../types.ts";
import { cents, money } from "./cents.ts";
import { MONEY_CONFIG } from "./config.ts";
import { rawPriceForPath } from "./price-evidence.ts";
import { matchesSlabSummary, netFromSale } from "./underwriting.ts";

export interface ComparableAsk {
    listingId: string;
    delivered: number;
    checkedAt: string;
    validUntil: number;
    destination: string | null;
}

export type SaleStatistic = "median" | "mean";
export type RelistModel = "matched-sales-v1" | "matched-sales-v2";

// v1 remains replayable for existing purchase receipts. New estimates use the
// center of recent matched transactions; active asks describe competition.
export function relistEstimate(value: Evaluation, path: PricedPath, ask: ComparableAsk | null, now: number, statistic: SaleStatistic = "median", model: RelistModel = "matched-sales-v2") {
    const current = path.salePrice;
    if (!current || path.path === "GRADE") return null;
    if (ask) {
        const peer = parseListingLink(ask.listingId), own = parseListingLink(value.listing.id);
        const checked = Date.parse(ask.checkedAt);
        if (!peer || !own || peer.itemId.split("|")[1] === own.itemId.split("|")[1] ||
            !(ask.delivered > 0 && Number.isFinite(ask.delivered)) || ask.destination !== (value.listing.shippingDestination ?? null) ||
            !(checked <= now && now < ask.validUntil && ask.validUntil <= checked + BEST_BUY_TERMS_MAX_AGE_MS)) return null;
    }
    const raw = path.path === "RAW";
    let summary;
    if (raw && path.priceCondition === value.condition?.rawCondition) {
        summary = rawPriceForPath(value.rawPricing, path)?.comps;
    } else if (!raw && value.slab && value.slabPricing?.status === "PRICED" &&
        value.slabPricing.printing === value.identity?.printing && value.slabPricing.summary && matchesSlabSummary(value.slabPricing.summary, value.slab)) {
        summary = value.slabPricing.summary;
    }
    if (!summary?.sales.length || soldMarketPrice(summary) !== current) return null;
    let price = current;
    {
        const sales = observedSoldSales(summary.sales, now, { maxDays: model === "matched-sales-v1" ? 30 : summary.windowDays ?? 90, slab: !raw })
            .filter(({ sale }) => !raw || sale.photoCondition === path.priceCondition && sale.conditionEvidence?.length);
        // Filter across the evidence window first, so one new extreme price
        // cannot displace the comparable sales just outside the last 30 days.
        const kept = typicalSales(sales);
        const recent = kept.filter(sale => now - sale.at <= 30 * 86400000);
        const window = recent.length ? recent : kept;
        const fixed = window.filter(({ sale }) => sale.saleType === "fixed_price" || sale.saleType === "best_offer_accepted");
        const selected = model === "matched-sales-v2" && fixed.length ? fixed : window;
        const typical = selected.map(sale => sale.price).sort((a, b) => a - b);
        if (model === "matched-sales-v2" && typical.length) {
            price = money(statistic === "mean" ? typical.reduce((total, sale) => total + sale, 0) / typical.length : median(typical));
        } else if (model === "matched-sales-v1" && ask && typical.length >= 4) {
            const half = Math.floor(typical.length / 2);
            const lower = Math.min(current, median(typical.slice(0, half)));
            const upper = Math.max(current, median(typical.slice(-half)));
            price = money(Math.max(lower, Math.min(upper, ask.delivered)));
        }
    }
    const net = netFromSale(price, raw ? "raw" : "graded", MONEY_CONFIG.selling);
    return { model, statistic, price, profit: (cents(net) - cents(path.cost)) / 100,
        lowestOtherDelivered: ask?.delivered ?? null, competitor: ask };
}
