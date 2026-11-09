import type { Evaluation, PricedPath, RawPrice } from "../types.ts";
import { jungleNoSymbolReason, type JungleVariantContext } from "../jungle-no-symbol.ts";
import { missingTextureReason } from "../grade-qualifier.ts";

type PriceEvidence = Partial<Pick<Evaluation, "rawPricing" | "slabPricing">> & JungleVariantContext;

export function unsupportedVariantReason(input: JungleVariantContext): string | null {
    return missingTextureReason(input.listing?.title) ?? jungleNoSymbolReason(input);
}

// Keep accepted photo facts while removing prices from an ordinary market
// that cannot price this variant, including saved financial snapshots.
export function withoutUnsupportedVariantPrices(evaluation: Evaluation): Evaluation {
    const reason = unsupportedVariantReason(evaluation);
    if (!reason) return evaluation;
    const unavailable = { status: "PRICE_UNAVAILABLE" as const, reason };
    return { ...evaluation, rawPricing: evaluation.rawPricing ? unavailable : null,
        gradedPricing: evaluation.gradedPricing ? Object.fromEntries(Object.keys(evaluation.gradedPricing).map(grader => [grader, unavailable])) : null,
        slabPricing: evaluation.slab || evaluation.slabPricing ? unavailable : null };
}

// Older snapshots may omit the basis. Only an accompanying sold summary
// for the same condition and amount can establish their provenance.
export function isRawSoldPrice(price: RawPrice): boolean {
    return Number.isFinite(price.price) && price.price > 0 && (price.basis === "EBAY_SOLD" ||
        price.basis === undefined && price.comps?.grader === "RAW" && price.comps.grade === price.condition &&
        price.comps.count > 0 && price.comps.median === price.price);
}

export function withoutUnsupportedRawPrices(evaluation: Evaluation): Evaluation {
    const raw = evaluation.rawPricing;
    if (!raw?.prices?.some(price => !isRawSoldPrice(price))) return evaluation;
    const prices = raw.prices.filter(isRawSoldPrice);
    const { evidenceNote, ...saved } = raw;
    return { ...evaluation, rawPricing: prices.length ? { ...saved, prices } : {
        ...saved, status: "PRICE_UNAVAILABLE", prices: [], reason: "No matched eBay sold price is available.",
    } };
}

export function referencePriceReason(evaluation: PriceEvidence, path: PricedPath): string | null {
    const variant = unsupportedVariantReason(evaluation);
    if (variant) return variant;
    if (path.path === "RAW") {
        const sold = evaluation.rawPricing?.prices?.some(price => price.condition === path.priceCondition &&
            price.price === path.salePrice && isRawSoldPrice(price));
        if (!sold) return "Raw resale needs a matched eBay sold price.";
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
    // Terminal fake/unavailable decisions have no financial route to defer.
    if (underwriting.verdict === "PASS" && !underwriting.best) return null;
    const variant = unsupportedVariantReason(evaluation);
    if (variant) return variant;
    if (underwriting.verdict.startsWith("BUY")) return underwriting.best ? referencePriceReason(evaluation, underwriting.best) : null;
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
