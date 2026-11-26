import type { BuyerListingReview } from "../../../shared/wait-skip-review.ts";
import type { CompSummary, Evaluation, ListingSummary, RatingLevel, SearchIntent, Targets } from "../types.ts";
import type { AnalysisState } from "../analysis-state.ts";
import { canAutoAnalyze, meetsMinimumGrade, resultGroup, type ResultGroup } from "../../../shared/analysis.ts";
import { compareAnalysisPriority } from "../../../shared/analysis-priority.ts";
import { evaluatedCriteriaMismatch } from "../../../shared/search-criteria.ts";
import { rateDeal } from "../../../shared/money/rating.ts";
import { applyVerifiedPurchase } from "../../../shared/money/verified-purchase.ts";
import { compareListingEvidence, listingSignals } from "../../../shared/signals.ts";
import { matchesListingFilters, withinAutomaticAuctionWindow } from "../../../shared/listing-filters.ts";
import { cardLanguageStatus, englishListingEligible } from "../../../shared/card-language.ts";
import { deeperPhotoConcerns, photoReviewStatus } from "../../../shared/photo-review.ts";
import { isRawSoldPrice, priceEvidenceGap, referencePriceReason, unsupportedVariantReason } from "../../../shared/money/price-evidence.ts";
import { acquisitionCost } from "../../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../../shared/money/config.ts";
import { cents } from "../../../shared/money/cents.ts";
import { numbersAtOffer, offerFor } from "../../../shared/money/offer.ts";
import { currentPriceEvidence } from "../../../shared/pricing-freshness.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS, type SearchCompetition } from "../../../shared/search-diagnostic.ts";
import { CONDITION_NAMES, conditionGap, isRawCondition, sellerDisclosedCreasing, type RawCondition } from "../../../shared/conditions.ts";
import { isPrinting } from "../../../shared/identity.ts";
import { soldMarketPrice } from "../../../shared/sold-evidence.ts";
import { obscuredDisclosedWear, observedCardKind, photoCoverage } from "../../../shared/photo-evidence.ts";
import { parseListingLink } from "../../../shared/listing-link.ts";
import { lowestQuotedOffer } from "../../../shared/listed-offer.ts";

export type View = ResultGroup | "all" | "new" | "losses" | "bids";

export type SortKey = "best" | "overlooked" | "ending" | "priceLow" | "priceHigh";
export type TypeFilter = "all" | "AUCTION" | "FIXED_PRICE";
export type KindFilter = "all" | "raw" | "graded";

export type SearchPage = "search" | "shortlist" | "listing" | "sniper" | "camera";
export interface SearchFilters {
    typeFilter: TypeFilter;
    kindFilter: KindFilter;
    maxPrice: string;
    minPrice: string;
    minGrade: number;
}
interface ResultsContext {
    listings: ListingSummary[];
    analyses: Record<string, AnalysisState>;
    page: SearchPage;
    intent?: SearchIntent | null;
}
export type ResultGroups = Record<View, ListingSummary[]>;

const LEVEL_ORDER: Record<RatingLevel, number> = { STRONG: 0, GOOD: 1, THIN: 2 };
const currentRating = (evaluation: Evaluation | null) => evaluation?.rating && !Object.hasOwn(LEVEL_ORDER, evaluation.rating.level) ? rateDeal(evaluation) : evaluation?.rating;

export const evaluationOf = (analysis?: AnalysisState) => (analysis?.status === "done" ? analysis.evaluation : null);
const isDeal = (evaluation: Evaluation | null) => evaluation?.researchMode !== "DEFERRED_LOW_RESALE" && (evaluation?.underwriting?.verdict.startsWith("BUY") ?? false);

const SORTS: Record<Exclude<SortKey, "best" | "overlooked">, (a: ListingSummary, b: ListingSummary) => number> = {
    // Listings without an end date (most Buy It Now) go last.
    ending: (a, b) =>
        (a.endTime ? Date.parse(a.endTime) : Infinity) - (b.endTime ? Date.parse(b.endTime) : Infinity),
    priceLow: (a, b) => (a.currentPrice ?? Infinity) - (b.currentPrice ?? Infinity),
    priceHigh: (a, b) => (b.currentPrice ?? -Infinity) - (a.currentPrice ?? -Infinity),
};

