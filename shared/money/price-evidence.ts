import type { Evaluation, Identity, PricedPath, RawPrice, RawPricing } from "../types.ts";
import { jungleNoSymbolReason, type JungleVariantContext } from "../jungle-no-symbol.ts";
import { missingTextureReason } from "../grade-qualifier.ts";
import { soldMarketPrice } from "../sold-evidence.ts";
import { isPrinting } from "../identity.ts";
import { isRawCondition } from "../conditions.ts";

type PriceEvidence = Partial<Pick<Evaluation, "rawPricing" | "gradedPricing" | "slabPricing">> & JungleVariantContext &
    { identity?: Partial<Pick<Identity, "printing">> | null };

export const PRICE_PRINTING_MISMATCH = "The saved price evidence is for a different printing. Matched sales for the identified printing are needed.";

export function pricePrintingMismatch(priced: unknown, identified: unknown): boolean {
    return isPrinting(priced) && isPrinting(identified) && priced !== identified;
}

export function hasMismatchedPricePrinting(evaluation: PriceEvidence): boolean {
    return [evaluation.rawPricing, evaluation.slabPricing, ...Object.values(evaluation.gradedPricing ?? {})]
        .some(pricing => pricePrintingMismatch(pricing?.printing, evaluation.identity?.printing));
}

export function unsupportedVariantReason(input: JungleVariantContext): string | null {
    return missingTextureReason(input.listing?.title) ?? jungleNoSymbolReason(input);
}

// Keep accepted photo facts while removing prices from an ordinary market
// that cannot price this variant, including saved financial snapshots.
export function withoutUnsupportedVariantPrices(evaluation: Evaluation): Evaluation {
    const reason = unsupportedVariantReason(evaluation);
    if (!reason && !hasMismatchedPricePrinting(evaluation)) return evaluation;
    const unavailable = { status: "PRICE_UNAVAILABLE" as const, reason: reason ?? PRICE_PRINTING_MISMATCH };
    const supported = <T extends Pick<RawPricing, "printing">>(pricing: T | null | undefined) => {
        if (!pricing) return null;
        if (reason) return unavailable;
        return pricePrintingMismatch(pricing.printing, evaluation.identity?.printing) ? { ...unavailable, printing: pricing.printing } : pricing;
    };
    return { ...evaluation, rawPricing: supported(evaluation.rawPricing),
        gradedPricing: evaluation.gradedPricing ? Object.fromEntries(Object.entries(evaluation.gradedPricing).map(([grader, pricing]) => [grader, supported(pricing)])) : null,
        slabPricing: reason && evaluation.slab ? unavailable : supported(evaluation.slabPricing) };
}

// Older snapshots may omit the basis. Only an accompanying sold summary
// for the same condition and amount can establish their provenance.
export function isRawSoldPrice(price: RawPrice): boolean {
    return Number.isFinite(price.price) && price.price > 0 && (price.basis === "EBAY_SOLD" ||
        price.basis === undefined && price.comps?.grader === "RAW" && price.comps.grade === price.condition &&
        price.comps.count > 0 && soldMarketPrice(price.comps) === price.price);
}

// A matched live marketplace or condition-market estimate can price raw resale.
// It is never counted as a completed transaction or photo-reviewed sold copy.
export function isUsableRawPrice(price: RawPrice): boolean {
    if (isRawSoldPrice(price)) return true;
    const quote = price.offers;
    if (!isRawCondition(price.condition) || !Number.isFinite(price.price) || price.price <= 0 ||
        !quote || quote.source !== "TCGPLAYER" || quote.currency !== "USD" || quote.condition !== price.condition ||
        quote.price !== price.price || !quote.printing?.trim() || !Number.isFinite(Date.parse(quote.checkedAt)) ||
        !Number.isFinite(Date.parse(quote.snapshotAt))) return false;
    if (price.basis === "TCGPLAYER_MARKET") return quote.method === "CONDITION_MARKET" &&
        quote.marketPrice === price.price && quote.offers.length === 0;
    return price.basis === "TCGPLAYER_OFFERS" && quote.method === "LOWEST_DELIVERED_COMPETITION" &&
        quote.offers.length > 0 && quote.offers.every(offer => Number.isFinite(offer.total) && offer.total > 0 &&
            offer.price >= 0 && offer.shipping >= 0 && Math.abs(offer.total - offer.price - offer.shipping) < .001) &&
        price.price <= Math.min(...quote.offers.map(offer => offer.total));
}

export function withoutUnsupportedRawPrices(evaluation: Evaluation): Evaluation {
    const raw = evaluation.rawPricing;
    if (!raw?.prices?.some(price => !isUsableRawPrice(price))) return evaluation;
    const prices = raw.prices.filter(isUsableRawPrice);
    const { evidenceNote, ...saved } = raw;
    return { ...evaluation, rawPricing: prices.length ? { ...saved, prices } : {
        ...saved, status: "PRICE_UNAVAILABLE", prices: [], reason: "No matched eBay sold price is available.",
    } };
}

export function referencePriceReason(evaluation: PriceEvidence, path: PricedPath): string | null {
    const variant = unsupportedVariantReason(evaluation);
    if (variant) return variant;
    const pricing = path.path === "RAW" ? evaluation.rawPricing : path.path === "GRADED_RESALE" ? evaluation.slabPricing
        : path.grader ? evaluation.gradedPricing?.[path.grader] : undefined;
    if (pricePrintingMismatch(pricing?.printing, evaluation.identity?.printing)) return PRICE_PRINTING_MISMATCH;
    if (path.path === "RAW") {
        const sold = evaluation.rawPricing?.prices?.some(price => price.condition === path.priceCondition &&
            price.price === path.salePrice && isUsableRawPrice(price));
        if (!sold) return "Raw resale needs a matched condition price.";
    }
    if (path.path === "GRADED_RESALE" && evaluation.slabPricing?.activeReference && !evaluation.slabPricing.summary?.count) {
        return "Slab resale has only current Buy It Now asking references; matched sales for the photographed grader and grade are still needed.";
    }
    return null;
}

// Derive this from the stored evidence as well as new underwriting. Older
// saved BUY/PASS results must not resurrect reference-only purchase advice.
// A supported winning route remains usable despite an unfinished alternative.
export function priceEvidenceGap(evaluation: (PriceEvidence & Pick<Evaluation, "underwriting">) | null): string | null {
    const underwriting = evaluation?.underwriting;
    if (!evaluation || !underwriting) return null;
    if (underwriting.shippingUnconfirmed) return null;
    // Terminal fake/unavailable decisions have no financial route to defer.
    if (underwriting.verdict === "PASS" && !underwriting.best) return null;
    const variant = unsupportedVariantReason(evaluation);
    if (variant) return variant;
    if (underwriting.verdict.startsWith("BUY")) return underwriting.best ? referencePriceReason(evaluation, underwriting.best) : null;
    if (underwriting.verdict === "CANT_PRICE" && !underwriting.best && hasMismatchedPricePrinting(evaluation)) return PRICE_PRINTING_MISMATCH;
    if (underwriting.verdict === "CANT_PRICE" && !underwriting.best && evaluation.rawPricing) {
        return underwriting.reasons[0] ?? "Raw resale needs a matched eBay sold price.";
    }
    for (const path of underwriting.paths ?? []) {
        if (path.status === "PRICED") {
            const reason = referencePriceReason(evaluation, path);
            if (reason) return reason;
        }
    }
    return null;
}
