import { cardmarketComparisonKey, cardmarketRawCondition } from "./cardmarket.ts";
import { cardLanguageStatus } from "./card-language.ts";
import { releaseIssue } from "./base-set-release.ts";
import { CONDITION_NAMES, isRawCondition } from "./conditions.ts";
import { printingName, readyForPricing } from "./identity.ts";
import { listingEvidenceKey, searchPhotosFitDetails } from "./listing-evidence.ts";
import { isUsableRawPrice, tcgplayerComparison, unsupportedVariantReason } from "./money/price-evidence.ts";
import { deeperPhotoConcerns } from "./photo-review.ts";
import { observedCardKind, obscuredDisclosedWear } from "./photo-evidence.ts";
import { currentPriceEvidence, maxPriceEvidenceAge } from "./pricing-freshness.ts";
import { observedSoldSales, type ObservedSale } from "./sales-activity.ts";
import { verifiedSlabMarketKey } from "./slab-market.ts";
import { median, soldMarketPrice, usableSoldReference } from "./sold-evidence.ts";
import type { CompSummary, Evaluation, ListingSummary, ScreeningSoldReference, SoldSaleType } from "./types.ts";

export interface TileSale { price: number; soldAt: string; title: string; url: string; method: SoldSaleType }
function tileSales(sales: ObservedSale[]): TileSale[] {
    return sales.map(({ id, price, at, sale }) => ({ price, soldAt: new Date(at).toISOString(), title: sale.title,
        url: "https://www.ebay.com/itm/" + id, method: sale.saleType! }));
}

export function screeningSaleGroups(references: ScreeningSoldReference[], now: number) {
    return references.flatMap(ref => {
        if (!usableSoldReference(ref, Boolean(ref.grader))) return [];
        const sales = observedSoldSales(ref.summary.sales ?? [], now, { maxDays: ref.summary.windowDays, slab: Boolean(ref.grader) });
        if (!sales.length) return [];
        const condition = ref.grader ? ref.grader + " " + ref.grade : ref.condition ? CONDITION_NAMES[ref.condition] : "Raw · condition unspecified";
        const scope = [ref.name, ref.cardNumber, ref.set, printingName(ref.printing), ref.finish.replaceAll("_", " ").toLowerCase(), condition].join(" · ");
        return [{ scope, sales: tileSales(sales), median: median(sales.map(s => s.price)), days: ref.summary.windowDays!,
            validUntil: sales[sales.length - 1].at + ref.summary.windowDays! * 86_400_000 + 1 }];
    }).sort((a, b) => b.sales[0].soldAt.localeCompare(a.sales[0].soldAt));
}