export function filterSearchResults({ listings, analyses, filters: { typeFilter, kindFilter, maxPrice, minPrice, minGrade }, page, intent, now }: ResultsContext & { filters: SearchFilters; now: number }): ListingSummary[] {
    const limit = maxPrice === "" ? Infinity : Number(maxPrice);
    const floor = Number(minPrice) || 0;

    return listings
        // Another set, card, or printing than the one searched for, including
        // a reprint the photos gave away.
        .filter((listing) => !listing.match && !listing.screen?.junk && !evaluationOf(analyses[listing.id])?.identity?.notThisCard)
        .filter((listing) => englishListingEligible(listing, evaluationOf(analyses[listing.id])))
        .filter((listing) => {
            const evaluation = evaluationOf(analyses[listing.id]);
            return page !== "search" || !intent || !evaluation || !evaluatedCriteriaMismatch(evaluation, intent);
        })
        .filter((listing) => listing.availability !== "UNAVAILABLE" && (page !== "search" || withinAutomaticAuctionWindow(listing, now)))
        .filter((listing) => matchesListingFilters(listing, { typeFilter, kindFilter, maxPrice: limit, minPrice: floor }, evaluationOf(analyses[listing.id]), page === "search" ? intent?.graded : null))
        .filter((listing) => {
            const evaluation = evaluationOf(analyses[listing.id]);
            return !evaluation || meetsMinimumGrade(evaluation, minGrade);
        })
        .filter((listing) => !listing.endTime || Date.parse(listing.endTime) > now);
}

export function groupSearchResults(filtered: ListingSummary[], analyses: Record<string, AnalysisState>, includeOffers: boolean, newIds: ReadonlySet<string>, decisions: Readonly<Record<string, Pick<BuyerListingReview, "decision" | "offer" | "auctionOpportunity">>> = {}, checking?: ReadonlySet<string>, now = Date.now()): ResultGroups {
    const grouped: Record<ResultGroup, ListingSummary[]> = { deals: [], offers: [], candidates: [], review: [] };
    const losses: ListingSummary[] = [];
    const bids: ListingSummary[] = [];

    for (const listing of filtered) {
        const analysis = analyses[listing.id];
        const evaluation = evaluationOf(analysis);
        const group = analysis?.status === "done" && analysis.pricingExpired && !photoReviewStatus(evaluation).needsYourReview
            ? "candidates" : resultGroup(listing, evaluation, includeOffers, analysis?.status === "error" || analysis?.status === "inconclusive" || analysis?.status === "held", now);
        const decision = decisions[listing.id]?.decision;
        const opportunity = decisions[listing.id]?.auctionOpportunity;
        if (listing.buyingOption === "AUCTION" && decision === "WAIT" && opportunity?.listingId === listing.id &&
            opportunity.status === "BID" && opportunity.validUntil > now) bids.push(listing);
        else if (checking?.has(listing.id) && !decision) grouped.candidates.push(listing);
        else if (decision === "WAIT" && includeOffers && decisions[listing.id]?.offer && group === "offers") grouped.offers.push(listing);
        else if (decision === "WAIT" || decision === "SKIP") grouped.review.push(listing);
        else if (group) grouped[group].push(listing);
        const best = evaluation?.underwriting?.best;
        if (evaluation?.underwriting?.verdict === "PASS" && (group === null || group === "offers") &&
            evaluation.researchMode !== "DEFERRED_LOW_RESALE" && evaluation.listing.availability !== "UNAVAILABLE" &&
            best?.status === "PRICED" && Number.isFinite(best.profit) && best.profit < 0) losses.push(listing);
    }

    return { ...grouped, bids, losses, all: filtered, new: filtered.filter((listing) => newIds.has(listing.id)) };
}

