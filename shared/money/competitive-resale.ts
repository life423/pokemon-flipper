import { parseListingLink } from "../listing-link.ts";
import { observedSoldSales } from "../sales-activity.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../search-diagnostic.ts";
import { isRawSoldPrice } from "./price-evidence.ts";
import { MONEY_CONFIG } from "./config.ts";
import { netFromSale, pathNumbers } from "./underwriting.ts";
import type { Evaluation, PricedPath, Targets } from "../types.ts";

export interface CompetingAsk { listingId: string; delivered: number; checkedAt: string }

export function competitiveResalePath(value: Evaluation, path: PricedPath, ask: CompetingAsk, now: number, targets: Targets): PricedPath | null {
    const age = now - Date.parse(ask.checkedAt), copy = parseListingLink(ask.listingId), own = parseListingLink(value.listing.id);
    if (!copy || !own || copy.itemId.split("|")[1] === own.itemId.split("|")[1] || !(age >= 0 && age < BEST_BUY_TERMS_MAX_AGE_MS) ||
        !Number.isFinite(ask.delivered) || ask.delivered <= 0 || !path.salePrice || value.listing.price === null ||
        value.listing.buyingOption !== "FIXED_PRICE" || path.path === "GRADE") return null;
    const raw = path.path === "RAW";
    if (raw && path.priceCondition !== value.condition?.rawCondition) return null;
    const summary = raw ? value.rawPricing?.prices?.find(r => r.condition === path.priceCondition &&
        r.price === path.salePrice && isRawSoldPrice(r))?.comps : value.slabPricing?.summary;
    const matching = (summary?.sales ?? []).filter(sale => !raw || sale.photoCondition === path.priceCondition && sale.conditionEvidence?.length);
    const recent = observedSoldSales(matching, now, { maxDays: 30, slab: !raw }).sort((a, b) => a.price - b.price);
    // The upper quartile uses an observed sale and never the single highest sale.
    // Sparse data cannot lift the estimate. A lower competing ask still limits it.
    const upper = recent.length >= 4 ? recent[Math.floor((recent.length - 1) * .75)].price : path.salePrice;
    const salePrice = Math.min(ask.delivered, Math.max(path.salePrice, upper));
    const expectedNet = netFromSale(salePrice, raw ? "raw" : "graded", MONEY_CONFIG.selling);
    const downsideNet = path.downside === null ? null : Math.min(expectedNet, path.cost + path.downside);
    return { ...path, salePrice, expectedNet,
        ...pathNumbers({ expectedNet, downsideNet, fixedCosts: path.fixedCosts, shipping: path.shipping, price: value.listing.price },
            { ...MONEY_CONFIG, targets }) };
}
