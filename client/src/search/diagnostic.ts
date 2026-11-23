import type { SearchDiagnosticRow } from "../../../shared/search-diagnostic.ts";
import type { AnalysisState } from "../analysis-state";
import type { ListingSummary } from "../types";
import { evaluationOf, type ResultGroups } from "./results";

type Reason = SearchDiagnosticRow["reason"];

export function searchDiagnosticRows(
    listings: ListingSummary[],
    analyses: Record<string, AnalysisState>,
    groups: ResultGroups,
    listingBlock: (listing: ListingSummary) => Reason | null,
    waitingReason: Reason,
): SearchDiagnosticRow[] {
    const deals = new Set(groups.deals.map(listing => listing.id));
    const losses = new Set(groups.losses.map(listing => listing.id));
    const review = new Set(groups.review.map(listing => listing.id));
    const matching = new Set(groups.all.map(listing => listing.id));
    return listings.map((listing) => {
        const { id } = listing;
        const analysis = analyses[id];
        const evaluation = evaluationOf(analysis);
        if (!evaluation) {
            if (analysis?.status === "error") return { id, outcome: "FAILED", reason: "ASSESSMENT_FAILED" };
            const block = listingBlock(listing);
            const reason = block === "SOLD_EVIDENCE_MISSING" && !listing.screen?.soldEvidence?.exactScope
                ? "EXACT_MARKET_UNCONFIRMED" : block;
            return { id, outcome: "SKIPPED", reason: reason ?? waitingReason };
        }

        const best = evaluation.underwriting?.best;
        const photoChecked = Boolean(evaluation.photoCheck);
        const priced = !evaluation.underwriting?.shippingUnconfirmed && best?.status === "PRICED" && Number.isFinite(best.profit);
        const row = { id, photoChecked, priced, ...(priced ? { profit: best.profit } : {}) };
        if (deals.has(id)) return { ...row, outcome: "DEAL", reason: "DEAL_CONFIRMED" };
        if (losses.has(id)) return { ...row, outcome: "LOSS", reason: "NET_LOSS" };
        if (listing.availability === "UNAVAILABLE" || evaluation.listing.availability === "UNAVAILABLE") {
            return { ...row, outcome: "SKIPPED", reason: "UNAVAILABLE" };
        }
        if (listing.match || evaluation.identity?.notThisCard) {
            return { ...row, outcome: "SKIPPED", reason: listing.match === "OTHER_LANGUAGE" ? "OTHER_LANGUAGE" : "CRITERIA_MISMATCH" };
        }
        if (!matching.has(id)) {
            return { ...row, outcome: "SKIPPED", reason: listingBlock(listing) ?? "CRITERIA_MISMATCH" };
        }
        if (evaluation.identity?.status === "NEEDS_REVIEW" && !evaluation.pricingDeferred?.identityLookupPending) {
            return { ...row, outcome: "REVIEW", reason: "IDENTITY_UNRESOLVED" };
        }
        if (evaluation.slab?.status === "NEEDS_REVIEW") return { ...row, outcome: "REVIEW", reason: "SLAB_LABEL_UNRESOLVED" };
        if (review.has(id) && evaluation.underwriting?.verdict !== "CANT_PRICE") {
            return { ...row, outcome: "REVIEW", reason: "MATERIAL_REVIEW" };
        }
        if (evaluation.underwriting?.shippingUnconfirmed) return { ...row, outcome: "UNPRICED", reason: "SHIPPING_UNCONFIRMED" };
        if (evaluation.pricingDeferred) return { ...row, outcome: "UNPRICED", reason: "PRICING_DEFERRED" };
        if (priced) return { ...row, outcome: "PRICED", reason: "TARGETS_NOT_MET" };
        return { ...row, outcome: "UNPRICED", reason: "PRICE_EVIDENCE_UNAVAILABLE" };
    });
}
