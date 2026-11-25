import type { SearchDiagnosticRow } from "../../../shared/search-diagnostic.ts";
import { isBuyerWaitReason, type BuyerListingReview } from "../../../shared/wait-skip-review.ts";
import type { AnalysisState } from "../analysis-state";
import type { ListingSummary } from "../types";
import { evaluationOf, type ResultGroups } from "./results";

type Reason = SearchDiagnosticRow["reason"];

export const listingsInDiagnosticBatch = (listings: readonly ListingSummary[], owners: ReadonlyMap<string, string>, id: string) =>
    listings.filter(listing => owners.get(listing.id) === id);

export function searchDiagnosticRows(
    listings: ListingSummary[],
    analyses: Record<string, AnalysisState>,
    groups: ResultGroups,
    listingBlock: (listing: ListingSummary) => Reason | null,
    waitingReason: Reason,
    buyerDecisions: Readonly<Record<string, Pick<BuyerListingReview, "decision" | "reason" | "waitReason" | "verifiedPurchase"> & { unavailable?: boolean }>> = {},
): SearchDiagnosticRow[] {
    const deals = new Set(groups.deals.map(listing => listing.id));
    const losses = new Set(groups.losses.map(listing => listing.id));
    const review = new Set(groups.review.map(listing => listing.id));
    const matching = new Set(groups.all.map(listing => listing.id));
    return listings.map((listing) => {
        const { id } = listing;
        const analysis = analyses[id];
        const evaluation = evaluationOf(analysis);
        const checked = buyerDecisions[id];
        if (checked?.decision === "WAIT" || checked?.decision === "SKIP") {
            // A fresh buyer decision may reject an old positive margin. Only
            // retain a priced outcome when the reviewed row is still a loss.
            const evidence = { id, photoChecked: Boolean(evaluation?.photoCheck) };
            if (checked.unavailable) return { ...evidence, outcome: "FAILED", reason: "BUYER_CHECK_UNAVAILABLE" };
            if (checked.decision === "WAIT") return { ...evidence, outcome: "WAIT", reason: isBuyerWaitReason(checked.waitReason) ? checked.waitReason : "BUYER_WAIT" };
            const best = evaluation?.underwriting?.best;
            if (losses.has(id) && best?.status === "PRICED" && best.profit < 0 && Number.isFinite(best.profit)) {
                return { ...evidence, outcome: "LOSS", reason: "BUYER_SKIP", priced: true, profit: best.profit };
            }
            return { ...evidence, outcome: "SKIP", reason: "BUYER_SKIP" };
        }
        if (!evaluation) {
            if (analysis?.status === "held") return { id, outcome: "SKIPPED", reason: "AI_EVIDENCE_HELD" };
            if (analysis?.status === "inconclusive") return { id, outcome: "REVIEW", reason: "PHOTO_EVIDENCE_INCONSISTENT" };
            if (analysis?.status === "error") return { id, outcome: "FAILED", reason: "ASSESSMENT_FAILED" };
            const block = listingBlock(listing);
            const reason = block === "SOLD_EVIDENCE_MISSING" && !listing.screen?.soldEvidence?.exactScope
                ? "EXACT_MARKET_UNCONFIRMED" : block;
            return { id, outcome: "SKIPPED", reason: reason ?? waitingReason };
        }

        const best = checked?.decision === "BUY" ? checked.verifiedPurchase?.path : evaluation.underwriting?.best;
        const photoChecked = Boolean(evaluation.photoCheck);
        const priced = !evaluation.underwriting?.shippingUnconfirmed && best?.status === "PRICED" && Number.isFinite(best.profit);
        const row = { id, photoChecked, priced, ...(priced ? { profit: best.profit } : {}) };
        if (deals.has(id)) return { ...row, outcome: "DEAL", reason: priced && checked?.decision === "BUY" ? "BUYER_BUY" : "DEAL_CONFIRMED" };
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