export function sortSearchResults(listings: ListingSummary[], analyses: Record<string, AnalysisState>, sort: SortKey, targets: Targets, now: number,
    decisions: Readonly<Record<string, Pick<BuyerListingReview, "decision" | "verifiedPurchase">>> = {}): ListingSummary[] {
    if (sort !== "best" && sort !== "overlooked") return [...listings].sort(SORTS[sort]);
    const evaluated = new Map(listings.map(({ id }) => {
        const evaluation = evaluationOf(analyses[id]);
        const review = decisions[id];
        return [id, review?.decision === "BUY" ? applyVerifiedPurchase(evaluation, review.verifiedPurchase, targets, now) : evaluation] as const;
    }));
    const compareBest = (a: ListingSummary, b: ListingSummary) => {
        const ea = evaluated.get(a.id) ?? null;
        const eb = evaluated.get(b.id) ?? null;
        const ra = isDeal(ea) ? currentRating(ea) : null;
        const rb = isDeal(eb) ? currentRating(eb) : null;

        if (ra && rb) {
            if (ra.level !== rb.level) return LEVEL_ORDER[ra.level] - LEVEL_ORDER[rb.level];
            return (eb?.underwriting?.best?.profit ?? 0) - (ea?.underwriting?.best?.profit ?? 0);
        }
        if (ra) return -1;
        if (rb) return 1;

        const reviewed = Number(Boolean(decisions[b.id])) - Number(Boolean(decisions[a.id]));
        if (reviewed) return reviewed;

        return compareAnalysisPriority(a, b, targets, now);
    };

    // The listings with the strongest signs of being overlooked first.
    const compareOverlooked = (a: ListingSummary, b: ListingSummary) => {
        const ea = evaluated.get(a.id) ?? null, eb = evaluated.get(b.id) ?? null;
        const verified = Number(isDeal(eb)) - Number(isDeal(ea));
        return verified || compareListingEvidence(listingSignals(a, ea, now), listingSignals(b, eb, now)) || compareBest(a, b);
    };

    return [...listings].sort(sort === "best" ? compareBest : compareOverlooked);
}

export interface DealAlternative {
    listing: ListingSummary;
    label: "Below your targets" | "Resale not yet verified" | "Best Offer";
    profit: number | null;
    roi: number | null;
    offerPrice?: number;
}
// The caller supplies current filtered rows and evaluations retargeted to the
// user's controls. Alternatives never change the Deals group or start research.
export function selectDealAlternatives(filtered: ListingSummary[], analyses: Record<string, AnalysisState>, targets: Targets, now: number, includeOffers = false): DealAlternative[] {
    const alternatives: DealAlternative[] = [];
    for (const listing of filtered) {
        const evaluation = evaluationOf(analyses[listing.id]), best = evaluation?.underwriting?.best;
        if (listing.match || listing.screen?.junk || listing.availability === "UNAVAILABLE" || listing.endTime && Date.parse(listing.endTime) <= now ||
            evaluation?.listing.availability === "UNAVAILABLE" || evaluation?.identity?.notThisCard ||
            evaluation && (evaluation.slab?.status === "LIKELY_FAKE" || evaluation.condition?.authenticity.concern === "LIKELY_FAKE" || photoReviewStatus(evaluation).needsYourReview)) continue;
        const gap = priceEvidenceGap(evaluation);
        if (evaluation?.underwriting?.verdict === "PASS" && !gap) {
            if (best?.status !== "PRICED" || evaluation.researchMode === "DEFERRED_LOW_RESALE") continue;
            const offer = includeOffers && resultGroup(listing, evaluation, includeOffers) === "offers" ? offerFor(listing, best.maxBid) : null;
            if (offer) {
                const outcome = numbersAtOffer(best, offer);
                if (Number.isFinite(outcome.profit) && outcome.profit > 0) {
                    alternatives.push({ listing, label: "Best Offer", offerPrice: offer.offer, ...outcome });
                    continue;
                }
            }
            if (Number.isFinite(best.profit) && best.profit > 0) {
                alternatives.push({ listing, label: "Below your targets", profit: best.profit, roi: best.roi });
            }
            continue;
        }
        if (evaluation && !gap && best?.status === "PRICED" && best.profit <= 0) continue;
        const status = analyses[listing.id]?.status;
        if (listing.screen?.status !== "DROPPED" && status !== "error" && status !== "inconclusive" && status !== "held" &&
            (!evaluation && canAutoAnalyze(listing) || evaluation && gap && best?.status === "PRICED" && best.profit > 0)) {
            alternatives.push({ listing, label: "Resale not yet verified", profit: null, roi: null });
        }
    }
    return alternatives.sort((a, b) => Number(b.profit !== null) - Number(a.profit !== null) ||
        (b.profit ?? 0) - (a.profit ?? 0) || compareAnalysisPriority(a.listing, b.listing, targets, now)).slice(0, 3);
}

export type BestCurrentBuy = SearchCompetition & {
    basis: string;
    listingId: string;
    pricing: NonNullable<SearchCompetition["pricing"]>;
};

