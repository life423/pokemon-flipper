import { countFlipRequests, flipRequestCounts } from "./flip-provider-requests.ts";
import { checkMarketGuides, reviewResale, type ResaleReview } from "./resale-market-review.ts";
import { tcgplayerComparison } from "../../shared/money/price-evidence.ts";
import { relistEstimate } from "../../shared/money/relist-estimate.ts";
import { browsePressure } from "../lib/provider-usage.ts";
import { createHash } from "node:crypto";
import { HUNT_RECHECK_MS } from "../../shared/deal-hunt.ts";
import { releaseIssue } from "../../shared/base-set-release.ts";
import { auctionOpportunity, nextAuctionBid, withinOpportunityWindow } from "../../shared/auction-opportunity.ts";
import { collectorAuction } from "../../shared/collector-auction.ts";
import { yearOf } from "../../shared/sets.ts";
import { setYears } from "../pricing/price-tracker.ts";
import { researchAuctionSellers, researchFreshRawSellers } from "../deals/auction-seller-research.ts";
import { discoveryMarketKey, freshResaleCandidates, resaleReviewPriority } from "../deals/discovery-order.ts";
import { createHuntInventoryScanner } from "../deals/find-deals.ts";
import { buyerVisiblePrice, listingMarketPrices, type ProviderPrice } from "../../shared/listing-market-prices.ts";
import { chooseReviewSelection } from "../deals/search-review-selection.ts";
import { orderFlipPreviewCopies, selectFlipPreviews, type PreviewLead } from "../deals/flip-preview-selection.ts";
import { StorageUnavailableError } from "../storage/config.ts";
import { analysisPriority, availablePhotoCount } from "../../shared/analysis-priority.ts";
import { freshListingTime } from "../../shared/grading-watch.ts";
import { sellerConditionClues } from "../../shared/raw-condition-claim.ts";
import { meetsMinimumGrade, type AutoAnalysisBlockReason } from "../../shared/analysis.ts";
import { FIRST_REVIEW_COUNT } from "../../shared/search-review-selection.ts";
import { englishListingEligible } from "../../shared/card-language.ts";
import { DEAL_HUNT_LISTING_LIMIT, dealHuntGoals, type DealHuntAction, type DealHuntGoal, type DealHuntRequest, type DealHuntResponse } from "../../shared/deal-hunt.ts";
import { buyerReviewBlock } from "../../shared/wait-skip-review.ts";
import { listingEvidenceKey, searchPhotosFitDetails } from "../../shared/listing-evidence.ts";
import { matchesListingFilters, type ListingFilters } from "../../shared/listing-filters.ts";
import { applyVerifiedPurchase } from "../../shared/money/verified-purchase.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { acquisitionCost } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { dollars } from "../../shared/format.ts";
import { withFreshListing } from "../../shared/fresh-listing.ts";
import { currentPriceEvidence } from "../../shared/pricing-freshness.ts";
import { BOUNDED_AUTO_CONCURRENCY, DEVELOPMENT_SEARCH_LIMIT } from "../../shared/research-policy.ts";
import { evaluatedCriteriaMismatch } from "../../shared/search-criteria.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import type { Evaluation, ListingSummary, PricedPath, SearchIntent, Targets } from "../../shared/types.ts";
import { EbayError } from "../ebay/api.ts";
import { EbayBudgetError } from "../ebay/usage.ts";
import { exclusionReason } from "../ebay/filters.ts";
import { aiSpendingFailure } from "../ai/spending.ts";
import { getBudgetContext, withAiUsageContext } from "../ai/usage-context.ts";
import { getListingDetails } from "../ebay/listings.ts";
import { configuredShippingZip } from "../ebay/shipping-destination.ts";
import { dailyBrowseReserve, reserveDailyBrowseCall } from "../ebay/daily-budget.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { evaluateBoundedListing, PriceOnlyEvidenceError } from "./bounded-evaluate.ts";
import { EnglishOnlyError, RejectedPhotoAssessmentError } from "./failure.ts";
import { runDealHunt, type DealHuntCandidate, type DealHuntMarket } from "./deal-hunt.ts";
import { huntProgress } from "./deal-hunt-progress.ts";
import { flipRunFile, withFlipRun, FlipRunConflict, type FlipJournal, type FlipTask } from "./flip-run-store.ts";
import { withSavedProviderEvidence } from "../lib/saved-provider-evidence.ts";
import { flipDiagnostic } from "./flip-diagnostic.ts";
import { verifyCollectorArtwork } from "./collector-artwork.ts";
import { huntPrintingCheck, huntPrintingTerms } from "./deal-hunt-printing.ts";
import { dealHuntCandidate, flipResaleEvidence, hasVerifiedRawFlip, newGradingOpportunity } from "./deal-hunt-evidence.ts";
import { evaluationContextKey, loadPrivateEvaluation, type PrivateEvaluationSnapshot } from "./private-evaluation.ts";
import { FlipEvaluations } from "./flip-evaluations.ts";
import { guidedInventoryTargets, webInventoryTargets, type InventoryTarget } from "./guided-inventory.ts";
import { cachedLiquidMarkets, liquidMarkets } from "../pricing/liquid-markets.ts";
import { diagnosticUsage, loadDiagnosticDiscovery } from "./search-diagnostics.ts";
import { isSearchDiagnosticId } from "./search-diagnostic-store.ts";
import { discoveryContinuations, type DiscoveryBacklog } from "../deals/search-continuation.ts";
import { findHuntMarkets, restoreSavedHuntSales, type HuntMarket } from "./same-set-markets.ts";
import { discoverMarketListings, type MarketQueryObservation } from "./same-set-listings.ts";
import { describeHuntMarket, huntOrigin, huntPhotoIdentityIssue, keepsSetSearchPreferences, marketItemLimit, marketIntent, matchesHuntMarket, photoMatchesCollectorMarket, shortlistMarketCopies } from "./deal-hunt-market-checks.ts";
import { pricedInventoryTargets, groupMarketCopies, groupMarketSearches, huntMarketCardKey } from "./deal-hunt-market-groups.ts";
import { priceChartingComparison } from "../pricing/pricecharting.ts";
import { marketHistory } from "../pricing/price-history.ts";
import { providerPrices } from "../pricing/buyer-market-prices.ts";
import { cardmarketComparisonKey, type CardmarketComparison } from "../../shared/cardmarket.ts";
import { compareCardmarket } from "../pricing/cardmarket.ts";
import { withPriceResearchSignal } from "../pricing/research-budget.ts";
import { sameCardNumber } from "../../shared/card-number.ts";
import { sameCatalogName } from "../identity/catalog-name.ts";
import { supplementalResearch } from "../pricing/supplemental-research.ts";
import { PricingProviderError } from "../pricing/errors.ts";
import { restoreRawComparisons } from "../pricing/saved-raw-comparisons.ts";
import { sameSetFamily } from "../identity/card-identity.ts";

export class DealHuntInputError extends Error {
    constructor(message: string, readonly status = 400, readonly code?: "FLIP_RUN_ACTIVE") { super(message); }
}

export function dealHuntRequest(input: unknown): DealHuntRequest {
    const body = input as Partial<DealHuntRequest> | null;
    const targets = body?.targets;
    const scope = body?.scope === undefined ? "search" : body.scope;
    const filters = body?.filters, minimumGrade = body?.minPotentialGrade ?? 0;
    const preferences = body?.marketPreferences;
    const seed = preferences?.seed;
    const years = [preferences?.minYear, preferences?.maxYear];
    const grades = [preferences?.minGrade, preferences?.maxGrade];
    const freshGrading = body?.standalone === true && body.goal === "grade_raw" &&
        filters?.typeFilter === "FIXED_PRICE" && filters.kindFilter !== "graded";
    if (!body || typeof body.goal !== "string" || !Object.hasOwn(dealHuntGoals, body.goal) ||
        !["search", "same_set", "any_card"].includes(scope) || scope === "any_card" && body.goal !== "resell" &&
            !(body.goal === "collect_slab" && filters?.typeFilter === "AUCTION") && !freshGrading ||
        body.freshListings !== undefined && (body.freshListings !== true || !body.standalone || scope !== "any_card" ||
            body.goal !== "resell" || filters?.typeFilter !== "FIXED_PRICE") ||
        (body.standalone !== undefined && typeof body.standalone !== "boolean") ||
        (body.watch !== undefined && (body.watch !== true || !body.standalone || body.goal !== "resell")) ||
        !Array.isArray(body.listingIds) || !body.listingIds.length && scope === "search" || body.listingIds.length > DEAL_HUNT_LISTING_LIMIT ||
        body.standalone && (scope !== "any_card" || body.listingIds.length !== 0 || !!body.batchIds?.length) ||
        body.batchIds !== undefined && (!Array.isArray(body.batchIds) || body.batchIds.length > body.listingIds.length ||
            body.batchIds.some(id => !isSearchDiagnosticId(id)) || new Set(body.batchIds).size !== body.batchIds.length) ||
        !Number.isFinite(minimumGrade) || minimumGrade < 0 || minimumGrade > 10 ||
        (filters !== undefined && (!filters || typeof filters !== "object" || Array.isArray(filters) ||
            ![undefined, "FIXED_PRICE", "AUCTION", "all"].includes(filters.typeFilter) ||
            ![undefined, "raw", "graded", "all"].includes(filters.kindFilter) ||
            [filters.minPrice, filters.maxPrice].some(p => p !== undefined && (!Number.isFinite(p) || p < 0)) ||
            (filters.minPrice ?? 0) > (filters.maxPrice ?? Infinity))) ||
        (preferences !== undefined && (!preferences || typeof preferences !== "object" || Array.isArray(preferences) ||
            seed !== undefined && (!seed || !body.standalone || body.goal !== "resell" ||
                typeof seed.expand !== "boolean" || ![seed.name, seed.number].some(Boolean) ||
                [seed.name, seed.number].some(value => value !== null && (typeof value !== "string" || !value.trim() || value.length > 120))) ||
            years.some(year => year !== undefined && (!Number.isInteger(year) || year < 1900 || year > 2100)) ||
            (preferences.minYear ?? 1900) > (preferences.maxYear ?? 2100) ||
            preferences.preferRecentSales !== undefined && typeof preferences.preferRecentSales !== "boolean" ||
            ![undefined, "FIRST_EDITION", "SHADOWLESS", "UNLIMITED"].includes(preferences.printing) ||
            ![undefined, "PSA", "CGC", "BGS", "SGC", "TAG"].includes(preferences.grader) ||
            grades.some(grade => grade !== undefined && (!Number.isFinite(grade) || grade < 1 || grade > 10 || !Number.isInteger(grade * 2))) ||
            (preferences.minGrade ?? 1) > (preferences.maxGrade ?? 10) ||
            (preferences.sets !== undefined && (!Array.isArray(preferences.sets) || !preferences.sets.length || preferences.sets.length > 8 ||
                preferences.sets.some(set => typeof set !== "string" || !set.trim() || set.length > 120))) ||
            ![undefined, "HOLO", "REVERSE_HOLO", "NON_HOLO"].includes(preferences.finish))) ||
        body.listingIds.some(id => typeof id !== "string" || !/^[\w|-]{1,120}$/.test(id)) ||
        new Set(body.listingIds).size !== body.listingIds.length || !targets ||
        ![targets.minProfit, targets.minRoi].every(amount => Number.isFinite(amount) && amount >= 0)) {
        throw new DealHuntInputError("Choose a buying goal, valid profit and ROI targets, and listings from one completed search.");
    }
    return { goal: body.goal, scope, ...(body.watch && { watch: true }), ...(body.freshListings && { freshListings: true }), standalone: body.standalone === true, minPotentialGrade: minimumGrade,
        filters: filters && { typeFilter: filters.typeFilter, kindFilter: filters.kindFilter, minPrice: filters.minPrice, maxPrice: filters.maxPrice },
        ...(preferences && { marketPreferences: { ...(seed && { seed: { name: seed.name?.trim() || null, number: seed.number?.trim() || null, expand: seed.expand } }), minYear: preferences.minYear, maxYear: preferences.maxYear, finish: preferences.finish,
            printing: preferences.printing, grader: preferences.grader, minGrade: preferences.minGrade, maxGrade: preferences.maxGrade,
            ...(body.goal === "resell" && preferences.preferRecentSales && { preferRecentSales: true }),
            ...(preferences.sets && { sets: [...new Set(preferences.sets.map(set => set.trim()))] }) } }),
        listingIds: [...body.listingIds], ...(body.batchIds?.length && { batchIds: [...body.batchIds] }),
        targets: { minProfit: targets.minProfit, minRoi: targets.minRoi } };
}