export interface ProviderPrice {
    source: string;
    basis: string;
    price: number;
    currency: "USD" | "EUR";
    asOf: string;
    validUntil: number;
    url?: string;
}
// Covers mapped guides and a web search that independently cited the same provider.
export function buyerVisiblePrice(row: { source?: string; url?: string }) {
    return row.source !== "PriceCharting" && !/^https?:\/\/(?:[a-z0-9-]+\.)*pricecharting\.com(?:[/?#]|$)/i.test(row.url ?? "");
}
export interface BuyerPriceComparison {
    recheckedSales?: boolean;
    priceChartingHistory?: { scope: string; sales: { date: string; priceUsd: number; url: string }[] };
    market: string;
    prices: ProviderPrice[];
    notes: string[];
    context?: string[];
    silphHistory?: { points: import("./price-history.ts").DailyPrice[]; sales: { date: string | null; priceUsd: number; url: string }[] };
    saleGroups?: ReturnType<typeof screeningSaleGroups>;
}
export interface ListingMarketPrices {
    soldChecked?: boolean;
    cardmarketConditionUnsupported?: boolean;
    trend?: string;
    verifiedComparable?: import("./money/relist-estimate.ts").ComparableAsk;
    flipResale?: { current: number; expected: number; competitor: import("./money/relist-estimate.ts").ComparableAsk | null };
    lookup?: { listingId: string; market: string };
    printing?: string;
    additional?: ProviderPrice[];
    scope: string;
    validUntil: number;
    sold?: { price: number; filteredMean?: boolean; average?: { count: number; fixedPrice: boolean; days: number }; count: number; days: number; sales30?: number; typicalRange?: [number, number]; sellerCondition: boolean; latestSale?: string; validUntil?: number; sales?: TileSale[] };
    tcg?: { market?: number; delivered?: number; condition: string; checkedAt?: string; marketRecordAt?: string | null; snapshotAt?: string; validUntil?: number; offerValidUntil?: number };
}

// These comparisons describe the photographed copy. They do not assign a
// condition to another listing or change its purchase recommendation.
export function listingMarketPrices(e: Evaluation | null | undefined, listing: Pick<ListingSummary, "id" | "title" | "images">, now: number): ListingMarketPrices | undefined {
    if (!e || e.listing.id !== listing.id || e.listing.title.trim() !== listing.title.trim() ||
        !searchPhotosFitDetails(listing.images, e.listing.photos ?? []) || !readyForPricing(e.identity) ||
        e.identity?.notThisCard || releaseIssue(e) || unsupportedVariantReason(e) || deeperPhotoConcerns(e).length || obscuredDisclosedWear(e) ||
        e.photoCheck?.cardMatch?.verdict === "MISMATCH" ||
        cardLanguageStatus("", [e.identity?.language, e.photoCheck?.cardIdentity?.language]) !== "ENGLISH" ||
        cardLanguageStatus(listing.title, [e.listing.aspects.Language]) === "OTHER") return;
    const kind = observedCardKind(e);
    const checked = Date.parse(e.pricesCheckedAt ?? "");
    const expiry = checked + maxPriceEvidenceAge(e);
    const hasPrices = checked <= now && now < expiry && currentPriceEvidence(e, checked);
    if (!hasPrices && (!e.identity?.recordId || !e.photoCheck?.images.some(photo => photo.usable && !photo.isStockImage))) return;
    const validUntil = hasPrices ? expiry : now + 300_000;
    let scope: string;
    let summary: CompSummary | undefined;
    let sellerCondition = false;
    let tcg: ListingMarketPrices["tcg"];
    const wear = e.condition?.rawCondition;
    if (kind === "graded") {
        const pricing = e.slabPricing;
        if (!verifiedSlabMarketKey(e, { allowScratchedCase: true }) || !e.slab) return;
        if (hasPrices && pricing?.printing === e.identity!.printing && pricing.grader === e.slab.grader && String(pricing.grade) === e.slab.grade &&
            pricing.summary?.grader === e.slab.grader && String(pricing.summary.grade) === e.slab.grade) summary = pricing.summary;
        scope = `${e.slab.grader} ${e.slab.grade}`;
    } else {
        if (kind !== "raw" || !isRawCondition(wear) || e.condition?.authenticity.concern !== "NONE_SEEN" || !["HOLO", "REVERSE_HOLO", "NON_HOLO"].includes(e.identity!.finish)) return;
        const raw = hasPrices && e.rawPricing?.printing === e.identity!.printing && e.rawPricing.finish === e.identity!.finish ? e.rawPricing : null;
        scope = CONDITION_NAMES[wear];
        const rows = raw?.prices?.filter(r => r.condition === wear && isUsableRawPrice(r)) ?? [];
        const reference = tcgplayerComparison(e.rawPricing);
        const quote = reference?.condition === wear && e.rawPricing?.printing === e.identity!.printing &&
            e.rawPricing.finish === e.identity!.finish && reference.printing === e.rawPricing.variant
            ? reference : rows.find(r => r.basis?.startsWith("TCGPLAYER_"))?.offers;
        if (quote && quote.source === "TCGPLAYER" && quote.currency === "USD" && Array.isArray(quote.offers) &&
            Number.isFinite(Date.parse(quote.checkedAt)) && quote.offers.every(offer => Number.isFinite(offer.total) && offer.total > 0)) {
            tcg = { condition: quote.marketCondition, checkedAt: quote.checkedAt, marketRecordAt: quote.marketRecordAt,
                snapshotAt: quote.snapshotAt, validUntil: Date.parse(quote.checkedAt) + 6 * 3_600_000 };
            if (Number.isFinite(quote.marketPrice) && quote.marketPrice! > 0) tcg.market = quote.marketPrice;
            if (quote.offers.length) {
                tcg.delivered = Math.min(...quote.offers.map(offer => offer.total));
                tcg.offerValidUntil = Math.min(tcg.validUntil!, Date.parse(quote.snapshotAt) + 86_400_000);
            }
        }
        summary = rows.find(r => r.comps?.count)?.comps ?? raw?.ebayComps?.find(s => s.grader === "RAW" && s.grade === wear);
    }
    const soldRows = (s: CompSummary | null | undefined, seller: boolean, activity = false) => {
        if (!s || kind === "raw" && (s.grader !== "RAW" || s.grade !== wear)) return [];
        const sales = (activity ? s.activitySales ?? s.sales : s.sales).filter(sale => kind === "graded" || (seller
            ? sale.sellerCondition === wear : sale.photoCondition === wear && sale.conditionEvidence?.length));
        return observedSoldSales(sales, now, { maxDays: s.windowDays ?? 90, slab: kind === "graded" });
    };
    const soldChecked = Boolean(summary);
    let sales = soldRows(summary, false);
    if (hasPrices && !sales.length && kind === "raw" && e.rawPricing?.printing === e.identity!.printing && e.rawPricing?.finish === e.identity!.finish) {
        summary = e.rawPricing?.sellerConditionComps ?? undefined;
        sales = soldRows(summary, true);
        sellerCondition = true;
    }
    const days = summary?.windowDays ?? 90;
    const sampleUntil = Math.min(validUntil, ...sales.map(s => s.at + days * 86_400_000 + 1));
    const sales30 = soldRows(summary, sellerCondition, true).filter(row => now - row.at <= 30 * 86_400_000).length;
    const recentPrices = sales.filter(row => now - row.at <= 30 * 86_400_000).map(row => row.price).sort((a, b) => a - b);
    const quartile = (fraction: number) => {
        const rank = (recentPrices.length - 1) * fraction;
        return recentPrices[Math.floor(rank)] + (recentPrices[Math.ceil(rank)] - recentPrices[Math.floor(rank)]) * (rank % 1);
    };
    const medianPrice = sales.length ? median(sales.map(sale => sale.price)) : undefined;
    const estimate = summary?.marketEstimate && summary.count === sales.length && sales.length ? soldMarketPrice(summary) : null;
    const additional: ProviderPrice[] = [];
    const method = summary?.marketEstimate;
    const average = estimate !== null && !sellerCondition && method?.sampleSize && ["FIXED_PRICE_AVERAGE", "SOLD_AVERAGE", "FILTERED_SOLD_MEAN"].includes(method.method)
        ? { count: method.sampleSize, fixedPrice: method.method === "FIXED_PRICE_AVERAGE", days: method.windowDays ?? days } : undefined;
    const filteredMean = estimate !== null && kind === "raw" && !sellerCondition && Boolean(summary?.marketEstimate);
    if (!filteredMean && estimate && estimate !== medianPrice) additional.push({ source: "eBay", basis: "Resale estimate from matched sales",
        price: estimate, currency: "USD", asOf: new Date(sales[0].at).toISOString(), validUntil: sampleUntil });
    const market = JSON.stringify([cardmarketComparisonKey(e), e.answeredAt, e.pricesCheckedAt,
        listingEvidenceKey({ title: e.listing.title, images: e.listing.photos ?? [] })]);
    const ended = e.listing.availability === "UNAVAILABLE" || Date.parse(e.listing.endTime ?? "") <= now;
    return { scope, additional, printing: printingName(e.identity!.printing), ...(ended ? {} : { lookup: { listingId: listing.id, market } }),
        ...(soldChecked && { soldChecked: true }),
        ...(kind === "raw" && isRawCondition(wear) && !cardmarketRawCondition(wear) && { cardmarketConditionUnsupported: true }),
        validUntil, tcg, sold: sales.length ? {
        latestSale: new Date(sales[0].at).toISOString(), validUntil: sampleUntil, sales: tileSales(sales),
        price: filteredMean ? estimate! : medianPrice!, ...(filteredMean && { filteredMean }), ...(average && { average }), count: sales.length, days, sellerCondition, sales30,
        ...(recentPrices.length >= 4 && { typicalRange: [quartile(0.25), quartile(0.75)] }),
    } : undefined };
}