// The exact-slab comparison can find an eBay copy outside the retained search page.
export function competitionListingSummary(reference: SearchCompetition | undefined, destination?: string | null): ListingSummary | null {
    const link = reference && parseListingLink(reference.url);
    if (!reference || !link) return null;
    return { id: link.itemId, url: link.url, title: reference.title, currentPrice: reference.price,
        shipping: reference.shipping, shippingDestination: destination, termsCheckedAt: reference.checkedAt,
        seller: reference.seller ?? null, images: reference.image ? [reference.image] : [],
        buyingOption: "FIXED_PRICE", isGraded: true, bids: 0, endTime: null };
}

export function buyingComparisonRows(filtered: ListingSummary[], analyses: Record<string, AnalysisState>,
    decisions: Readonly<Record<string, Pick<BuyerListingReview, "decision" | "waitReason" | "unavailable" | "failure">>>,
    destination: string | null | undefined, minGrade: number) {
    return filtered.filter(row => {
        const review = decisions[row.id], value = evaluationOf(analyses[row.id]);
        if (review?.unavailable || review?.failure || (row.shippingDestination ?? null) !== destination ||
            (value && (value.listing.shippingDestination ?? null) !== destination) || (minGrade > 0 && !value)) return false;
        if (review?.waitReason && !["PRICE_EVIDENCE_UNAVAILABLE", "PRICING_DEFERRED"].includes(review.waitReason)) return false;
        // A resale loss does not disqualify a collector's purchase. Physical
        // mismatches, expired terms and other skips still need to be excluded.
        return review?.decision !== "SKIP" || value?.underwriting?.verdict === "PASS";
    });
}

function currentCompetition(reference: SearchCompetition | null | undefined, analyses: Record<string, AnalysisState>, intent: SearchIntent | null | undefined, now: number): BestCurrentBuy | null {
    if (!reference) return null;
    const link = parseListingLink(reference.url), age = now - Date.parse(reference.checkedAt ?? ""), pricing = reference.pricing;
    if (!link || !reference.title.trim() || !Number.isFinite(age) || age < 0 || age >= BEST_BUY_TERMS_MAX_AGE_MS ||
        !Number.isFinite(reference.price) || reference.price <= 0 || !Number.isFinite(reference.shipping) || reference.shipping < 0 ||
        !Number.isFinite(reference.ceiling) || reference.ceiling < 0 || !["PHOTO", "LABEL", "LISTING"].includes(reference.identity) ||
        !pricing || !Number.isFinite(pricing.resale) || pricing.resale <= 0 || !Number.isFinite(pricing.totalCost) || pricing.totalCost <= 0 ||
        !Number.isFinite(pricing.profit) || pricing.roi !== null && !Number.isFinite(pricing.roi) || !Number.isInteger(pricing.sales) || pricing.sales < 1) return null;
    const status = analyses[link.itemId]?.status;
    if (status === "inconclusive" || status === "held") return null;
    const accepted = Object.values(analyses).map(evaluationOf).filter(value => value &&
        parseListingLink(value.listing.id)?.itemId === link.itemId);
    if (accepted.some(value => value && (value.identity?.status !== "IDENTIFIED" || value.identity.notThisCard ||
        value.listing.availability === "UNAVAILABLE" || observedCardKind(value) !== "graded" ||
        value.slab?.status !== "OK" || /CRACK|TAMPER|BROKEN|OPEN/i.test(value.slab.caseCondition) ||
        intent && evaluatedCriteriaMismatch(value, intent) || deeperPhotoConcerns(value).length || photoReviewStatus(value).needsYourReview ||
        Date.parse(value.listing.termsCheckedAt ?? "") >= Date.parse(reference.checkedAt!) &&
        (value.listing.price !== reference.price || value.listing.shipping !== reference.shipping)))) return null;
    const grade = intent?.grader && intent.minGrade != null && intent.minGrade === intent.maxGrade
        ? `${intent.grader} ${intent.minGrade}` : "the requested slab grade";
    return { ...reference, pricing, url: link.url, listingId: link.itemId, basis: `Compared with sales of this printing at ${grade}` };
}