interface HuntRow {
    marketSupply?: string;
    listing: ListingSummary;
    assessable: boolean;
    block?: AutoAnalysisBlockReason | null;
    screenReason?: string;
    gradingLead?: true;
    collectorQuery?: string;
    exactCard?: { name: string; cardNumber: string; set: string | null };
    excludedFromHunt?: true;
}
interface HuntInventory {
    intent: SearchIntent;
    filters: ListingFilters;
    rows: HuntRow[];
}
const inventoryKey = (searchId: string) => `private-deal-hunt-inventory:v1:${searchId}`;

// Store the search's own listing terms and gallery, without copying sold transactions
// or private assessments into every run. Older searches can still use their assessments.
export const loadSearchReviewInventory = (id: string) => readCache<HuntInventory>(inventoryKey(id), 24 * 30);

export async function saveDealHuntInventory(searchId: string, intent: SearchIntent, filters: ListingFilters, listings: ListingSummary[]) {
    const rows: HuntRow[] = [];
    for (const source of listings) {
        const excluded = source.match && source.match !== "UNCONFIRMED_CRITERIA" ||
            source.screen?.junk || !englishListingEligible(source);
        const { screen, mistakes, ...listing } = source;
        const block = buyerReviewBlock(source);
        rows.push({ listing, block, assessable: block === null, ...(excluded && { excludedFromHunt: true }),
            ...(screen?.reason && { screenReason: screen.reason }), ...(screen?.gradingLead && { gradingLead: true }) });
    }
    await writeCache(inventoryKey(searchId), { intent, filters, rows } satisfies HuntInventory);
}

const defaults = {
    reviewResale, checkMarketGuides,
    browsePressure,
    async browseReserveReset(signal: AbortSignal) {
        const usage = await reserveDailyBrowseCall(null, { consume: false, signal });
        return usage.braking && usage.resetsAt ? Date.parse(usage.resetsAt) : null;
    },
    discovery: loadDiagnosticDiscovery,
    batchOwner: discoveryContinuations.budgetOwner,
    inventory: loadSearchReviewInventory,
    snapshot: loadPrivateEvaluation,
    details: getListingDetails,
    restoreRaw: restoreRawComparisons,
    supplement: supplementalResearch,
    priceCharting: priceChartingComparison,
    marketHistory,
    compareCardmarket,
    evaluate: evaluateBoundedListing,
    verifyCollectorArtwork,
    plan: runDealHunt,
    markets: findHuntMarkets,
    inventoryScanner: createHuntInventoryScanner,
    pricedInventoryTargets,
    cachedLiquidMarkets,
    liquidMarkets,
    guidedInventoryTargets,
    webInventoryTargets,
    discoverMarket: discoverMarketListings,
    now: Date.now,
    setYears,
    researchAuctionSellers,
    researchFreshRawSellers,
    selectReviews: chooseReviewSelection,
    selectFlipPreviews,
};
type Dependencies = typeof defaults;

// Read independent private snapshots four at a time, preserving research priority and cancellation.
async function* readCopySnapshots(copies: { listing: ListingSummary }[], deps: Dependencies, signal: AbortSignal) {
    for (let start = 0; start < copies.length; start += 4) {
        signal.throwIfAborted();
        const batch = copies.slice(start, start + 4);
        const snapshots = await Promise.all(batch.map(({ listing }) => deps.snapshot(listing.id)));
        for (const [index, { listing }] of batch.entries()) {
            signal.throwIfAborted();
            yield { listing, saved: snapshots[index] };
        }
    }
}

function targetCursor(target: InventoryTarget, format: string) {
    const query = [target.name, target.number, target.set].filter(Boolean).join(" ") || "Pokemon";
    return JSON.stringify(target.exactMarket ? [query, format, target.exactMarket.intent, target.exactMarket.maxItem] : [query, format]);
}
function catalogActivity(target: InventoryTarget) {
    if (target.exactMarket) return target.exactMarket.reason;
    const pace = target.activeDays === undefined ? "" : ` Observed ${((target.sales ?? 0) / (target.windowDays ?? 7)).toFixed(2)} per day, across ${target.activeDays} selling days.`;
    return `At least ${target.sales} recorded USD eBay sales across the selected card types in ${target.windowDays ?? 7} calendar days.${pace}`;
}
const referencePrerequisites = new Set<DealHuntAction>(["inspect_photos", "check_listing", "check_sales"]);

function fits(value: Evaluation, row?: HuntRow, inventory?: HuntInventory | null) {
    if (value.identity?.notThisCard ||
        !englishListingEligible(value.listing, value)) return false;
    if (!row || !inventory) return true;
    const listing = { ...row.listing, title: value.listing.title, images: value.listing.photos ?? [], currentPrice: value.listing.price };
    return !evaluatedCriteriaMismatch(value, inventory.intent) && matchesListingFilters(listing, inventory.filters, value, inventory.intent.graded);
}

function rowMatches(row: HuntRow, saved: PrivateEvaluationSnapshot) {
    return saved.evidenceKey === listingEvidenceKey(row.listing) ||
        row.listing.title.trim() === saved.evaluation.listing.title.trim() &&
        searchPhotosFitDetails(row.listing.images, saved.evaluation.listing.photos ?? []);
}

interface CopyProgress {
    resaleReview?: ResaleReview & { market: string };
    evaluation: Evaluation | null;
    artworkVerified: boolean;
    retired: boolean;
    retireReason?: string;
    differentArtwork?: boolean;
    listing?: ListingSummary;
    european?: { market: string; comparison: CardmarketComparison };
    guide?: { market: string; prices: ProviderPrice[]; ebayActivity?: string };
    quotaNote?: string;
    checkFullListing: boolean;
}
interface ScopedCandidate extends DealHuntCandidate {
    snapshot(): CopyProgress;
    restore(progress: CopyProgress): boolean;
    retire(reason: string): string;
    liveListing(): ListingSummary | null;
    marketPrices(listing: ListingSummary): ReturnType<typeof listingMarketPrices>;
}

