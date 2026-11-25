import { releaseIssue } from "./base-set-release.ts";
import { CONDITION_NAMES, isRawCondition } from "./conditions.ts";
import { readyForPricing } from "./identity.ts";
import { searchPhotosFitDetails } from "./listing-evidence.ts";
import { isUsableRawPrice, unsupportedVariantReason } from "./money/price-evidence.ts";
import { observedCardKind } from "./photo-evidence.ts";
import { currentPriceEvidence, maxPriceEvidenceAge } from "./pricing-freshness.ts";
import { observedSoldSales } from "./sales-activity.ts";
import { verifiedSlabMarketKey } from "./slab-market.ts";
import { median } from "./sold-evidence.ts";
import type { CompSummary, Evaluation, ListingSummary } from "./types.ts";

export interface ListingMarketPrices {
    scope: string;
    validUntil: number;
    sold?: { price: number; count: number; days: number; sellerCondition: boolean };
    tcg?: { market?: number; delivered?: number; condition: string };
}

// These comparisons describe the photographed copy. They do not assign a
// condition to another listing or change its purchase recommendation.
export function listingMarketPrices(e: Evaluation | null | undefined, listing: ListingSummary, now: number): ListingMarketPrices | undefined {
    if (!e || e.listing.id !== listing.id || e.listing.title.trim() !== listing.title.trim() ||
        !searchPhotosFitDetails(listing.images, e.listing.photos ?? []) || !readyForPricing(e.identity) ||
        e.identity?.notThisCard || releaseIssue(e) || unsupportedVariantReason(e) ||
        e.photoCheck?.cardMatch?.verdict === "MISMATCH" || !currentPriceEvidence(e, now)) return;
    const kind = observedCardKind(e);
    let validUntil = Date.parse(e.pricesCheckedAt!) + maxPriceEvidenceAge(e);
    let scope: string;
    let summary: CompSummary | undefined;
    let sellerCondition = false;
    let tcg: ListingMarketPrices["tcg"];
    const wear = e.condition?.rawCondition;
    if (kind === "graded") {
        const pricing = e.slabPricing;
        if (!verifiedSlabMarketKey(e, { allowScratchedCase: true }) || !e.slab || pricing?.printing !== e.identity!.printing ||
            pricing?.grader !== e.slab.grader || String(pricing?.grade) !== e.slab.grade ||
            pricing?.summary?.grader !== e.slab.grader || String(pricing.summary.grade) !== e.slab.grade) return;
        summary = pricing.summary;
        scope = `${e.slab.grader} ${e.slab.grade}`;
    } else {
        const raw = e.rawPricing;
        if (kind !== "raw" || !isRawCondition(wear) || e.condition?.authenticity.concern !== "NONE_SEEN" ||
            !raw || raw.printing !== e.identity!.printing || !raw.finish || raw.finish !== e.identity!.finish) return;
        scope = CONDITION_NAMES[wear];
        const row = raw.prices?.find(r => r.condition === wear && isUsableRawPrice(r));
        const quote = row?.offers;
        if (quote && row?.basis?.startsWith("TCGPLAYER_")) {
            tcg = { condition: quote.marketCondition };
            if (Number.isFinite(quote.marketPrice) && quote.marketPrice! > 0) tcg.market = quote.marketPrice;
            if (quote.offers.length) {
                tcg.delivered = Math.min(...quote.offers.map(offer => offer.total));
                validUntil = Math.min(validUntil, Date.parse(quote.snapshotAt) + 86_400_000);
            }
            validUntil = Math.min(validUntil, Date.parse(quote.checkedAt) + 6 * 3_600_000);
        }
        summary = row?.comps ?? raw.ebayComps?.find(s => s.grader === "RAW" && s.grade === wear);
    }
    const soldRows = (s: CompSummary | null | undefined, seller: boolean) => {
        if (!s || kind === "raw" && (s.grader !== "RAW" || s.grade !== wear)) return [];
        const sales = s.sales.filter(sale => kind === "graded" || (seller
            ? sale.sellerCondition === wear : sale.photoCondition === wear && sale.conditionEvidence?.length));
        return observedSoldSales(sales, now, { maxDays: s.windowDays ?? 90, slab: kind === "graded" });
    };
    let sales = soldRows(summary, false);
    if (!sales.length && kind === "raw") {
        summary = e.rawPricing?.sellerConditionComps ?? undefined;
        sales = soldRows(summary, true);
        sellerCondition = true;
    }
    if (!sales.length && !tcg) return;
    const days = summary?.windowDays ?? 90;
    if (sales.length) validUntil = Math.min(validUntil, ...sales.map(s => s.at + days * 86_400_000 + 1));
    return { scope, validUntil, tcg, sold: sales.length ? {
        price: median(sales.map(sale => sale.price)), count: sales.length, days, sellerCondition,
    } : undefined };
}