export function eligibleAssessedListing(listing: ListingSummary, state: AnalysisState | undefined, intent: SearchIntent | null | undefined, now: number, format: ListingSummary["buyingOption"] = "FIXED_PRICE") {
    const value = evaluationOf(state), identity = value?.identity;
    if (!value || state?.status !== "done" || !identity || identity.status !== "IDENTIFIED" ||
        !identity.name || !identity.set || !identity.cardNumber || !isPrinting(identity.printing) ||
        !["HOLO", "NON_HOLO", "REVERSE_HOLO"].includes(identity.finish) || identity.notThisCard ||
        listing.match || listing.screen?.junk || value.listing.id !== listing.id ||
        !englishListingEligible(listing, value) || intent && evaluatedCriteriaMismatch(value, intent) ||
        listing.buyingOption !== format || value.listing.buyingOption !== format ||
        value.listing.availability !== "ACTIVE" || !(listing.availability === "ACTIVE" ||
            listing.availability === undefined && checkedTerms(listing, value, now)) ||
        listing.endTime && !(Date.parse(listing.endTime) > now) || value.listing.endTime && !(Date.parse(value.listing.endTime) > now) ||
        obscuredDisclosedWear(value) || deeperPhotoConcerns(value).length ||
        photoReviewStatus(value).needsYourReview) return null;
    return value;
}

export function assessedPurchase(listing: ListingSummary, state: AnalysisState | undefined, intent: SearchIntent | null | undefined, now: number, format: ListingSummary["buyingOption"] = "FIXED_PRICE") {
    if (state?.status !== "done" || state.pricingExpired || !currentPriceEvidence(state.evaluation, now)) return null;
    return eligibleAssessedListing(listing, state, intent, now, format);
}

export function checkedTerms(listing: ListingSummary, evaluation: Evaluation, now: number) {
    const { price, shipping, termsCheckedAt } = evaluation.listing;
    const age = now - Date.parse(termsCheckedAt ?? "");
    if (!Number.isFinite(age) || age < 0 || age >= BEST_BUY_TERMS_MAX_AGE_MS ||
        price === null || !Number.isFinite(price) || price <= 0 || listing.currentPrice !== price ||
        shipping === null || !Number.isFinite(shipping) || shipping < 0 || listing.shipping !== shipping) return null;
    return { price, shipping };
}

// Each copy is valued against its own market. Relative savings let a broad
// search compare options without pooling prices from different markets.
export function rankCurrentBuys(filtered: ListingSummary[], analyses: Record<string, AnalysisState>, intent: SearchIntent | null | undefined, now: number, comparison?: SearchCompetition | null, maxDelivered = Infinity): BestCurrentBuy[] {
    const candidates = filtered.flatMap<BestCurrentBuy>(listing => {
        const value = assessedPurchase(listing, analyses[listing.id], intent, now);
        if (!value || value.underwriting?.shippingUnconfirmed) return [];
        const terms = checkedTerms(listing, value, now);
        if (!terms) return [];
        const { price, shipping } = terms;
        const graded = value.slab !== null;
        if (observedCardKind(value) !== (graded ? "graded" : "raw") || graded && (!value.slabPricing?.summary?.count || value.slab?.status !== "OK" || !value.slab.grader || !value.slab.grade || value.slab.gradeQualifier ||
            /CRACK|TAMPER|BROKEN|OPEN/i.test(value.slab.caseCondition)) || !graded &&
            (!value.condition || !isRawCondition(value.condition.rawCondition) || value.condition.authenticity.concern !== "NONE_SEEN")) return [];
        const path = value.underwriting?.paths.find(path => path.status === "PRICED" && path.path === (graded ? "GRADED_RESALE" : "RAW"));
        if (path?.status !== "PRICED" || referencePriceReason(value, path) || !Number.isFinite(path.salePrice) ||
            !Number.isFinite(path.profit) || !Number.isFinite(path.cost) || path.cost <= 0 ||
            !Number.isFinite(path.maxBid) || path.maxBid < 0 || path.roi !== null && !Number.isFinite(path.roi)) return [];
        const condition = !graded && value.condition && isRawCondition(value.condition.rawCondition) ? value.condition.rawCondition : null;
        if (condition && path.priceCondition !== condition) return [];
        const sales = graded ? value.slabPricing?.summary : value.rawPricing?.prices?.find(price =>
            price.condition === condition && price.price === path.salePrice)?.comps;
        if (!sales || !Number.isInteger(sales.count) || sales.count < 1 || soldMarketPrice(sales) !== path.salePrice ||
            (graded ? sales.grader !== value.slab!.grader || Number(sales.grade) !== Number(value.slab!.grade)
                : sales.grader !== "RAW" || sales.grade !== condition)) return [];
        return [{
            listingId: listing.id, title: value.listing.title, url: value.listing.url,
            price, shipping, ceiling: path.maxBid, identity: "PHOTO",
            checkedAt: value.listing.termsCheckedAt, image: value.listing.photos?.[0] ?? listing.images[0], seller: value.listing.seller,
            pricing: { resale: path.salePrice!, totalCost: path.cost, profit: path.profit, roi: path.roi,
                sales: sales.count },
            basis: condition ? `Compared with ${CONDITION_NAMES[condition]} sales of this printing` :
                `Compared with ${value.slab!.grader} ${value.slab!.grade} sales of this printing`,
            concerns: (value.slab?.concerns ?? value.condition?.limitations ?? []).slice(0, 2),
        }];
    });
    const coverage = { found: filtered.length, checked: candidates.length };
    const compared = currentCompetition(comparison, analyses, intent, now);
    if (compared && !candidates.some(candidate => candidate.listingId === compared.listingId)) candidates.push(compared);
    const ranked = candidates.filter(({ pricing, price, shipping }) =>
        pricing.totalCost <= maxDelivered && cents(pricing.totalCost) >= cents(price) + cents(shipping)).sort((a, b) =>
        a.pricing.totalCost / a.pricing.resale - b.pricing.totalCost / b.pricing.resale ||
        b.pricing.sales - a.pricing.sales || a.pricing.totalCost - b.pricing.totalCost || a.listingId.localeCompare(b.listingId));
    return ranked.map(copy => copy === compared ? copy : { ...copy, coverage });
}

