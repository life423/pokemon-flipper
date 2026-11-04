import type { Evaluation, PricedPath } from "../types.ts";
import { jungleNoSymbolReason, type JungleVariantContext } from "../jungle-no-symbol.ts";

type PriceEvidence = Partial<Pick<Evaluation, "rawPricing" | "slabPricing">> & JungleVariantContext;

// A market quote or a competing ask can inform an estimate, but cannot
// establish an executable eBay resale price. Keep legacy prices without a
// basis readable; current pricing writers explicitly identify their basis.
// Already matched sold prices retain their existing sparse-sale policy:
// one or two eligible sales may price a route at LOW confidence.
export function referencePriceReason(evaluation: PriceEvidence, path: PricedPath): string | null {
    const variant = jungleNoSymbolReason(evaluation);
    if (variant) return variant;
    if (path.path === "RAW") {
        const quote = evaluation.rawPricing?.prices?.find(price => price.condition === path.priceCondition);
        if (quote?.basis === "TCGPLAYER") return "Raw resale has only a TCGplayer market estimate at the selected condition; a matched eBay sold price is still needed.";
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
    const variant = jungleNoSymbolReason(evaluation);
    if (variant) return variant;
    if (underwriting.verdict.startsWith("BUY")) return underwriting.best ? referencePriceReason(evaluation, underwriting.best) : null;
    for (const path of underwriting.paths ?? []) {
        if (path.status === "PRICED") {
            const reason = referencePriceReason(evaluation, path);
            if (reason) return reason;
        }
    }
    return null;
}
