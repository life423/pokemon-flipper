import { cardmarketComparisonKey } from "./cardmarket.ts";
import { cardLanguageStatus } from "./card-language.ts";
import { releaseIssue } from "./base-set-release.ts";
import { CONDITION_NAMES, isRawCondition } from "./conditions.ts";
import { printingName, readyForPricing } from "./identity.ts";
import { listingEvidenceKey, searchPhotosFitDetails } from "./listing-evidence.ts";
import { isUsableRawPrice, unsupportedVariantReason } from "./money/price-evidence.ts";
import { deeperPhotoConcerns } from "./photo-review.ts";
import { observedCardKind, obscuredDisclosedWear } from "./photo-evidence.ts";
import { currentPriceEvidence, maxPriceEvidenceAge } from "./pricing-freshness.ts";
import { observedSoldSales } from "./sales-activity.ts";
import { verifiedSlabMarketKey } from "./slab-market.ts";
import { median, soldMarketPrice } from "./sold-evidence.ts";
import type { CompSummary, Evaluation, ListingSummary } from "./types.ts";

export interface ProviderPrice {
    source: string;
    basis: string;
    price: number;
    currency: "USD" | "EUR";
    asOf: string;
    validUntil: number;
    url?: string;
}
export interface BuyerPriceComparison {
    market: string;
    prices: ProviderPrice[];
    notes: string[];
}
export interface ListingMarketPrices {
    lookup?: { listingId: string; market: string };
    printing?: string;
    additional?: ProviderPrice[];
    scope: string;
    validUntil: number;
    sold?: { price: number; count: number; days: number; sellerCondition: boolean; latestSale?: string; validUntil?: number };
    tcg?: { market?: number; delivered?: number; condition: string; checkedAt?: string; marketRecordAt?: string | null; snapshotAt?: string; validUntil?: number; offerValidUntil?: number };
}

// These comparisons describe the photographed copy. They do not assign a
// condition to another listing or change its purchase recommendation.
export function listingMarketPrices(e: Evaluation | null | undefined, listing: Pick<ListingSummary, "id" | "title" | "images">, now: number): ListingMarketPrices | undefined {
    if (!e || e.listing.id !== listing.id || e.listing.title.trim() !== listing.title.trim() ||
        !searchPhotosFitDetails(listing.images, e.listing.photos ?? []) || !readyForPricing(e.identity) ||
        e.identity?.notThisCard || releaseIssue(e) || unsupportedVariantReason(e) || deeperPhotoConcerns(e).length || obscuredDisclosedWear(e) ||
        e.photoCheck?.cardMatch?.verdict === "MISMATCH" || !currentPriceEvidence(e, Date.parse(e.pricesCheckedAt ?? "")) ||
        cardLanguageStatus("", [e.identity?.language, e.photoCheck?.cardIdentity?.language]) !== "ENGLISH" ||
        cardLanguageStatus(listing.title, [e.listing.aspects.Language]) === "OTHER") return;
    const kind = observedCardKind(e);
    const checked = Date.parse(e.pricesCheckedAt!);
    const validUntil = checked + maxPriceEvidenceAge(e);
    if (!(checked <= now && now < validUntil)) return;
    let scope: string;
    let summary: CompSummary | undefined;
    let sellerCondition = false;
    let tcg: ListingMarketPrices["tcg"];
    const wear = e.condition?.rawCondition;
    if (kind === "graded") {
        const pricing = e.slabPricing;
        if (!verifiedSlabMarketKey(e, { allowScratchedCase: true }) || !e.slab) return;
        if (pricing?.printing === e.identity!.printing && pricing.grader === e.slab.grader && String(pricing.grade) === e.slab.grade &&
            pricing.summary?.grader === e.slab.grader && String(pricing.summary.grade) === e.slab.grade) summary = pricing.summary;
        scope = `${e.slab.grader} ${e.slab.grade}`;
    } else {
        if (kind !== "raw" || !isRawCondition(wear) || e.condition?.authenticity.concern !== "NONE_SEEN" || !["HOLO", "REVERSE_HOLO", "NON_HOLO"].includes(e.identity!.finish)) return;
        const raw = e.rawPricing?.printing === e.identity!.printing && e.rawPricing.finish === e.identity!.finish ? e.rawPricing : null;
        scope = CONDITION_NAMES[wear];
        const row = raw?.prices?.find(r => r.condition === wear && isUsableRawPrice(r));
        const quote = row?.offers;
        if (quote && row?.basis?.startsWith("TCGPLAYER_")) {
            tcg = { condition: quote.marketCondition, checkedAt: quote.checkedAt, marketRecordAt: quote.marketRecordAt,
                snapshotAt: quote.snapshotAt, validUntil: Date.parse(quote.checkedAt) + 6 * 3_600_000 };
            if (Number.isFinite(quote.marketPrice) && quote.marketPrice! > 0) tcg.market = quote.marketPrice;
            if (quote.offers.length) {
                tcg.delivered = Math.min(...quote.offers.map(offer => offer.total));
                tcg.offerValidUntil = Math.min(tcg.validUntil!, Date.parse(quote.snapshotAt) + 86_400_000);
            }
        }
        summary = row?.comps ?? raw?.ebayComps?.find(s => s.grader === "RAW" && s.grade === wear);
    }
    const soldRows = (s: CompSummary | null | undefined, seller: boolean) => {
        if (!s || kind === "raw" && (s.grader !== "RAW" || s.grade !== wear)) return [];
        const sales = s.sales.filter(sale => kind === "graded" || (seller
            ? sale.sellerCondition === wear : sale.photoCondition === wear && sale.conditionEvidence?.length));
        return observedSoldSales(sales, now, { maxDays: s.windowDays ?? 90, slab: kind === "graded" });
    };
    let sales = soldRows(summary, false);
    if (!sales.length && kind === "raw" && e.rawPricing?.printing === e.identity!.printing && e.rawPricing?.finish === e.identity!.finish) {
        summary = e.rawPricing?.sellerConditionComps ?? undefined;
        sales = soldRows(summary, true);
        sellerCondition = true;
    }
    const days = summary?.windowDays ?? 90;
    const sampleUntil = Math.min(validUntil, ...sales.map(s => s.at + days * 86_400_000 + 1));
    const medianPrice = sales.length ? median(sales.map(sale => sale.price)) : undefined;
    const estimate = summary?.marketEstimate && summary.count === sales.length && sales.length ? soldMarketPrice(summary) : null;
    const additional: ProviderPrice[] = [];
    if (estimate && estimate !== medianPrice) additional.push({ source: "eBay", basis: "Resale estimate from matched sales",
        price: estimate, currency: "USD", asOf: new Date(sales[0].at).toISOString(), validUntil: sampleUntil });
    const market = JSON.stringify([cardmarketComparisonKey(e), e.answeredAt, e.pricesCheckedAt,
        listingEvidenceKey({ title: e.listing.title, images: e.listing.photos ?? [] })]);
    const ended = e.listing.availability === "UNAVAILABLE" || Date.parse(e.listing.endTime ?? "") <= now;
    return { scope, additional, printing: printingName(e.identity!.printing), ...(ended ? {} : { lookup: { listingId: listing.id, market } }),
        validUntil, tcg, sold: sales.length ? {
        latestSale: new Date(sales[0].at).toISOString(), validUntil: sampleUntil,
        price: medianPrice!, count: sales.length, days, sellerCondition,
    } : undefined };
}