export function selectBestCurrentBuy(...args: Parameters<typeof rankCurrentBuys>): BestCurrentBuy | null {
    return rankCurrentBuys(...args)[0] ?? null;
}

// An asking price remains useful when matched sales are missing. This is a
// comparison of current offers only, so never give it a market value or verdict.
export function lowestListedCopy(filtered: ListingSummary[], analyses: Record<string, AnalysisState>, intent: SearchIntent | undefined,
    now: number, maxDelivered?: number) {
    const eligible = filtered.filter(listing => {
        const state = analyses[listing.id];
        return state?.status !== "held" && state?.status !== "inconclusive" &&
            (state?.status !== "done" || Boolean(eligibleAssessedListing(listing, state, intent, now)));
    });
    return lowestQuotedOffer(eligible, now, maxDelivered);
}

export interface RawBuyingComparison {
    listing: ListingSummary;
    condition: RawCondition;
    betterConditionCopy?: { listing: ListingSummary; condition: RawCondition; totalCost: number; difference: number };
    totalCost: number;
    nextTotal: number;
    highestTotal: number;
    copies: number;
    sales: CompSummary;
    sellerReported: boolean;
}

// Compare copies in the same observed market. Sold listings with seller-described
// condition provide collector context independently of the stricter resale evidence.
type RawCopy = Pick<RawBuyingComparison, "listing" | "condition" | "sales" | "sellerReported"> & { totalCost: number | null; verifiedMarket: string | null };

function comparableRawMarkets(filtered: ListingSummary[], analyses: Record<string, AnalysisState>, intent: SearchIntent | null | undefined, now: number) {
    const markets = new Map<string, RawCopy[]>();
    for (const listing of filtered) {
        const value = assessedPurchase(listing, analyses[listing.id], intent, now);
        const condition = value?.condition?.rawCondition;
        if (!value?.identity || !isRawCondition(condition) || value.slab || observedCardKind(value) !== "raw" ||
            value.condition?.authenticity.concern !== "NONE_SEEN" || unsupportedVariantReason(value)) continue;
        const views = photoCoverage(value.photoCheck);
        if (!views.fronts || !views.backs || condition !== "DAMAGED" && sellerDisclosedCreasing(value.listing.conditionNotes)) continue;
        const raw = value.rawPricing;
        const matched = raw?.prices?.find(row => row.condition === condition && isRawSoldPrice(row) &&
            row.comps?.grade === condition && row.comps.grader === "RAW" && row.comps.count > 0 && soldMarketPrice(row.comps) === row.price)?.comps;
        const sales = matched ?? raw?.sellerConditionComps;
        if (!sales || sales.grader !== "RAW" || sales.grade !== condition || !Number.isInteger(sales.count) ||
            sales.count < 1 || soldMarketPrice(sales) === null) continue;
        const identity = value.identity;
        const identityKey = JSON.stringify([identity.name, identity.set, identity.cardNumber, identity.printing, identity.finish, identity.language]);
        const key = identityKey + condition;
        const group = markets.get(key) ?? [];
        if (group.some(copy => copy.listing.id === listing.id)) continue;
        const terms = checkedTerms(listing, value, now);
        group.push({ listing, condition, verifiedMarket: cardLanguageStatus("", [identity.language]) === "ENGLISH" ? identityKey : null, sales, sellerReported: !matched || raw?.conditionEvidence !== "AI_PHOTOS",
            totalCost: terms && acquisitionCost(terms.price, terms.shipping, MONEY_CONFIG.buying) });
        markets.set(key, group);
    }
    return [...markets.values()];
}