function scopedCandidate(id: string, goal: DealHuntGoal, targets: Targets, searchId: string, saved: PrivateEvaluationSnapshot | null,
    inventory: HuntInventory | null, row: HuntRow | undefined, evaluations: FlipEvaluations, deps: Dependencies,
    filters: ListingFilters, minGrade: number, acceptsEvaluation: (evaluation: Evaluation) => boolean,
    { markets = [], freshGrading = false, preferRecentSales = false, requireLiquidity = preferRecentSales, verifyPhotoIdentity = false }: { markets?: HuntMarket[]; freshGrading?: boolean; preferRecentSales?: boolean; requireLiquidity?: boolean; verifyPhotoIdentity?: boolean } = {}): ScopedCandidate | null {
    // Never use an unrelated old version of a card simply because its eBay ID is the same.
    if (saved && (saved.evaluation.listing.id !== id || (row ? !rowMatches(row, saved) : saved.searchId !== searchId))) saved = null;
    const format = filters.typeFilter === "AUCTION" ? "AUCTION" : "FIXED_PRICE";
    const auction = format === "AUCTION";
    if (auction && !withinOpportunityWindow(row?.listing.endTime ?? saved?.evaluation.listing.endTime, deps.now())) return null;
    let checkFullListing = Boolean((markets.length || auction || !inventory && row) && saved);
    let value = saved && flipResaleEvidence(retargetEvaluation(saved.evaluation, targets, row?.listing), goal, targets);
    let european: { market: string; comparison: CardmarketComparison } | undefined;
    if (freshGrading && (!row || freshListingTime(row.listing, deps.now()) === null)) return null;
    const matches = (e: Evaluation) => e.listing.buyingOption === format && acceptsEvaluation(e) && fits(e, row, inventory) && meetsMinimumGrade(e, minGrade) && (!markets.length || markets.some(market => matchesHuntMarket(e, market, !!huntPrintingCheck(e), freshGrading) && !evaluatedCriteriaMismatch(e, marketIntent(market)))) &&
        (!row || matchesListingFilters({ ...row.listing, currentPrice: e.listing.price }, filters, e));
    if (value && !matches(value)) return null;
    let resaleReview: CopyProgress["resaleReview"];
    let pendingResalePath: PricedPath | null = null;
    const marketKey = (copy: Evaluation) => JSON.stringify([cardmarketComparisonKey(copy), copy.answeredAt, copy.pricesCheckedAt,
        copy.listing.price, copy.listing.shipping, copy.listing.shippingDestination, copy.condition?.rawCondition]);
    const validReview = () => resaleReview && value && resaleReview.market === marketKey(value) && resaleReview.validUntil > deps.now() ? resaleReview : undefined;
    const competition = (copy: Evaluation, path: Parameters<FlipEvaluations["competingCopies"]>[1], at: number) => {
        const peers = evaluations.competingCopies(copy, path, at), rival = validReview()?.competitor;
        if (rival && (!peers.cheapest || rival.delivered < peers.cheapest.delivered)) return { count: Math.max(1, peers.count), cheapest: rival };
        return peers;
    };
    const reader = () => value && dealHuntCandidate(value, goal, deps.now, markets, targets, filters.maxPrice,
        { preferRecentSales: requireLiquidity, statistic: validReview()?.statistic, competingCopies: competition });
    const finalistPath = (result?: ReturnType<DealHuntCandidate["outcome"]>) => {
        if (!requireLiquidity || goal !== "resell" || !result) return null;
        if (result.decision === "BID" && auction && value) {
            const offer = auctionOpportunity(value, targets, deps.now(), filters.maxPrice);
            return value.underwriting?.paths.find((p): p is PricedPath => p.status === "PRICED" && p.path !== "GRADE" && p.path === offer?.routeKind) ?? null;
        }
        const path = result.verifiedPurchase?.path;
        return result.decision === "BUY" && path && path.path !== "GRADE" ? path : null;
    };
    const initial = reader();
    let artworkVerified = !row?.collectorQuery && !row?.exactCard;
    if (value && !initial) return null;
    if (!value && (!row?.assessable || goal === "grade_raw" && row.listing.isGraded || goal === "collect_slab" && !row.listing.isGraded)) return null;
    if (value && artworkVerified) evaluations.set(id, value);
    let guide: CopyProgress["guide"];
    let retired = false;
    let retireReason: string | undefined, differentArtwork = false;
    const retire = (message: string) => {
        retired = true;
        retireReason = message;
        evaluations.delete(id);
        return message;
    };
    let card = row?.listing;
    const seller = card?.auctionResearch;
    const listingTime = card && !auction && !card.isGraded ? freshListingTime(card, deps.now()) : null;
    const claim = card && sellerConditionClues(card);
    const freshRawGradingLead = listingTime != null && !!card && availablePhotoCount(card.images) > 0 && !claim?.severe && !claim?.ambiguous &&
        !!(row?.gradingLead || card.screen?.gradingLead || claim?.claim === "NEAR_MINT" || claim?.claim === "MINT" || markets.some(m => m.kind === "raw" && m.grader));
    const freshClues = freshRawGradingLead && card ? [
        `eBay ${card.listedAt ? "first available" : "creation date"} ${new Date(listingTime!).toISOString()}.`,
        claim?.claim ? `Seller describes condition as ${claim.claim.replaceAll("_", " ")}.` : "Seller condition unspecified.",
        `${availablePhotoCount(card.images)} distinct listing image(s).`,
        seller && `Seller inventory sample: ${seller.cardListings} card listings and ${seller.otherListings} other listings across ${seller.categories.join(", ")}.`,
    ].filter(Boolean).join(" ") : "";
    const deliveredEstimate = card?.buyingOption === "FIXED_PRICE" && card.currentPrice !== null && card.shipping !== null
        ? acquisitionCost(card.currentPrice, card.shipping, MONEY_CONFIG.buying) : null;
    const copySummary = initial?.summary ?? [card!.isGraded ? "Listed graded" : "Listed raw", card!.cardCondition,
        card!.listedAt && `Listed ${card!.listedAt}`, deliveredEstimate !== null ? `Estimated delivered cost ${dollars(deliveredEstimate)}` :
            card!.currentPrice != null && `Item price ${dollars(card!.currentPrice)} before delivery and tax`,
        analysisPriority(card!, targets, deps.now()).reason].filter(Boolean).join(". ");
    const auctionClues = auction && card ? [
        card.endTime && `Auction ends ${card.endTime}.`,
        seller && `Seller inventory sample: ${seller.cardListings} card listings and ${seller.otherListings} other listings across ${seller.categories.join(", ")}. This guides photo checks only.`,
        (card.screen?.gradingLead || row?.gradingLead) && "Initial screening suggests grading upside. Inspect the originals and compare the likely grade and one lower.",
    ].filter(Boolean).join(" ") : "";
    return {
        retire,
        snapshot: () => ({ evaluation: value, listing: card, retired, retireReason, differentArtwork, artworkVerified, european, guide, resaleReview, checkFullListing }),
        restore(progress) {
            const other = progress.evaluation;
            if (other && (other.listing.id !== id || !matches(other) ||
                value && (value.pricesCheckedAt ?? "") > (other.pricesCheckedAt ?? "") ||
                value && evaluationContextKey({ ...value.listing, images: value.listing.photos ?? [] }) !==
                    evaluationContextKey({ ...other.listing, images: other.listing.photos ?? [] }))) return false;
            if (other) value = other;
            card = progress.listing ?? card;
            differentArtwork = progress.differentArtwork === true;
            ({ retired, retireReason, artworkVerified, european, checkFullListing } = progress);
            guide = progress.guide;
            resaleReview = progress.resaleReview;
            if (value && !retired && artworkVerified) evaluations.set(id, value);
            else evaluations.delete(id);
            return true;
        },
        listingId: id, title: initial?.title ?? card!.title,
        ...(freshRawGradingLead && { freshRawGradingLead }),
        summary: [row?.marketSupply, row?.collectorQuery && `Found through “${row.collectorQuery}”. Inspect the original front to verify the searched card and number.`,
            auctionClues, freshClues, copySummary].filter(Boolean).join(" "),
        liveListing() {
            if (!card || retired || !artworkVerified) return null;
            const latest = value ? withFreshListing(card, value) : card;
            if (!latest.images.length || latest.availability === "UNAVAILABLE" ||
                latest.endTime && !(Date.parse(latest.endTime) > deps.now()) ||
                auction && !withinOpportunityWindow(latest.endTime, deps.now()) ||
                freshGrading && freshListingTime(latest, deps.now()) === null) return null;
            return latest;
        },
        marketPrices(listing) {
            const now = deps.now(), prices = listingMarketPrices(value, listing, now);
            if (!prices || !value || retired || !artworkVerified) return;
            const matched = european?.market === cardmarketComparisonKey(value) ? european.comparison : undefined;
            const exit = value.underwriting?.best;
            const physical = goal === "resell" && listing.buyingOption === "FIXED_PRICE";
            const competitor = physical ? competition(value, null, now).cheapest : null;
            const projection = physical && exit && !huntPhotoIdentityIssue(value) && currentPriceEvidence(value, now)
                ? relistEstimate(value, exit, competitor, now, validReview()?.statistic) : null;
            return { ...prices, trend: validReview()?.trend ?? undefined, ...(competitor && !projection && { verifiedComparable: competitor }), ...(projection && exit?.salePrice && { flipResale: { current: exit.salePrice, expected: projection.price,
                competitor: projection.competitor } }), additional: [...(prices.additional ?? []), ...(validReview()?.prices ?? []), ...providerPrices(value, now, matched), ...(guide?.market === cardmarketComparisonKey(value) ? guide.prices.filter(row => row.validUntil > now) : [])].filter(buyerVisiblePrice) };
        },
        available(checked) {
            if (retired) return [];
            if (!artworkVerified) return auction && !value && !checked.has("check_listing") ? ["check_listing"] : ["inspect_photos"];
            const evidence = reader();
            if (requireLiquidity && !validReview()) {
                pendingResalePath = finalistPath(evidence?.outcome(checked));
                if (pendingResalePath) return ["review_resale"];
            }
            const actions = evidence?.available(checked);
            if (!actions) return auction && !checked.has("check_listing") ? ["check_listing", "inspect_photos"] : ["inspect_photos"];
            if (goal !== "resell" || !actions.includes("check_price_references") ||
                !preferRecentSales && !tcgplayerComparison(value?.rawPricing)) return actions;
            const sources: DealHuntAction[] = ["check_price_tracker", "search_web_sales", "check_market_guides"];
            if (value?.identity?.recordId) sources.push("check_price_history", "compare_cardmarket");
            return [...actions.filter(action => action !== "check_price_references"), ...sources.filter(source => !checked.has(source))];
        },
        canRepeat: (action, checked) => !retired && artworkVerified && reader()?.canRepeat?.(action, checked) === true,
        outcome(checked) {
            if (!value || retired || !artworkVerified) return null;
            const evidence = reader();
            if (evidence?.available(checked).includes("check_price_references") &&
                !(checked.has("check_price_tracker") && checked.has("search_web_sales"))) return null;
            const searched = checked.has("check_price_tracker") || checked.has("search_web_sales");
            const result = evidence?.outcome(searched ? new Set([...checked, "check_price_references"]) : checked);
            if (!result) return null;
            if (verifyPhotoIdentity && (result.decision === "BUY" || result.priceGap)) {
                const reason = huntPhotoIdentityIssue(value);
                if (reason) return { decision: "WAIT", section: "photos", reason };
                if (!(result.recentSales && result.recentSales > 0))
                    return { decision: "WAIT", section: "sales", reason: "No recent matching sales confirmed liquidity for this resale route." };
            }
            const { price, shipping } = value.listing;
            if (filters.maxPrice !== undefined && price !== null && shipping !== null) {
                const item = auction ? nextAuctionBid(value.listing, deps.now()) : price;
                const total = item === null ? null : acquisitionCost(item, shipping, MONEY_CONFIG.buying);
                if (total != null && total > filters.maxPrice) return { decision: "WAIT", section: result.section,
                    reason: `The purchase totals ${dollars(total)} after shipping and estimated tax, above your ${dollars(filters.maxPrice)} limit.` };
            }
            if (freshGrading && result.decision === "BUY" && row) {
                const opportunity = newGradingOpportunity(value, deps.now(), targets, withFreshListing(row.listing, value), filters.maxPrice);
                if (!opportunity) return { decision: "WAIT", section: "grading",
                    reason: `${result.reason} A fresh grading buy requires front and back evidence, a supported value at the likely grade, and a profitable sale comparison one grade lower.` };
                const activity = (quote: typeof opportunity.likely) => quote.sales60 === undefined ? `${quote.sales30} sales in 30 days` : `${quote.sales60} sales in 60 days`;
                return { ...result, verifiedPurchase: opportunity.verifiedPurchase, section: "grading", reason: `Grading with ${opportunity.grader} costs ${dollars(opportunity.gradingCosts)} including submission shipping. Grade ${opportunity.likely.grade} projects ${dollars(opportunity.likely.profit)} profit after costs (${activity(opportunity.likely)}). One grade lower, grade ${opportunity.lower.grade} projects ${dollars(opportunity.lower.profit)} (${activity(opportunity.lower)}).` };
            }
            const finalPath = finalistPath(result);
            if (finalPath) {
                const review = validReview();
                if (!review) return checked.has("review_resale")
                    ? { decision: "WAIT", section: "sales", reason: "The competition or resale evidence changed during verification." } : null;
                if (!review.supported) return { decision: "WAIT", section: "sales", reason: review.reason };
                if (auction) {
                    const projection = relistEstimate(value, finalPath, review.competitor, deps.now(), review.statistic);
                    if (projection && projection.price < (finalPath.salePrice ?? 0)) return { decision: "WAIT", section: "sales",
                        reason: "Current matched sales do not support the resale price used for the bid limit." };
                }
                return { ...result, reason: result.reason + " " + review.reason, hasSupplyEvidence: true, marketReviewed: true,
                    liquidityValidThrough: Math.min(result.liquidityValidThrough ?? Infinity, review.validUntil) };
            }
            if (goal === "resell" && result.decision === "BUY") {
                return { ...result, ...(row?.marketSupply && { hasSupplyEvidence: true }) };
            }
            return result;
        },
        async read(action, signal) {
            signal?.throwIfAborted();
            if (retired) return "This copy was excluded from the search.";
            if (!artworkVerified && action !== "inspect_photos" && !(auction && !value && action === "check_listing")) return "Check the original front against the catalog first.";
            if (action === "review_resale" && value) {
                const path = pendingResalePath;
                if (!path) return "The current terms no longer support a resale review.";
                const review = await deps.reviewResale(value, path, signal ?? new AbortController().signal);
                resaleReview = { ...review, market: marketKey(value) };
                return review.reason;
            }
            const checkRaw = action === "check_raw_resale" || action === "check_sales" && value?.underwriting?.verdict === "CANT_PRICE";
            if (checkRaw && value) {
                const raw = await deps.restoreRaw(value, deps.now(), signal);
                if (raw) value = retargetEvaluation({ ...value, rawPricing: raw }, targets);
            }
            try {
                if (!value) {
                    if (auction && action === "check_listing" && row) {
                        const detail = await deps.details(id, { maxAgeHours: 0, keepReserve: true, signal });
                        if (detail.id !== id || detail.buyingOption !== "AUCTION" || detail.availability !== "ACTIVE" ||
                            !withinOpportunityWindow(detail.endTime, deps.now()) || detail.title.trim() !== row.listing.title.trim() ||
                            !searchPhotosFitDetails(row.listing.images, detail.images)) return retire("The auction changed or ended before its photos were assessed.");
                        const quote = detail.auctionBids && detail.retrievedAt ? { ...detail.auctionBids, checkedAt: detail.retrievedAt } : undefined;
                        const next = nextAuctionBid({ ...detail, auctionQuote: quote }, deps.now());
                        if (next === null || detail.shipping === null) return retire("A fresh next bid and destination shipping are needed to support an auction bid.");
                        const total = acquisitionCost(next, detail.shipping, MONEY_CONFIG.buying);
                        if (total > (filters.maxPrice ?? Infinity) || markets.length &&
                            markets.every(m => next > marketItemLimit(m, goal, targets, detail.shipping!))) {
                            return retire(`At the next bid of ${dollars(next)}, delivery totals ${dollars(total)}. That exceeds the buyer’s budget or the ceiling supported by the researched exits.`);
                        }
                        card = { ...row.listing, currentPrice: detail.price, shipping: detail.shipping, shippingDestination: detail.shippingDestination, images: detail.images,
                            availability: detail.availability, endTime: detail.endTime, bids: detail.bids, termsCheckedAt: detail.retrievedAt };
                        return `eBay shows the next bid at ${dollars(next)} and the total with shipping and estimated tax at ${dollars(total)}. The original photos can now be assessed.`;
                    }
                    if (action !== "inspect_photos" || !row?.assessable) return retire("This copy has no eligible photo check.");
                    value = await deps.evaluate(id, { automatic: true, ...(preferRecentSales && goal === "resell" && { deferSupplemental: true }), typeFilter: format, targets, signal });
                    if (row.listing.title.trim() !== value.listing.title.trim() ||
                        !searchPhotosFitDetails(row.listing.images, value.listing.photos ?? [])) {
                        return retire("The listing or gallery changed since this search. Its original evidence cannot support a buy.");
                    }
                } else if (action === "resolve_printing" || action === "inspect_photos" && !artworkVerified && huntPrintingCheck(value) === "release") {
                    if (!huntPrintingCheck(value) || !huntPrintingTerms(value.listing, deps.now(), filters.maxPrice))
                        return "The current terms or original gallery do not warrant another printing check.";
                    const originalSearch = saved?.searchId ?? searchId;
                    const focused = await withAiUsageContext({ searchId: originalSearch, listingId: id }, () =>
                        deps.evaluate(id, { priceOnly: true, huntPrinting: { maxDelivered: filters.maxPrice }, typeFilter: format, targets, signal }));
                    if (evaluationContextKey({ ...focused.listing, images: focused.listing.photos ?? [] }) !==
                        evaluationContextKey({ ...value.listing, images: value.listing.photos ?? [] }) ||
                        focused.listing.cardCondition !== value.listing.cardCondition ||
                        JSON.stringify(focused.listing.conditionNotes) !== JSON.stringify(value.listing.conditionNotes))
                        return retire("The listing changed during its printing check. Its previous evidence no longer applies.");
                    value = focused;
                } else if (action === "check_market_guides" && value.identity) {
                    if (!reader()?.available(referencePrerequisites).includes("check_price_references"))
                        return "The current terms no longer warrant a guide lookup.";
                    const result = await deps.checkMarketGuides(value, signal ?? new AbortController().signal);
                    guide = { market: cardmarketComparisonKey(value), prices: result.prices };
                    return result.observation;
                } else if (action === "check_price_history" || action === "compare_cardmarket") {
                    if (!reader()?.available(referencePrerequisites).includes("check_price_references")) return "The current copy no longer needs this reference.";
                    if (action === "check_price_history") {
                        const history = await deps.marketHistory(value, deps.now());
                        signal?.throwIfAborted();
                        const latest = history.points.at(-1);
                        return latest ? `${history.source} for ${history.scope}. Observed ${history.points.length} days. Latest price ${dollars(latest.price)} on ${latest.day}. ${history.reason}` : history.reason;
                    }
                    const result = await deps.compareCardmarket(value, { now: deps.now });
                    signal?.throwIfAborted();
                    european = { market: cardmarketComparisonKey(value), comparison: result };
                    return result.offers.length ? `Cardmarket has ${result.offers.length} matched active offers, starting at €${result.offers[0].priceEur.toFixed(2)} before delivery. These are European asking prices.`
                        : result.reason ?? "Cardmarket returned no matching offers.";
                } else if (action === "check_price_references" || action === "check_price_tracker" || action === "search_web_sales") {
                    const eligible = () => reader()?.available(referencePrerequisites).includes("check_price_references");
                    if (!eligible()) return "The current listing terms or market evidence no longer warrant a supplemental lookup.";
                    const now = deps.now();
                    const source = action === "check_price_tracker" ? "tracker" as const : action === "search_web_sales" ? "web" as const : undefined;
                    const options = { now, signal: signal ?? new AbortController().signal, source,
                        ...(tcgplayerComparison(value.rawPricing) && { comparePrices: true }) };
                    const cached = await deps.supplement(value, { ...options, cacheOnly: true });
                    value = { ...value, ...cached };
                    if (eligible()) {
                        signal?.throwIfAborted();
                        value = { ...value, ...await deps.supplement(value, { ...options, cacheOnly: false }) };
                    }
                } else if (action === "check_listing" && value.listing.availability !== "UNAVAILABLE") {
                    const age = deps.now() - Date.parse(value.listing.termsCheckedAt ?? "");
                    if (checkFullListing || !(age >= 0 && age < BEST_BUY_TERMS_MAX_AGE_MS) ||
                        (value.listing.shippingDestination ?? null) !== configuredShippingZip() || auction && nextAuctionBid(value.listing, deps.now()) === null) {
                        const details = await deps.details(id, { maxAgeHours: auction ? 0 : BEST_BUY_TERMS_MAX_AGE_MS / 3_600_000, keepReserve: true, signal });
                        if (details.id !== id || details.buyingOption !== format || exclusionReason({ title: details.title, itemId: id, itemGroupType: details.itemGroupType }) ||
                            evaluationContextKey(details) !== evaluationContextKey({ title: value.listing.title, images: value.listing.photos ?? [], aspects: value.listing.aspects })) {
                            return retire("The listing or gallery changed since the photo assessment. Its earlier evidence cannot support a buy.");
                        }
                        const assessed = checkFullListing && saved ? saved.evaluation.listing : value.listing;
                        if (details.cardCondition !== assessed.cardCondition ||
                            JSON.stringify(details.conditionNotes) !== JSON.stringify(assessed.conditionNotes)) {
                            return retire("The seller changed the condition disclosure. The previous condition assessment no longer supports this purchase.");
                        }
                        value = retargetEvaluation({ ...value, listing: { ...value.listing, price: details.price, shipping: details.shipping,
                            shippingDestination: details.shippingDestination,
                            availability: details.availability, termsCheckedAt: details.retrievedAt, endTime: details.endTime, bids: details.bids,
                            ...(auction && { auctionQuote: details.auctionBids && details.retrievedAt ? { ...details.auctionBids, checkedAt: details.retrievedAt } : undefined }),
                            seller: details.seller, cardCondition: details.cardCondition, conditionNotes: details.conditionNotes } }, targets);
                        checkFullListing = false;
                    }
                } else if (value.listing.availability === "ACTIVE" && (
                    (action === "check_sales" || action === "check_raw_resale") && saved && isSearchDiagnosticId(saved.searchId) && !currentPriceEvidence(value, deps.now()) ||
                    value.gradingPricesDeferred && (action === "calculate_grading" || action === "check_sales" && !hasVerifiedRawFlip(value, targets, deps.now())))) {
                    // Price-only research retains the original assessment's allowance on a reused copy.
                    const refreshed = await withAiUsageContext({ searchId: saved?.searchId ?? searchId, listingId: id }, () =>
                        deps.evaluate(id, { priceOnly: true, typeFilter: format, targets, signal }));
                    if (evaluationContextKey({ ...refreshed.listing, images: refreshed.listing.photos ?? [] }) !==
                        evaluationContextKey({ ...value.listing, images: value.listing.photos ?? [] }) ||
                        refreshed.listing.cardCondition !== value.listing.cardCondition ||
                        JSON.stringify(refreshed.listing.conditionNotes) !== JSON.stringify(value.listing.conditionNotes)) {
                        return retire("The copy or condition disclosure changed during price research. Its earlier checks no longer apply.");
                    }
                    value = refreshed;
                }
            } catch (error) {
                signal?.throwIfAborted();
                if ((action === "check_price_history" || action === "compare_cardmarket") && error instanceof PricingProviderError && error.kind === "TEMPORARY")
                    return "This source was temporarily unavailable. Other sources remain available.";
                if (error instanceof EbayError && [404, 410].includes(error.status)) return retire("This copy is no longer available on eBay.");
                if (error instanceof TypeError && /body is unusable.*already been read/i.test(error.message))
                    return retire("This listing’s provider response could not be read. Checking the next copy.");
                if (aiSpendingFailure(error)?.code === "AI_EVIDENCE_HELD")
                    return retire("The photo or price check for this copy is unresolved. Checking the next listing.");
                if (error instanceof EnglishOnlyError || error instanceof PriceOnlyEvidenceError || error instanceof RejectedPhotoAssessmentError) {
                    return retire("The updated listing could not be matched to eligible photo and price evidence.");
                }
                throw error;
            }
            signal?.throwIfAborted();
            if (value.identity?.notThisCard) return retire(value.identity.notThisCard);
            value = flipResaleEvidence(value, goal, targets);
            if (action === "check_sales" || action === "check_raw_resale") await restoreSavedHuntSales([value], goal, deps.now(), signal);
            let artworkObservation: string | undefined;
            if (!artworkVerified) {
                const assessed = value;
                const exact = row?.exactCard;
                const identity = assessed.identity;
                const market = exact ? identity?.set && sameCatalogName(identity.name, exact.name) &&
                    sameCardNumber(identity.cardNumber, exact.cardNumber) && (!exact.set || sameSetFamily(identity.set, exact.set))
                    ? { name: exact.name, cardNumber: exact.cardNumber, set: identity.set } : undefined
                    : markets.find(lead => photoMatchesCollectorMarket(assessed, lead));
                if (exact && !market) return retire("The original front did not establish the requested printing.");
                if (!market) return retire(`The original front did not verify the card and printing sought by “${row?.collectorQuery}”.`);
                const result = await deps.verifyCollectorArtwork(assessed, market, signal);
                signal?.throwIfAborted();
                if (!result.matches) {
                    differentArtwork = result.differentArtwork === true;
                    return retire(result.reason);
                }
                artworkVerified = true;
                artworkObservation = result.reason;
            }
            const evidence = reader();
            if (value.listing.id !== id || !matches(value) || !evidence) return retire("The verified copy falls outside the search, comparison market or buyer goal.");
            evaluations.set(id, value);
            const observation = await evidence.read(action, signal);
            const comparison = goal === "resell" && action === "check_sales" && value.identity && !huntPhotoIdentityIssue(value)
                ? await deps.priceCharting(value.identity, signal, { evaluation: value }) : null;
            if (comparison) guide = { market: cardmarketComparisonKey(value), prices: comparison.prices, ebayActivity: comparison.ebayActivity };
            return [artworkObservation, observation, comparison?.observation].filter(Boolean).join(" ");
        },
    };
}