// A bounded eBay-only pass at the end of a search. A missing quote can be
// shortlisted by item price, but only a fresh, confirmed quote can win.
export function rawComparisonQuoteIds(filtered: ListingSummary[], analyses: Record<string, AnalysisState>, intent: SearchIntent | null | undefined, now: number) {
    const candidates = comparableRawMarkets(filtered, analyses, intent, now).flatMap(copies => {
        if (copies.length < 2) return [];
        const quoted = copies.flatMap(copy => copy.totalCost === null ? [] : [copy.totalCost]).sort((a, b) => a - b);
        return copies.flatMap(copy => {
            const price = copy.listing.currentPrice;
            if (copy.totalCost !== null || price === null || !Number.isFinite(price) || price <= 0) return [];
            const minimum = acquisitionCost(price, 0, MONEY_CONFIG.buying);
            return minimum <= (quoted[1] ?? Infinity) ? [{ id: copy.listing.id, ratio: minimum / soldMarketPrice(copy.sales)! }] : [];
        });
    });
    return candidates.sort((a, b) => a.ratio - b.ratio || a.id.localeCompare(b.id)).slice(0, 5).map(copy => copy.id);
}

export function rankRawBuyingComparisons(filtered: ListingSummary[], analyses: Record<string, AnalysisState>,
    intent: SearchIntent | null | undefined, now: number, maxDelivered = Infinity): RawBuyingComparison[] {
    const quotedGroups = comparableRawMarkets(filtered, analyses, intent, now).map(group =>
        group.filter((copy): copy is RawCopy & { totalCost: number } => copy.totalCost !== null && copy.totalCost <= maxDelivered)
            .sort((a, b) => a.totalCost - b.totalCost || a.listing.id.localeCompare(b.listing.id)));
    const groups = quotedGroups.filter(group => group.length >= 2).sort((a, b) =>
        a[0].totalCost / soldMarketPrice(a[0].sales)! - b[0].totalCost / soldMarketPrice(b[0].sales)! ||
        b.length - a.length || a[0].listing.id.localeCompare(b[0].listing.id));
    return groups.map((selected, index) => {
        const [best, next] = selected;
        const cost = cents(best.totalCost);
        // Show a checked condition upgrade at a premium of at most 5% or $5, whichever is lower.
        const maxExtra = Math.min(Math.floor(cost / 20), 500);
        const [upgrade] = index > 0 ? [] : quotedGroups.filter(group => group.length > 0).map(group => group[0]).filter(copy =>
            best.verifiedMarket !== null && copy.verifiedMarket === best.verifiedMarket && conditionGap(best.condition, copy.condition) < 0 &&
            cents(copy.totalCost) <= cost + maxExtra).sort((a, b) => a.totalCost - b.totalCost || conditionGap(b.condition, a.condition));
        return { listing: best.listing, condition: best.condition, totalCost: best.totalCost, sales: best.sales, sellerReported: best.sellerReported,
            copies: selected.length, nextTotal: next.totalCost, highestTotal: selected[selected.length - 1].totalCost,
            ...(upgrade && { betterConditionCopy: { listing: upgrade.listing, condition: upgrade.condition,
                totalCost: upgrade.totalCost, difference: (cents(upgrade.totalCost) - cost) / 100 } }) };
    });
}

export function selectRawBuyingComparison(...args: Parameters<typeof rankRawBuyingComparisons>): RawBuyingComparison | null {
    return rankRawBuyingComparisons(...args)[0] ?? null;
}

export type DealComparison =
    | { kind: "sales"; value: BestCurrentBuy }
    | { kind: "copies"; value: RawBuyingComparison }
    | { kind: "asking"; total: number; soldEstimate?: number };

// Keep resale decisions intact. A price comparison can earn a place in Find a deal
// when the buyer hasn't set a resale target. The first, strongest reason wins.
export function dealTabResults(verified: ListingSummary[], bids: ListingSummary[], rows: ListingSummary[],
    sales: BestCurrentBuy[], copies: RawBuyingComparison[], lowest: ReturnType<typeof lowestListedCopy>, targets: Targets) {
    const listings = new Map([...verified, ...bids].map(row => [row.id, row]));
    const reasons = new Map<string, DealComparison>();
    function add(row: ListingSummary | undefined, reason: DealComparison) {
        if (!row || listings.has(row.id)) return;
        listings.set(row.id, row);
        reasons.set(row.id, reason);
    }
    if (!targets.minProfit && !targets.minRoi) {
        const byId = new Map(rows.map(row => [row.id, row]));
        for (const value of sales) {
            if (cents(value.pricing.totalCost) >= cents(value.pricing.resale) || value.identity === "LISTING" ||
                value.concerns?.length || (value.seller?.feedbackScore ?? Infinity) < 10 || (value.seller?.feedbackPercentage ?? 100) < 98) continue;
            add(byId.get(value.listingId), { kind: "sales", value });
        }
        for (const value of copies) add(value.listing, { kind: "copies", value });
        if (lowest) add(lowest.listing, { kind: "asking", total: lowest.total,
            soldEstimate: sales.find(copy => copy.listingId === lowest.listing.id)?.pricing.resale });
    }
    return { listings: [...listings.values()], reasons };
}

export function countSearchResults({ listings, analyses, newMode, newIds, page, intent, filters }: ResultsContext & { newMode: boolean; newIds: ReadonlySet<string>; filters?: SearchFilters }) {
    listings = filters ? listings.filter(listing => matchesListingFilters(listing, {
        typeFilter: filters.typeFilter, kindFilter: filters.kindFilter,
        minPrice: Number(filters.minPrice) || 0, maxPrice: filters.maxPrice === "" ? undefined : Number(filters.maxPrice),
    }, evaluationOf(analyses[listing.id]))) : listings;
    const count = (status: string) => listings.filter((listing) => listing.screen?.status === status).length;
    const eligibleLanguage = (listing: ListingSummary) => englishListingEligible(listing, evaluationOf(analyses[listing.id]));
    const eligibleKind = (listing: ListingSummary) => matchesListingFilters(listing, {}, evaluationOf(analyses[listing.id]), page === "search" ? intent?.graded : null);
    const eligibleEvidence = (listing: ListingSummary) => {
        const evaluation = evaluationOf(analyses[listing.id]);
        return eligibleLanguage(listing) && eligibleKind(listing) && !evaluation?.identity?.notThisCard &&
            !(page === "search" && intent && evaluation && evaluatedCriteriaMismatch(evaluation, intent));
    };
    const analyzing = listings.filter((listing) => eligibleLanguage(listing) && eligibleKind(listing) && analyses[listing.id]?.status === "loading").length;

    return {
        candidates: listings.filter((listing) => eligibleEvidence(listing) && (!newMode || newIds.has(listing.id)) && canAutoAnalyze(listing)).length,
        dropped: count("DROPPED"),
        unchecked: listings.filter((listing) => !evaluationOf(analyses[listing.id]) && eligibleEvidence(listing) && listing.screen?.status === "UNSCREENED" && !listing.match &&
            !(listing.screen.priceAnomaly && !listing.screen.priceAnomaly.photoChecked)).length,
        mismatched: listings.filter(
            (listing) =>
                (listing.match && listing.match !== "JUNK") || !eligibleLanguage(listing) || !eligibleKind(listing) || Boolean(evaluationOf(analyses[listing.id])?.identity?.notThisCard) ||
                Boolean(page === "search" && intent && evaluationOf(analyses[listing.id]) && evaluatedCriteriaMismatch(evaluationOf(analyses[listing.id])!, intent))
        ).length,
        // Junk the AI spotted in titles; the free rules' count comes with the search.
        junk: listings.filter((listing) => listing.match === "JUNK").length,
        analyzing,
        waiting: listings.filter(
            (listing) => eligibleEvidence(listing) && (!newMode || newIds.has(listing.id)) && canAutoAnalyze(listing) && !analyses[listing.id]
        ).length,
    };
}