interface WatchCheckpoint {
    // The listing and its accepted work already live in the saved source page and journal.
    pricingRetries?: Record<string, { scope: string; at: number; fingerprint: string; action: DealHuntAction }>;
    backlogs?: Record<string, { target: InventoryTarget; backlog: DiscoveryBacklog; supply?: { total: number; seenAt: number } }>;
    rounds: number;
    nextCheckAt: number;
    offsets: Record<string, number>;
    checked: Record<string, number>;
    waitingForQuota?: true;
}

function listingFingerprint(row: ListingSummary) {
    return createHash("sha256").update(JSON.stringify([row.id, row.title, row.currentPrice, row.shipping,
        row.images, row.buyingOption, row.bids, row.bestOffer, row.isGraded, row.endTime])).digest("hex");
}

export function createDealHuntService(overrides: Partial<Dependencies> = {}) {
    const deps = { ...defaults, ...overrides };
    const share = createSharedWork();
    return (searchId: string, input: unknown, signal: AbortSignal): Promise<DealHuntResponse> => {
        if (!isSearchDiagnosticId(searchId)) throw new DealHuntInputError("A valid completed search is required.");
        const request = dealHuntRequest(input);
        const { listingIds, batchIds = [], goal, targets, scope, standalone, freshListings, minPotentialGrade = 0 } = request;
        const budgetSearchId = getBudgetContext().searchId ?? searchId;
        const criteria = JSON.stringify([request, configuredShippingZip()]);
        const context = { searchId, ...(budgetSearchId !== searchId && { watchBudgetId: budgetSearchId }) };
        const execute = (active: AbortSignal, journal: FlipJournal<WatchCheckpoint, DealHuntResponse, CopyProgress> | null) =>
            withPriceResearchSignal(active, () => withAiUsageContext(context, () => huntProgress.observe(budgetSearchId, searchId, active, async (progress): Promise<DealHuntResponse> => {
            const watchKey = request.watch ? "private-hunt-watch:v1:" + createHash("sha256")
                .update(JSON.stringify([budgetSearchId, searchId, request])).digest("hex") : null;
            const watch: WatchCheckpoint | null = watchKey ? journal?.checkpoint ?? await readCache<WatchCheckpoint>(watchKey, 24) ??
                { rounds: 0, nextCheckAt: 0, offsets: {}, checked: {} } : null;
            if (watch) {
                if (watch.nextCheckAt <= deps.now()) {
                    const reset = await deps.browseReserveReset(active);
                    if (reset && reset > deps.now()) {
                        watch.nextCheckAt = reset;
                        watch.waitingForQuota = true;
                        await journal!.savePage(watch);
                    }
                }
                if (watch.nextCheckAt > deps.now()) {
                    const last = journal?.previous;
                    if (last?.evaluation && !watch.waitingForQuota && last.nextCheckAt === watch.nextCheckAt &&
                        (goal !== "resell" || !standalone && !request.marketPreferences?.preferRecentSales ||
                            ((last.report.liquidityValidThrough ?? 0) >= deps.now() &&
                                (last.report.decision !== "BUY" || last.report.verifiedPurchase?.path.path === "GRADE" ||
                                    last.report.steps.some(step => step.action === "review_resale" && step.listingId === last.evaluation?.listing.id)))) &&
                        (last.report.decision === "BUY" && applyVerifiedPurchase(last.evaluation, last.report.verifiedPurchase, targets, deps.now(), request.filters?.maxPrice) ||
                         last.report.decision === "BID" && last.auctionOpportunity?.validUntil && last.auctionOpportunity.validUntil > deps.now() &&
                         auctionOpportunity(last.evaluation, targets, deps.now(), request.filters?.maxPrice)?.status === "BID")) return last;
                    if (!watch.waitingForQuota && journal?.previous?.report.decision === "WAIT" && journal.previous.nextCheckAt === watch.nextCheckAt)
                        return journal.previous;
                    return { evaluation: null, nextCheckAt: watch.nextCheckAt, waitingForQuota: watch.waitingForQuota,
                        report: { searchId, goal, decision: "WAIT", destination: null, steps: [],
                            reason: watch.waitingForQuota ? "Waiting for eBay search allowance." : "Waiting for the next inventory check." } };
                }
                delete watch.waitingForQuota;
            }
            const discovery = standalone ? null : await deps.discovery(searchId);
            const diagnostic = standalone && goal === "resell" ? flipDiagnostic(budgetSearchId, searchId, deps.now) : undefined;
            await diagnostic?.("started", { request, usage: await diagnosticUsage(budgetSearchId) });
            if (!standalone && !discovery) throw new DealHuntInputError("This saved search is no longer available.", 404);
            const retainedBy = new Map(discovery?.discovery.retainedIds.map(id => [id, searchId]));
            for (const batchId of batchIds) {
                active.throwIfAborted();
                if (batchId === searchId || await deps.batchOwner(batchId) !== searchId)
                    throw new DealHuntInputError("The search contains a discovery batch from another search.", 409);
                const batch = await deps.discovery(batchId);
                if (!batch) throw new DealHuntInputError("A saved discovery batch is no longer available.", 404);
                for (const id of batch.discovery.retainedIds) if (!retainedBy.has(id)) retainedBy.set(id, batchId);
            }
            if (listingIds.some(id => !retainedBy.has(id))) throw new DealHuntInputError("The search contains a listing outside this search.", 409);
            const inventory = standalone ? null : await deps.inventory(searchId);
            const inventories = new Map([[searchId, inventory]]);
            for (const batchId of batchIds) {
                const saved = await deps.inventory(batchId);
                if (!saved) throw new DealHuntInputError("A saved discovery batch is no longer available.", 404);
                inventories.set(batchId, saved);
            }
            const previous = inventory?.filters;
            const requested = request.filters;
            const format = requested?.typeFilter === "AUCTION" || previous?.typeFilter === "AUCTION" ? "AUCTION" : "FIXED_PRICE";
            const freshGrading = standalone === true && goal === "grade_raw";
            if (previous?.typeFilter && previous.typeFilter !== "all" && requested?.typeFilter && requested.typeFilter !== "all" &&
                previous.typeFilter !== requested.typeFilter || previous?.kindFilter && previous.kindFilter !== "all" &&
                requested?.kindFilter && requested.kindFilter !== "all" && previous.kindFilter !== requested.kindFilter)
                throw new DealHuntInputError("The current card type or listing format conflicts with the original search.");
            const ceilings = [previous?.maxPrice, requested?.maxPrice].filter((p): p is number => p !== undefined);
            const filters: ListingFilters = { typeFilter: format, minPrice: Math.max(previous?.minPrice ?? 0, requested?.minPrice ?? 0),
                kindFilter: freshGrading ? "raw" : previous?.kindFilter && previous.kindFilter !== "all" ? previous.kindFilter : requested?.kindFilter,
                maxPrice: ceilings.length ? Math.min(...ceilings) : undefined };
            const { minYear, maxYear, finish, sets, printing, grader, minGrade, maxGrade } = request.marketPreferences ?? {};
            const preferRecentSales = freshListings || request.marketPreferences?.preferRecentSales;
            const requireLiquidity = standalone && goal === "resell" || preferRecentSales;
            const yearRange = minYear !== undefined || maxYear !== undefined;
            const years = yearRange ? await deps.setYears() : {};
            const acceptsSet = (set?: string | null) => {
                if (sets?.length && (!set || !sets.some(wanted => sameSetFamily(set, wanted)))) return false;
                if (!yearRange) return true;
                const year = yearOf(years, set);
                return year !== null && year >= (minYear ?? 1900) && year <= (maxYear ?? 2100);
            };
            const acceptsMarket = (set?: string | null, cardFinish?: string | null) => (!finish || finish === cardFinish) && acceptsSet(set);
            const preferenceIntent: SearchIntent = { cardName: null, sets: [], cardNumber: null, printing: printing ?? null,
                graded: grader || minGrade !== undefined || maxGrade !== undefined ? true : null,
                grader: grader ?? null, minGrade: minGrade ?? null, maxGrade: maxGrade ?? null, finish: finish ?? null,
                titleWords: [], source: "rules" };
            const acceptsEvaluation = (evaluation: Evaluation) => acceptsMarket(evaluation.identity?.set, evaluation.identity?.finish) &&
                !evaluatedCriteriaMismatch(evaluation, preferenceIntent);
            const rows = new Map([...inventories].flatMap(([batchId, saved]) => (saved?.rows ?? [])
                .filter(row => retainedBy.get(row.listing.id) === batchId && row.listing.buyingOption === format &&
                    (!row.excludedFromHunt || format === "AUCTION" && row.assessable && !row.listing.match && englishListingEligible(row.listing)))
                .map(row => [row.listing.id, row] as const)));
            const evaluations = new FlipEvaluations();
            const discarded = new Set<string>();
            const candidates: DealHuntCandidate[] = [];
            const alternatives = new Map<string, { candidate: ScopedCandidate; leads: HuntMarket[]; reason: string }>();
            const exclusions = new Map<string, string>();
            const presentedRetries = new Set<string>();
            const previewLeads = new Map<string, PreviewLead>();
            const observeCandidate = (candidate: ScopedCandidate, source?: ListingSummary, scope?: string): ScopedCandidate => {
                const taskKey = source && source.id + ":" + createHash("sha256").update(JSON.stringify([listingFingerprint(source), source.listedAttributes,
                    source.seller, source.match, source.listedAt, source.createdAt, scope])).digest("hex");
                const prior = taskKey && journal ? journal.task(taskKey) : null;
                const accepted = prior?.receipt;
                const restored = accepted && !(accepted.evidence.retired && !accepted.evidence.differentArtwork &&
                    accepted.round !== watch?.rounds) && candidate.restore(accepted.evidence);
                if (restored && accepted.evidence.retireReason) exclusions.set(candidate.title, accepted.evidence.retireReason);
                const done = new Set<DealHuntAction>(restored ? accepted.done : []);
                if (restored && (!accepted.evidence.evaluation || !currentPriceEvidence(accepted.evidence.evaluation, deps.now())))
                    for (const action of [...done]) if (action !== "inspect_photos") done.delete(action);
                if (restored && accepted.evidence.quotaNote) {
                    done.delete("check_sales");
                    done.delete("check_raw_resale");
                    done.delete("check_listing");
                }
                const termsAge = deps.now() - Date.parse(accepted?.evidence.evaluation?.listing.termsCheckedAt ?? "");
                if (restored && !(termsAge >= 0 && termsAge < BEST_BUY_TERMS_MAX_AGE_MS))
                    done.delete("check_listing");
                if (!accepted?.evidence.resaleReview || accepted.evidence.resaleReview.validUntil <= deps.now())
                    done.delete("review_resale");
                const interrupted = prior?.inFlight;
                if (interrupted) done.delete(interrupted);
                let recovering = interrupted;
                const listing = source ?? rows.get(candidate.listingId)?.listing;
                const screened = listing && standalone && freshListings && goal === "resell" && format === "FIXED_PRICE";
                const preview = previewLeads.get(candidate.listingId);
                let deferred = false;
                return { ...candidate, resumedActions: [...done],
                ...(preview && { summary: candidate.summary + " Preliminary preview observation: " + preview.observation + " Gallery question: " + preview.question }),
                ...(screened && { reviewPriority: { band: resaleReviewPriority(listing, targets, deps.now()),
                    market: listing.screen?.card?.cardNumber && discoveryMarketKey(listing) !== listing.id
                        ? discoveryMarketKey(listing) : scope ?? "unidentified" } }),
                available: checked => deferred ? [] : recovering ? [recovering] : candidate.available(checked),
                outcome: checked => deferred || recovering ? null : candidate.outcome(checked),
                async read(action, signal) {
                    await diagnostic?.("check", { id: candidate.listingId, action });
                    signal?.throwIfAborted();
                    if (journal && taskKey) await journal.start(taskKey, action);
                    let missing = false;
                    let observation: string;
                    if (recovering === "review_resale") candidate.available(done);
                    try {
                        observation = recovering
                            ? await withSavedProviderEvidence(() => { missing = true; }, () => candidate.read(action, signal))
                            : await candidate.read(action, signal);
                    } catch (error) {
                        if (missing) {
                            recovering = null;
                            return candidate.retire("An interrupted check is still awaiting confirmed provider evidence.");
                        }
                        if (watch && journal && taskKey && scope && source && watch.backlogs?.[scope] &&
                            (action === "check_sales" || action === "check_raw_resale" || action === "calculate_grading") &&
                            error instanceof PricingProviderError && error.kind === "TEMPORARY") {
                            const retry = { scope, action, at: Math.max(deps.now() + 1000, error.retryAt ?? deps.now() + 30_000),
                                fingerprint: listingFingerprint(source) };
                            (watch.pricingRetries ??= {})[source.id] = retry;
                            deferred = true;
                            // Commit the deferred task and its cooldown together so a restart sees both.
                            await journal.accept(taskKey, { round: watch.rounds, done: [...done], next: [action], evidence: candidate.snapshot() }, watch);
                            return "Pricing is temporarily unavailable for this copy. Its completed checks are saved.";
                        }
                        // A provider guard that refused dispatch is eligible again at reset.
                        if (journal && taskKey && (error instanceof EbayBudgetError || error instanceof PricingProviderError && error.kind === "RATE_LIMIT"))
                            await journal.accept(taskKey, { done: [...done], next: [action], evidence: candidate.snapshot() });
                        throw error;
                    }
                    if (missing) {
                        recovering = null;
                        return candidate.retire("An interrupted check is still awaiting confirmed provider evidence.");
                    }
                    recovering = null;
                    done.add(action);
                    const finishedRetry = source && watch?.pricingRetries?.[source.id]?.action === action;
                    if (finishedRetry) delete watch!.pricingRetries![source.id];
                    if (journal && taskKey) {
                        const receipt: FlipTask<CopyProgress> = { round: watch?.rounds, done: [...done], next: candidate.available(done).filter(next => !done.has(next) || candidate.canRepeat?.(next, done)), evidence: candidate.snapshot() };
                        await journal.accept(taskKey, receipt, finishedRetry ? watch ?? undefined : undefined);
                    }
                    const status = candidate.snapshot();
                    if (status.retireReason) exclusions.set(candidate.title, status.retireReason);
                    if (status.differentArtwork && watch && source) watch.checked[listingFingerprint(source)] = deps.now() + 6 * 3_600_000;
                    const valued = evaluations.get(candidate.listingId);
                    await diagnostic?.("observation", { id: candidate.listingId, action, observation,
                        ...(action === "review_resale" && status.resaleReview?.forecast && { rawForecast: status.resaleReview.forecast }),
                        verdict: valued?.underwriting?.verdict,
                        pricedProfit: valued?.underwriting?.best && !huntPhotoIdentityIssue(valued) && currentPriceEvidence(valued, deps.now())
                            ? valued.underwriting.best.profit : null });
                    const listing = candidate.liveListing();
                    if (listing) progress.candidates?.([{ ...listing, marketPrices: candidate.marketPrices(listing) }]);
                    return observation;
                } };
            };
            // Keep private SQL reads bounded. Preserve display order even if reads finish out of order.
            for (let offset = 0; offset < listingIds.length; offset += 4) {
                active.throwIfAborted();
                const batch = listingIds.slice(offset, offset + 4).filter(id => !inventories.get(retainedBy.get(id)!) || rows.has(id));
                const snapshots = await Promise.all(batch.map(id => deps.snapshot(id)));
                batch.forEach((id, index) => {
                    const batchId = retainedBy.get(id)!;
                    const candidate = scopedCandidate(id, goal, targets, batchId, snapshots[index], inventories.get(batchId) ?? null,
                        rows.get(id), evaluations, deps, filters, minPotentialGrade, acceptsEvaluation, { preferRecentSales, requireLiquidity });
                    if (candidate) candidates.push(observeCandidate(batchId === searchId ? candidate : { ...candidate,
                        read: (action, signal) => withAiUsageContext({ searchId: batchId, watchBudgetId: searchId, listingId: id },
                            () => candidate.read(action, signal)) }));
                });
                progress.retain(candidates.length);
            }
            const markets: DealHuntMarket[] = [];
            const searchedPrices: string[] = [];
            let marketNote: string | undefined;
            let inventoryCoverage: (() => string) | undefined;
            if (scope === "any_card" || scope === "same_set") {
                const origin = huntOrigin(inventory?.intent, evaluations.values());
                const guided = request.marketPreferences?.seed;
                const rankBlank = standalone && goal === "resell" && request.marketPreferences?.preferRecentSales && !guided && !yearRange && !sets?.length && !finish && !printing;
                const leads = rankBlank || guided || freshListings || scope === "same_set" && !origin ? [] : await deps.markets(origin, goal, scope, active, acceptsSet);
                active.throwIfAborted();
                const knownIds = new Set(retainedBy.keys());
                const permitted = leads.filter(lead => acceptsMarket(lead.set, lead.finish) && keepsSetSearchPreferences(lead, preferenceIntent) &&
                    (scope !== "same_set" || keepsSetSearchPreferences(lead, inventory?.intent)));

                async function rankFreshCopies<T extends { listing: ListingSummary }>(copies: T[]) {
                    if (freshListings && standalone && goal === "resell" && format === "FIXED_PRICE" && copies.some(copy => !copy.listing.isGraded)) {
                        const pool = copies.slice(0, DEVELOPMENT_SEARCH_LIMIT);
                        let selection;
                        try {
                            selection = await deps.selectFlipPreviews(pool.map(copy => copy.listing), targets, active, deps.now());
                        } catch (error) {
                            active.throwIfAborted();
                            if (aiSpendingFailure(error) || error instanceof StorageUnavailableError) throw error;
                            await diagnostic?.("selection", { source: "unavailable", previous: pool.map(copy => copy.listing.id) });
                            return copies;
                        }
                        for (const lead of selection.leads) previewLeads.set(lead.id, lead);
                        const byId = new Map(pool.map(copy => [copy.listing.id, copy]));
                        const ordered = orderFlipPreviewCopies(pool.map(copy => copy.listing), selection, targets, deps.now()).map(id => byId.get(id)!);
                        await diagnostic?.("selection", { ...selection, ordered: ordered.map(copy => copy.listing.id) });
                        return [...ordered, ...copies.slice(pool.length)];
                    }
                    if ((!freshGrading && !(freshListings && copies.length > FIRST_REVIEW_COUNT)) || !copies.length) return copies;
                    const pool = copies.slice(0, DEVELOPMENT_SEARCH_LIMIT);
                    const summaries = pool.map(copy => copy.listing);
                    const rows = freshGrading ? await deps.researchFreshRawSellers(summaries, deps.now(), active) : summaries;
                    const ranked = await deps.selectReviews(rows, targets, active, deps.now());
                    const enriched = new Map(pool.map((copy, index) => [copy.listing.id, { ...copy, listing: rows[index] }]));
                    const priority = new Set(ranked.listingIds);
                    return [...ranked.listingIds.map(id => enriched.get(id)!).filter(Boolean), ...copies.filter(copy => !priority.has(copy.listing.id))];
                }

                async function assessFirstFreshCopies(discovered: DealHuntCandidate[], count: number, source: string) {
                    if (!freshGrading || count < DEVELOPMENT_SEARCH_LIMIT) return;
                    // These closures retain their assessments for every subsequent planner check.
                    let reviewed = 0;
                    const firstReviews = discovered.slice(0, FIRST_REVIEW_COUNT);
                    for (let i = 0; i < firstReviews.length; i += BOUNDED_AUTO_CONCURRENCY) {
                        active.throwIfAborted();
                        const batch = firstReviews.slice(i, i + BOUNDED_AUTO_CONCURRENCY);
                        progress.stage("reviewing", batch[0].title, "inspect_photos");
                        const results = await Promise.allSettled(batch.map(async candidate => {
                            const photos = await withAiUsageContext({ searchId, listingId: candidate.listingId }, () =>
                                Promise.resolve(candidate.read("inspect_photos", active)));
                            candidate.summary = `${photos} ${candidate.summary}`;
                            progress.checked(candidate.listingId, "inspect_photos");
                            if (evaluations.has(candidate.listingId)) reviewed++;
                        }));
                        const failure = results.find(result => result.status === "rejected");
                        if (failure) throw failure.reason;
                    }
                    marketNote = `Reviewed photos for ${reviewed} priority copies. All ${discovered.length} eligible copies remain available for ${source}.`;
                }

                for (const group of groupMarketSearches(permitted, goal, targets, filters, minPotentialGrade, knownIds, preferRecentSales)) {
                    const [intent, ...relatedIntents] = group.intents;
                    const reference = group.leads[0];
                    const recentAsk = group.observedPurchaseTotal === undefined ? "" :
                        ` A matching copy was seen in the last 24 hours at ${dollars(group.observedPurchaseTotal)} including shipping and estimated tax. Check its current price and availability.`;
                    const summary = group.leads.map(describeHuntMarket).join(" ") + recentAsk;
                    const queryOffsets = new Map<MarketQueryObservation["strategy"], number | null>();
                    markets.push({ cardKey: huntMarketCardKey(reference), releaseYear: yearOf(years, reference.set) ?? undefined,
                        title: `${reference.name} ${reference.cardNumber} · ${reference.set}`,
                        summary: summary + ` Research item prices up to ${dollars(group.ceiling)} before adjusting for shipping.`,
                        hasMore: () => [...queryOffsets.values()].some(offset => offset !== null),
                        async discover(_signal?: AbortSignal, reportQueries?: (description: string) => void) {
                            const queries: MarketQueryObservation[] = [];
                            const useNumbers = format === "FIXED_PRICE" && !intent.graded;
                            const found = await deps.discoverMarket(searchId, intent, { ...filters, maxPrice: group.ceiling }, active,
                                { relatedIntents, queryOffsets, onQuery: query => {
                                    queries.push(query);
                                    if (query.status === "complete") progress.source(query.returnedIds.length, 0, 1);
                                }, ...(freshGrading && { newlyListedRaw: true }), ...(useNumbers && {
                                    collectorNumberDiscovery: "compare", knownListingIds: knownIds,
                                    isUsable: listing => group.leads.some(lead => shortlistMarketCopies([listing], lead, goal, targets, filters).length > 0),
                                }) });
                            if (queries.length > 1) {
                                const results = queries.map(q => q.status === "quota" ? `“${q.query}” stopped at the eBay allowance.` :
                                    `eBay reported ${q.total} for “${q.query}”. New eligible listings on this page totaled ${q.newEligibleIds.length}.`);
                                reportQueries?.(`Each query used the same ${dollars(group.ceiling)} item ceiling. ${results.join(" ")}`);
                            }
                            const numberQueries = new Map<string, string>();
                            for (const q of queries) {
                                const ids = q.strategy === "full_name" ? q.numberOnlyIds : [...q.newEligibleIds, ...q.numberOnlyIds];
                                for (const id of ids) if (!numberQueries.has(id)) numberQueries.set(id, q.query);
                            }
                            const listings = format === "AUCTION" && goal !== "resell" ? await deps.researchAuctionSellers(found, deps.now(), active) : found;
                            const label = intent.graded ? `${intent.grader} ${intent.minGrade}` : "raw";
                            searchedPrices.push(`${reference.name} ${reference.cardNumber} (${label}) up to ${dollars(group.ceiling)}`);
                            const fresh = groupMarketCopies(listings, group, goal, targets, filters, deps.now())
                                .filter(({ listing }) => !knownIds.has(listing.id) && matchesListingFilters(listing, filters) &&
                                    (!freshGrading || freshListingTime(listing, deps.now()) !== null));
                            const discovered: DealHuntCandidate[] = [];
                            for (const { listing, leads } of await rankFreshCopies(fresh)) {
                                active.throwIfAborted();
                                const row = { listing, assessable: buyerReviewBlock(listing, deps.now()) === null, collectorQuery: numberQueries.get(listing.id) };
                                const saved = await deps.snapshot(listing.id);
                                // Each candidate verifies the complete identity against its viable exits.
                                const candidate = scopedCandidate(listing.id, goal, targets, searchId, saved, null,
                                    row, evaluations, deps, filters, minPotentialGrade, acceptsEvaluation, { markets: leads, freshGrading, preferRecentSales, requireLiquidity });
                                if (!candidate) continue;
                                const matched = saved ? leads.filter(lead => matchesHuntMarket(saved.evaluation, lead)) : [];
                                const reason = (matched.length ? matched : leads).map(describeHuntMarket).join(" ");
                                knownIds.add(listing.id);
                                const observed = observeCandidate(candidate, listing, JSON.stringify([row.collectorQuery, leads.map(huntMarketCardKey)]));
                                alternatives.set(listing.id, { candidate: observed, leads, reason });
                                discovered.push({ ...observed, summary: `${observed.summary} ${reason} Item ${dollars(listing.currentPrice)}.` });
                            }
                            progress.retain(candidates.length + alternatives.size);
                            progress.candidates?.(discovered.flatMap(candidate => alternatives.get(candidate.listingId)?.candidate.liveListing() ?? []));
                            await assessFirstFreshCopies(discovered, fresh.length, reference.name);
                            return discovered;
                        } });
                }
                const wantsSlabs = goal === "collect_slab" || preferenceIntent.graded === true;
                if (scope === "any_card" && (!wantsSlabs || filters.kindFilter !== "raw")) {
                    const releases = sets?.length ? sets.filter(acceptsSet) : yearRange
                        ? Object.keys(years).filter(acceptsSet).sort((a, b) => years[a] - years[b] || a.localeCompare(b)) : [null];
                    if (guided || freshListings && !sets?.length && !yearRange) progress.stage("planning",
                        guided ? [guided.name, guided.number].filter(Boolean).join(" ") : "Ranking catalog cards by 30 days of completed eBay sales");
                    let chooseRoute: Parameters<DealHuntMarket["discover"]>[2];
                    let reportGuidance: Parameters<DealHuntMarket["discover"]>[1];
                    const guide = guided && deps.guidedInventoryTargets(guided, sets ?? [], filters.kindFilter, deps.now(), active, acceptsSet, undefined, undefined, {
                        years: yearRange ? async () => years : deps.setYears,
                        observedSet: () => {
                            const origin = huntOrigin(undefined, [...evaluations.values()].filter(e => !huntPhotoIdentityIssue(e) && sameCatalogName(e.identity?.name, guided.name)));
                            return origin?.set ?? null;
                        },
                        report: note => reportGuidance?.(note),
                        chooseWeb: async releases => !!chooseRoute && (await chooseRoute([
                            { title: "Continue catalog discovery", summary: "Search the remaining eligible release inventory directly." },
                            { title: "Research related printings on the web", summary: `Look for cited cards in ${releases.slice(0, 6).join(", ")}. Check each lead against the catalog, then compare recorded sales.` },
                        ])) === 1,
                    });
                    const rankMarkets = async () => {
                        try { return await deps.liquidMarkets(filters.kindFilter, deps.now(), active); }
                        catch (error) {
                            active.throwIfAborted();
                            if (!(error instanceof PricingProviderError && error.kind === "TEMPORARY")) throw error;
                            marketNote = "The sampled market ranking was temporarily unavailable. Checking independent eBay inventory.";
                            return [];
                        }
                    };
                    // Use a sold-backed target before spending a Browse page or identifying random singles.
                    let marketRanking: "saved" | "volume" | null = rankBlank && freshListings ? "saved" : null;
                    const ranked = !marketRanking && !guided && (rankBlank || freshListings) && !sets?.length && !yearRange && !finish && !printing
                        ? await rankMarkets() : [];
                    const resumedTargets = Object.values(watch?.backlogs ?? {}).map(entry => entry.target);
                    const dueTargets = Object.values(watch?.pricingRetries ?? {}).filter(r => r.at <= deps.now())
                        .flatMap(r => watch?.backlogs?.[r.scope]?.target ?? []);
                    const pendingTargets: InventoryTarget[] = [...new Map([...dueTargets, ...resumedTargets, ...ranked].map(t => [targetCursor(t, format), t])).values()];
                    const continuedTargets: InventoryTarget[] = [];
                    let guideEnded = !guide;
                    const allowFallback = !guided;
                    let offerWebDiscovery = !guided && standalone && goal === "resell" && preferRecentSales && releases.length > 0;
                    let fallbackIndex = 0;
                    let currentTarget: InventoryTarget | undefined;
                    let paused = false;
                    const exhaustedQueries = new Set<string>();
                    const checkedQueries = new Set<string>();
                    const queryOffsets = new Map<string, number | undefined>();
                    const hasTargets = () => !paused && Boolean(currentTarget || pendingTargets.length || marketRanking || continuedTargets.length || !guideEnded || offerWebDiscovery || allowFallback && fallbackIndex < releases.length);
                    if (hasTargets()) {
                        const scan = deps.inventoryScanner(active);
                        const scanStartedAt = deps.now();
                        const inventoryFilters = wantsSlabs ? { ...filters, kindFilter: "graded" as const } : filters;
                        const intent: SearchIntent = { ...preferenceIntent, minYear, maxYear, releaseYears: years,
                            graded: inventoryFilters.kindFilter === "graded" ? true : inventoryFilters.kindFilter === "raw" ? false : preferenceIntent.graded };
                        let pagesScanned = 0;
                        let batchesScanned = 0;
                        let started = false;
                        let partial = false;
                        inventoryCoverage = () => !started ? "Broader eBay inventory remains unchecked."
                            : `Checked ${pagesScanned} eBay source ${pagesScanned === 1 ? "page" : "pages"} in ${batchesScanned} review ${batchesScanned === 1 ? "batch" : "batches"} across ${checkedQueries.size} ${guided ? "guided " : ""}inventory queries.${partial
                                ? " Coverage remains partial for the source results." : ""}`;
                        markets.push({ source: "inventory", title: freshListings ? "New Buy It Now listings" : "Current eBay inventory",
                            summary: "Search current listings within the buyer's filters. Check each copy and its matching prices before considering a purchase.",
                            hasMore: hasTargets,
                            async discover(_signal, reportQueries, chooseMarket) {
                                if (!hasTargets()) return [];
                                const beforeScanPressure = pagesScanned && (guided || rankBlank) ? await deps.browsePressure() : null;
                                if (beforeScanPressure && beforeScanPressure.remaining <= dailyBrowseReserve(beforeScanPressure.limit)) {
                                    paused = true;
                                    marketNote = "Further market searches paused to preserve the daily eBay allowance.";
                                    return [];
                                }
                                chooseRoute = chooseMarket;
                                reportGuidance = reportQueries;
                                while (!currentTarget) {
                                    if (marketRanking === "saved" && !pendingTargets.length) {
                                        // Retained copies take their turn before ranking new markets after a restart.
                                        const [volume, priced] = await Promise.all([
                                            deps.cachedLiquidMarkets(filters.kindFilter, deps.now(), active),
                                            deps.pricedInventoryTargets(filters, targets, active, preferenceIntent),
                                        ]);
                                        active.throwIfAborted();
                                        pendingTargets.push(...priced, ...volume);
                                        marketRanking = volume.length ? null : "volume";
                                        // Reserve an independent page for poorly titled singles.
                                        if (pendingTargets.length) pendingTargets.splice(1, 0, { name: null, set: null, number: null });
                                    }
                                    if (marketRanking === "volume" && !pendingTargets.length) {
                                        marketRanking = null;
                                        pendingTargets.push(...await rankMarkets());
                                        active.throwIfAborted();
                                        if (!checkedQueries.size && pendingTargets.length)
                                            pendingTargets.splice(1, 0, { name: null, set: null, number: null });
                                    }
                                    if (guide && !guideEnded && !pendingTargets.length) {
                                        // Keep seed and set discovery lazy. Group measured markets for the next model choice.
                                        do {
                                            active.throwIfAborted();
                                            const next = await guide.next();
                                            if (next.done) { guideEnded = true; break; }
                                            pendingTargets.push(next.value);
                                            if (next.value.sales === undefined) break;
                                        } while (pendingTargets.length < 3);
                                    }
                                    while (!pendingTargets.length && guideEnded && allowFallback && fallbackIndex < releases.length) {
                                        const fallback = { name: null, number: null, set: releases[fallbackIndex++] };
                                        const query = fallback.set || "Pokemon";
                                        if (!checkedQueries.has(JSON.stringify([query, format]))) pendingTargets.push(fallback);
                                    }
                                    // Give each priority and independent query a first turn before
                                    // revisiting a popular card. Later rounds retain every backlog.
                                    if (!pendingTargets.length && continuedTargets.length)
                                        pendingTargets.push(...continuedTargets.splice(0));
                                    if (!pendingTargets.length && offerWebDiscovery) {
                                        offerWebDiscovery = false;
                                        if (chooseMarket && await chooseMarket([
                                            { title: "Finish this inventory search", summary: "The scanned queries have no remaining copies or pages." },
                                            { title: "Find additional card markets on the web", summary: "Look up cited English printings and check their catalog identities before searching eBay within the buyer's original filters." },
                                        ]) === 1) {
                                            const allowed = releases.filter((set): set is string => set !== null);
                                            const seed = [finish, printing, "Pokémon cards with frequent sales and stable resale prices"].filter(Boolean).join(" ");
                                            pendingTargets.push(...await deps.webInventoryTargets(seed, allowed, inventoryFilters.kindFilter, deps.now(), active, acceptsSet, reportQueries));
                                        }
                                    }
                                    if (!pendingTargets.length) return [];
                                    let targetIndex = 0;
                                    if (chooseMarket && pagesScanned && pendingTargets.length > 1) {
                                        targetIndex = await chooseMarket(pendingTargets.map(target => ({
                                            title: [target.name, target.number, target.set].filter(Boolean).join(" ") || "Current eBay inventory",
                                            summary: target.exactMarket ? target.exactMarket.reason : target.sales === undefined ? "Continue the retained copies and remaining source pages within the buyer's filters."
                                                : catalogActivity(target),
                                        })));
                                    }
                                    active.throwIfAborted();
                                    const [next] = pendingTargets.splice(targetIndex, 1);
                                    if (!exhaustedQueries.has(targetCursor(next, format))) currentTarget = next;
                                }
                                const target = currentTarget;
                                const release = target.set;
                                const query = [target.name, target.number, release].filter(Boolean).join(" ") || "Pokemon";
                                const cursorKey = targetCursor(target, format);
                                let pageOffset = queryOffsets.get(cursorKey);
                                const stageLabel = target?.stage ? target.stage + " · " + query : query === "Pokemon" ? "Newly listed singles across sets" : query;
                                const cohort = target.exactMarket ? stageLabel + " · " + target.exactMarket.reason : target.sales ? stageLabel + " · at least " + target.sales + ` recorded eBay sales in ${target.windowDays ?? 7} days` +
                                    (target.activeDays === undefined ? "" : ` on ${target.activeDays} selling days`) : stageLabel;
                                const scanFilters = target.exactMarket ? { ...inventoryFilters, maxPrice: target.exactMarket.maxItem } : inventoryFilters;
                                const scanIntent = { ...intent, ...target.exactMarket?.intent, sets: release ? [release] : [],
                                    ...(target && { cardName: target.name, cardNumber: target.number, titleWords: target.name ? [target.name] : [] }) };
                                started = true;
                                checkedQueries.add(cursorKey);
                                progress.stage("discovering", stageLabel, "find_listings");
                                let observedFound = 0, observedScreened = 0;
                                const recordSourceCounts = ({ found, screened }: { found: number; screened: number }) => {
                                    const added = Math.max(0, found - observedFound);
                                    const priced = Math.max(0, screened - observedScreened);
                                    if (added || priced) progress.source(added, priced);
                                    observedFound += added;
                                    observedScreened += priced;
                                };
                                const savedPage = watch?.backlogs?.[cursorKey];
                                const savedBacklog = savedPage?.backlog;
                                const requestedAt = deps.now();
                                const retries = watch?.pricingRetries;
                                const due = savedBacklog?.pending.filter(row => {
                                    const retry = retries?.[row.id];
                                    return retry?.scope === cursorKey && retry.at <= requestedAt && !presentedRetries.has(row.id);
                                }).slice(0, DEVELOPMENT_SEARCH_LIMIT) ?? [];
                                for (const row of due) presentedRetries.add(row.id);
                                const { listings, summary, hasMore, sourcePages, backlog, activeSearchTotal } = due.length
                                    ? { listings: due, summary: { total: savedBacklog!.total, found: 0, screened: 0, sourceCoverage: undefined },
                                        hasMore: true, sourcePages: 0, backlog: savedBacklog, activeSearchTotal: undefined }
                                    : await scan(query, scanIntent,
                                    scanFilters, targets, scanStartedAt, { excludeIds: knownIds, freshGrading, diagnostic,
                                        resumeBacklog: savedBacklog,
                                        firstPhotoBatch: Boolean(watch && !watch.rounds && !batchesScanned && freshListings && !freshGrading),
                                        ...(freshListings && { freshListings, recoverTitles: Boolean(target.exactMarket || guided?.number && target.number === guided.number) }),
                                        ...((freshListings || watch) && { offset: pageOffset ?? (watch && watch.rounds % 3 !== 0 ? watch.offsets[cursorKey] : undefined),
                                            onNextPage: offset => {
                                                pageOffset = offset;
                                                queryOffsets.set(cursorKey, offset);
                                                if (watch) watch.offsets[cursorKey] = offset ?? 0;
                                            } }),
                                        ...(watch && { previouslyChecked: row => (watch.checked[listingFingerprint(row)] ?? 0) > deps.now() }),
                                        onStage: stage => progress.stage(stage, stageLabel, "find_listings"), onProgress: recordSourceCounts });
                                const supply = activeSearchTotal !== undefined ? { total: activeSearchTotal, seenAt: requestedAt } : savedPage?.supply;
                                if (watch && watchKey) {
                                    watch.backlogs ??= {};
                                    // Keep returned copies until the planner actually examines them.
                                    // A disconnect between screening and photos can replay the batch.
                                    const unreviewed = (savedBacklog?.pending ?? []).filter(row => knownIds.has(row.id) || retries?.[row.id]?.scope === cursorKey);
                                    const pending = [...new Map([...unreviewed, ...(backlog?.pending ?? []), ...listings].map(row => [row.id, row])).values()];
                                    if (pending.length || backlog?.sources.length) {
                                        const pendingIds = new Set(pending.map(row => row.id));
                                        watch.backlogs[cursorKey] = { target, supply, backlog: { rootSearchId: budgetSearchId, total: summary.total,
                                            request: { search: query, filters: scanFilters, targets, asOf: scanStartedAt },
                                            sources: backlog?.sources ?? [], seenIds: (backlog?.seenIds ?? []).filter(id => !pendingIds.has(id)),
                                            pending, ccgInventory: true } };
                                    } else delete watch.backlogs[cursorKey];
                                    await journal!.savePage(watch);
                                }
                                recordSourceCounts({ found: summary.found, screened: summary.screened ?? 0 });
                                const marketSupply = target.name && target.number && target.set && supply && deps.now() - supply.seenAt <= HUNT_RECHECK_MS
                                    ? [`At the time of the search, eBay reported ${supply.total} active Buy It Now results for “${query}” under the search filters.`,
                                        target.sales ? catalogActivity(target) : "",
                                        "Search results can include other conditions, grades and printings."].filter(Boolean).join(" ")
                                    : undefined;
                                if (marketSupply) reportQueries?.(marketSupply);
                                const queuedInQuery = backlog?.pending.length ?? 0;
                                progress.source(0, 0, sourcePages ?? 1, queuedInQuery);
                                pagesScanned += sourcePages ?? 1;
                                batchesScanned++;
                                // Rotate after a review batch while the scanner retains this query's
                                // copies and cursor. Returning later drains its pending copies first.
                                const pressure = (freshListings || guide || rankBlank) && await deps.browsePressure();
                                if (pressure && pressure.remaining <= dailyBrowseReserve(pressure.limit)) {
                                    paused = true; marketNote = "Further market searches paused to preserve the daily eBay allowance.";
                                }
                                if (hasMore ?? pageOffset !== undefined) continuedTargets.push(target);
                                else {
                                    exhaustedQueries.add(cursorKey);
                                    queryOffsets.delete(cursorKey);
                                }
                                currentTarget = undefined;
                                partial ||= summary.sourceCoverage === "PARTIAL";
                                if (target?.stage) reportQueries?.(cohort);
                                if (target?.sales && !marketSupply) reportQueries?.(`${target.name} ${target.number} · ${catalogActivity(target)} Ranked among sampled catalog cards.`);
                                reportQueries?.(`“${query}” loaded ${summary.found} distinct listing summaries and screened prices for ${summary.screened ?? 0}.${queuedInQuery ? ` ${queuedInQuery} queued in this query for a later batch.` : ""}${summary.sourceCoverage === "PARTIAL"
                                    ? " This scan covered part of the source results." : " Coverage applies to this eBay query."}`);
                                const discovered: DealHuntCandidate[] = [];
                                const current = format === "AUCTION" && goal !== "resell" ? await deps.researchAuctionSellers(listings, deps.now(), active)
                                    : listings;
                                const eligible = current.filter(listing => {
                                    const retry = retries?.[listing.id];
                                    if (retry) {
                                        if (retry.fingerprint !== listingFingerprint(listing)) delete retries![listing.id];
                                        else if (retry.scope !== cursorKey || retry.at > deps.now()) return false;
                                    }
                                    return !knownIds.has(listing.id) && buyerReviewBlock(listing, deps.now()) === null &&
                                        matchesListingFilters(listing, inventoryFilters);
                                });
                                const copies = (freshListings ? freshResaleCandidates(eligible, targets, scanStartedAt) : eligible).map(listing => ({ listing }));
                                const rankedCopies = due.length ? copies : await rankFreshCopies(copies);
                                for await (const { listing, saved } of readCopySnapshots(rankedCopies, deps, active)) {
                                    if (knownIds.has(listing.id)) continue;
                                    const candidate = scopedCandidate(listing.id, goal, targets, searchId, saved, null,
                                        { listing, assessable: true, marketSupply, ...(target.name && target.number && (listing.researchIdentity || target.exactMarket || guided?.number === target.number) &&
                                            { exactCard: { name: target.name, cardNumber: target.number, set: target.set } }) }, evaluations, deps, inventoryFilters, minPotentialGrade,
                                        evaluation => acceptsEvaluation(evaluation) && (!release || sameSetFamily(evaluation.identity?.set, release)) &&
                                            (!target || !evaluatedCriteriaMismatch(evaluation, scanIntent)),
                                        { freshGrading, preferRecentSales, requireLiquidity, verifyPhotoIdentity: Boolean(freshListings || guided || rankBlank) });
                                    if (!candidate) continue;
                                    const reason = target?.stage ? stageLabel : freshListings ? "Found in current Buy It Now listings." : `Found in the broader eBay search for ${query}.`;
                                    knownIds.add(listing.id);
                                    const observed = observeCandidate(candidate, listing, cursorKey);
                                    alternatives.set(listing.id, { candidate: observed, leads: [], reason });
                                    discovered.push(observed);
                                }
                                progress.retain(candidates.length + alternatives.size);
                                const queued = new Set(discovered.map(copy => copy.listingId));
                                for (const row of listings) if (!queued.has(row.id) && !knownIds.has(row.id)) discarded.add(row.id);
                                await diagnostic?.("queue", { query, orderedIds: discovered.map(copy => copy.listingId),
                                    dispositions: listings.map(listing => ({ id: listing.id, reason:
                                        queued.has(listing.id) ? "ELIGIBLE_FOR_REVIEW"
                                        : buyerReviewBlock(listing, scanStartedAt) ?? (!matchesListingFilters(listing, inventoryFilters)
                                            ? "OUTSIDE_BUYER_FILTERS" : knownIds.has(listing.id) ? "ALREADY_QUEUED" : "INELIGIBLE_FOR_REVIEW"),
                                        evidence: listing.screen?.reason })) });
                                progress.candidates?.(discovered.flatMap(candidate => alternatives.get(candidate.listingId)?.candidate.liveListing() ?? []));
                                if (!due.length) await assessFirstFreshCopies(discovered, copies.length, release ?? "the broader eBay search");
                                return discovered;
                            } });
                    } else {
                        marketNote = "The release catalog supplied no broader inventory queries within your year and set filters.";
                    }
                }
                if (!markets.length) marketNote ??= scope === "same_set" && !origin
                    ? "The original results did not establish a single set to explore."
                    : "No matching markets were found within your filters.";
            }
            const report = await deps.plan({ searchId, goal, candidates, markets, auction: format === "AUCTION", progress,
                onInterruption: async (stage, error) => {
                    const frames = error instanceof Error ? error.stack?.split("\n").slice(1, 5).map(line => line.trim().split(" (")[0]) : undefined;
                    await diagnostic?.("interrupted", { providerHttpRequests: flipRequestCounts(), stage, name: error instanceof Error ? error.name : "Unknown error", frames });
                },
                guidedResale: standalone && goal === "resell" && request.marketPreferences?.preferRecentSales === true,
                ...(freshListings && { freshListings }),
                ...(preferRecentSales && { preferRecentSales: true }) }, active);
            active.throwIfAborted();
            if (report.decision === "WAIT" && !report.destination && !report.needsAttention && exclusions.size &&
                report.reason === "The available evidence did not establish a purchase for this goal.") {
                const [title, reason] = exclusions.entries().next().value!;
                report.reason = title + " — " + reason;
            }
            if (inventoryCoverage) marketNote = [marketNote, inventoryCoverage()].filter(Boolean).join(" ");
            const evaluation = report.destination ? evaluations.get(report.destination.listingId) : null;
            if (report.destination && !evaluation) throw new Error("The selected evidence is unavailable.");
            let alternative: DealHuntResponse["alternative"];
            const otherCopies: ListingSummary[] = [];
            const candidatePrices: NonNullable<DealHuntResponse["candidatePrices"]> = {};
            const visibleAlternatives = [...alternatives].slice(-(DEVELOPMENT_SEARCH_LIMIT + 1));
            const selectedAlternative = report.destination && alternatives.get(report.destination.listingId);
            if (report.destination && selectedAlternative && !visibleAlternatives.some(([id]) => id === report.destination!.listingId))
                visibleAlternatives.unshift([report.destination.listingId, selectedAlternative]);
            for (const [id, { candidate, leads, reason }] of visibleAlternatives) {
                const listing = candidate.liveListing();
                if (!listing) continue;
                if (id === report.destination?.listingId) {
                    alternative = { listing, reason };
                }
                else if (standalone && otherCopies.length < DEVELOPMENT_SEARCH_LIMIT &&
                    (!leads.length || leads.some(lead => shortlistMarketCopies([listing], lead, goal, targets, filters).length))) {
                    otherCopies.push(listing);
                } else continue;
                const prices = candidate.marketPrices(listing);
                if (prices) candidatePrices[id] = prices;
            }
            if (watch && watchKey) {
                const retries = watch.pricingRetries ?? {};
                for (const id of presentedRetries) {
                    const candidate = alternatives.get(id)?.candidate;
                    if (!candidate || candidate.snapshot().retired) delete retries[id];
                }
                for (const [id, { candidate }] of alternatives) {
                    if (retries[id]) continue;
                    const listing = candidate.liveListing(), e = evaluations.get(id);
                    if (listing && e && (e.identity?.notThisCard || e.underwriting?.verdict === "PASS" && !releaseIssue(e)))
                        watch.checked[listingFingerprint(listing)] = deps.now() + 6 * 3_600_000;
                }
                watch.checked = Object.fromEntries(Object.entries(watch.checked).filter(([, expires]) => expires > deps.now()).slice(-1000));
                for (const [key, saved] of Object.entries(watch.backlogs ?? {})) {
                    // An inspected gallery can still await pricing. Its accepted photos
                    // remain usable when the next pass resumes the pending copy.
                    saved.backlog.pending = saved.backlog.pending.filter(row =>
                        Boolean(retries[row.id]) || !watch.checked[listingFingerprint(row)] && !discarded.has(row.id) && !(
                            row.id === report.destination?.listingId && ["BUY", "BID"].includes(report.decision)));
                    if (!saved.backlog.pending.length && !saved.backlog.sources.length) delete watch.backlogs![key];
                }
                watch.rounds++;
                if (report.waitingForQuota) watch.waitingForQuota = true;
                watch.nextCheckAt = report.waitingForQuota ? await deps.browseReserveReset(active) || deps.now() + HUNT_RECHECK_MS :
                    report.needsAttention ? 0 : Object.values(retries).reduce((earliest, retry) => Math.min(earliest, Math.max(deps.now() + 1000, retry.at)), deps.now() + HUNT_RECHECK_MS);
            }
            const copies = { ...(watch && { nextCheckAt: watch.nextCheckAt, waitingForQuota: watch.waitingForQuota }), ...(alternative && { alternative }), ...(standalone && { candidates: otherCopies }),
                ...(Object.keys(candidatePrices).length > 0 && { candidatePrices }) };
            const finishPass = async (result: DealHuntResponse) => {
                if (journal && watch) {
                    const pending = Object.values(watch.backlogs ?? {}).flatMap(entry => entry.backlog.pending.map(row => row.id));
                    await journal.finish(watch, result, pending);
                }
                await diagnostic?.("finished", { providerHttpRequests: flipRequestCounts(), decision: result.report.decision, destination: result.report.destination,
                    reason: result.report.reason, steps: result.report.steps, nextCheckAt: result.nextCheckAt,
                    usage: await diagnosticUsage(budgetSearchId) });
                return result;
            };
            if (standalone && report.destination && !alternative) {
                return finishPass({ report: { ...report, decision: "WAIT", destination: null, reason: "The selected listing became unavailable before the search finished." },
                    evaluation: null, ...copies });
            }
            const gradingOpportunity = freshGrading && report.decision === "BUY" && evaluation && alternative
                ? newGradingOpportunity(evaluation, deps.now(), targets, alternative.listing, filters.maxPrice) : undefined;
            if (freshGrading && report.decision === "BUY" && !gradingOpportunity) {
                return finishPass({ report: { ...report, decision: "WAIT", reason: "The grading comparisons or listing terms expired before the search finished.", marketNote },
                    evaluation: evaluation ?? null, ...copies });
            }
            if (searchedPrices.length && !report.destination && !marketNote && report.steps.length && report.steps.every(step => step.action === "find_listings")) {
                marketNote = `Searched item prices for ${new Intl.ListFormat("en-US").format(searchedPrices)}.`;
            }
            const selectedBid = evaluation && report.decision === "BID" ? evaluation : null;
            const collector = selectedBid && goal === "collect_slab" ? collectorAuction(selectedBid, deps.now(), filters.maxPrice) : null;
            if (standalone && goal === "resell" && selectedBid && alternative &&
                auctionOpportunity(selectedBid, targets, deps.now(), filters.maxPrice)?.status === "BID") {
                // Only the independently verified, affordable bid merits seller context.
                // Recheck the time-sensitive quote below after the lookup returns.
                const [listing] = await deps.researchAuctionSellers([alternative.listing], deps.now(), active);
                if (listing) copies.alternative = { ...alternative, listing };
            }
            const opportunity = selectedBid && goal !== "collect_slab" ? auctionOpportunity(selectedBid, targets, deps.now(), filters.maxPrice) : null;
            if (report.decision === "BID" && (collector ?? opportunity)?.status !== "BID") {
                return finishPass({ report: { ...report, decision: "WAIT", reason: "The auction terms expired before the search finished.", marketNote }, evaluation: evaluation ?? null,
                    ...copies });
            }
            return finishPass({ ...(collector && { collectorAuction: collector }), ...(opportunity && { auctionOpportunity: opportunity }),
                ...(gradingOpportunity && { gradingOpportunity }),
                report: marketNote ? { ...report, marketNote } : report, evaluation: evaluation ?? null,
                ...copies });
        })));
        return share(JSON.stringify([budgetSearchId, searchId, criteria]), active => countFlipRequests(() => {
            if (!request.watch) return execute(active, null);
            return withFlipRun<WatchCheckpoint, DealHuntResponse, CopyProgress>(flipRunFile, searchId, budgetSearchId, criteria, active, journal => execute(active, journal))
                .catch(error => { if (error instanceof FlipRunConflict) throw new DealHuntInputError(error.message, 409, error.running ? "FLIP_RUN_ACTIVE" : undefined); throw error; });
        }), signal);
    };
}
export const runSearchDealHunt = createDealHuntService();
