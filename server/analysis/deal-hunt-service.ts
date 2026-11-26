import { browsePressure } from "../lib/provider-usage.ts";
import { createHash } from "node:crypto";
import { HUNT_RECHECK_MS } from "../../shared/deal-hunt.ts";
import { releaseIssue } from "../../shared/base-set-release.ts";
import { auctionOpportunity, nextAuctionBid, withinOpportunityWindow } from "../../shared/auction-opportunity.ts";
import { collectorAuction } from "../../shared/collector-auction.ts";
import { yearOf } from "../../shared/sets.ts";
import { setYears } from "../pricing/price-tracker.ts";
import { researchAuctionSellers, researchFreshRawSellers } from "../deals/auction-seller-research.ts";
import { freshResaleCandidates } from "../deals/discovery-order.ts";
import { createHuntInventoryScanner } from "../deals/find-deals.ts";
import { listingMarketPrices, type ProviderPrice } from "../../shared/listing-market-prices.ts";
import { chooseReviewSelection } from "../deals/search-review-selection.ts";
import { availablePhotoCount } from "../../shared/analysis-priority.ts";
import { freshListingTime } from "../../shared/grading-watch.ts";
import { sellerConditionClues } from "../../shared/raw-condition-claim.ts";
import { meetsMinimumGrade, type AutoAnalysisBlockReason } from "../../shared/analysis.ts";
import { FIRST_REVIEW_COUNT } from "../../shared/search-review-selection.ts";
import { englishListingEligible } from "../../shared/card-language.ts";
import { DEAL_HUNT_LISTING_LIMIT, dealHuntGoals, type DealHuntAction, type DealHuntGoal, type DealHuntRequest, type DealHuntResponse } from "../../shared/deal-hunt.ts";
import { buyerReviewBlock } from "../../shared/wait-skip-review.ts";
import { listingEvidenceKey, searchPhotosFitDetails } from "../../shared/listing-evidence.ts";
import { matchesListingFilters, type ListingFilters } from "../../shared/listing-filters.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { acquisitionCost } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { dollars } from "../../shared/format.ts";
import { withFreshListing } from "../../shared/fresh-listing.ts";
import { currentPriceEvidence } from "../../shared/pricing-freshness.ts";
import { BOUNDED_AUTO_CONCURRENCY, DEVELOPMENT_SEARCH_LIMIT } from "../../shared/research-policy.ts";
import { evaluatedCriteriaMismatch } from "../../shared/search-criteria.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import type { Evaluation, ListingSummary, SearchIntent, Targets } from "../../shared/types.ts";
import { EbayError } from "../ebay/api.ts";
import { EbayBudgetError } from "../ebay/usage.ts";
import { exclusionReason } from "../ebay/filters.ts";
import { aiSpendingFailure } from "../ai/spending.ts";
import { getBudgetContext, withAiUsageContext } from "../ai/usage-context.ts";
import { getListingDetails } from "../ebay/listings.ts";
import { configuredShippingZip } from "../ebay/shipping-destination.ts";
import { dailyBrowseReserve } from "../ebay/daily-budget.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { evaluateBoundedListing, PriceOnlyEvidenceError } from "./bounded-evaluate.ts";
import { EnglishOnlyError, evaluationFailure, RejectedPhotoAssessmentError } from "./failure.ts";
import { runDealHunt, type DealHuntCandidate, type DealHuntMarket } from "./deal-hunt.ts";
import { huntProgress } from "./deal-hunt-progress.ts";
import { verifyCollectorArtwork } from "./collector-artwork.ts";
import { huntPrintingCheck, huntPrintingTerms } from "./deal-hunt-printing.ts";
import { dealHuntCandidate, flipResaleEvidence, newGradingOpportunity } from "./deal-hunt-evidence.ts";
import { evaluationContextKey, loadPrivateEvaluation, type PrivateEvaluationSnapshot } from "./private-evaluation.ts";
import { guidedInventoryTargets, webInventoryTargets, type InventoryTarget } from "./guided-inventory.ts";
import { liquidMarkets } from "../pricing/liquid-markets.ts";
import { loadDiagnosticDiscovery } from "./search-diagnostics.ts";
import { isSearchDiagnosticId } from "./search-diagnostic-store.ts";
import { discoveryContinuations } from "../deals/search-continuation.ts";
import { findHuntMarkets, restoreSavedHuntSales, type HuntMarket } from "./same-set-markets.ts";
import { discoverMarketListings, type MarketQueryObservation } from "./same-set-listings.ts";
import { describeHuntMarket, huntOrigin, huntPhotoIdentityIssue, keepsSetSearchPreferences, marketItemLimit, marketIntent, matchesHuntMarket, photoMatchesCollectorMarket, shortlistMarketCopies } from "./deal-hunt-market-checks.ts";
import { groupMarketCopies, groupMarketSearches, huntMarketCardKey } from "./deal-hunt-market-groups.ts";
import { citedTransactions, verifyCitedSales, type SoldCitation } from "../pricing/cited-sale.ts";
import { priceChartingComparison } from "../pricing/pricecharting.ts";
import { marketHistory } from "../pricing/price-history.ts";
import { providerPrices } from "../pricing/buyer-market-prices.ts";
import { compareCardmarket } from "../pricing/cardmarket.ts";
import { withPriceResearchSignal } from "../pricing/research-budget.ts";
import { sameCatalogName } from "../identity/catalog-name.ts";
import { supplementalResearch } from "../pricing/supplemental-research.ts";
import { PricingProviderError } from "../pricing/errors.ts";
import { restoreRawComparisons } from "../pricing/saved-raw-comparisons.ts";
import { sameSetFamily } from "../identity/card-identity.ts";

export class DealHuntInputError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
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
    listing: ListingSummary;
    assessable: boolean;
    block?: AutoAnalysisBlockReason | null;
    screenReason?: string;
    gradingLead?: true;
    collectorQuery?: string;
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
    browsePressure,
    discovery: loadDiagnosticDiscovery,
    batchOwner: discoveryContinuations.budgetOwner,
    inventory: loadSearchReviewInventory,
    snapshot: loadPrivateEvaluation,
    details: getListingDetails,
    restoreRaw: restoreRawComparisons,
    supplement: supplementalResearch,
    priceCharting: priceChartingComparison,
    verifyCitedSales,
    marketHistory,
    compareCardmarket,
    evaluate: evaluateBoundedListing,
    verifyCollectorArtwork,
    plan: runDealHunt,
    markets: findHuntMarkets,
    inventoryScanner: createHuntInventoryScanner,
    liquidMarkets,
    guidedInventoryTargets,
    webInventoryTargets,
    discoverMarket: discoverMarketListings,
    now: Date.now,
    setYears,
    researchAuctionSellers,
    researchFreshRawSellers,
    selectReviews: chooseReviewSelection,
};
type Dependencies = typeof defaults;
function catalogActivity(target: InventoryTarget) {
    const pace = target.activeDays === undefined ? "" : ` Observed ${((target.sales ?? 0) / 7).toFixed(2)} per day, across ${target.activeDays} selling days.`;
    return `${target.sales} recorded USD eBay sales across the selected card types in seven calendar days.${pace}`;
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

interface ScopedCandidate extends DealHuntCandidate {
    guidePrices(): ProviderPrice[];
    retryAfter(): number | undefined;
    rejectedSales(): string[];
    liveListing(): ListingSummary | null;
}

function scopedCandidate(id: string, goal: DealHuntGoal, targets: Targets, searchId: string, saved: PrivateEvaluationSnapshot | null,
    inventory: HuntInventory | null, row: HuntRow | undefined, evaluations: Map<string, Evaluation>, deps: Dependencies,
    filters: ListingFilters, minGrade: number, acceptsEvaluation: (evaluation: Evaluation) => boolean,
    { markets = [], freshGrading = false, preferRecentSales = false, requireLiquid = false, verifyPhotoIdentity = false, rejectedSales = [] }: { markets?: HuntMarket[]; freshGrading?: boolean; preferRecentSales?: boolean; requireLiquid?: boolean; verifyPhotoIdentity?: boolean; rejectedSales?: string[] } = {}): ScopedCandidate | null {
    // Never use an unrelated old version of a card simply because its eBay ID is the same.
    if (saved && (saved.evaluation.listing.id !== id || (row ? !rowMatches(row, saved) : saved.searchId !== searchId))) saved = null;
    const format = filters.typeFilter === "AUCTION" ? "AUCTION" : "FIXED_PRICE";
    const auction = format === "AUCTION";
    if (auction && !withinOpportunityWindow(row?.listing.endTime ?? saved?.evaluation.listing.endTime, deps.now())) return null;
    let checkFullListing = Boolean((markets.length || auction || !inventory && row) && saved);
    let value = saved && flipResaleEvidence(retargetEvaluation(saved.evaluation, targets, row?.listing), goal, targets);
    if (freshGrading && (!row || freshListingTime(row.listing, deps.now()) === null)) return null;
    const matches = (e: Evaluation) => e.listing.buyingOption === format && acceptsEvaluation(e) && fits(e, row, inventory) && meetsMinimumGrade(e, minGrade) && (!markets.length || markets.some(market => matchesHuntMarket(e, market, !!huntPrintingCheck(e), freshGrading) && !evaluatedCriteriaMismatch(e, marketIntent(market)))) &&
        (!row || matchesListingFilters({ ...row.listing, currentPrice: e.listing.price }, filters, e));
    if (value && !matches(value)) return null;
    let guideSales: SoldCitation[] = [];
    const reader = () => value && dealHuntCandidate(value, goal, deps.now, markets, targets, filters.maxPrice,
        { preferRecentSales, requireLiquid, hasGuideSales: guideSales.length > 0 });
    const initial = reader();
    let artworkVerified = !row?.collectorQuery;
    if (value && !initial) return null;
    if (!value && (!row?.assessable || goal === "grade_raw" && row.listing.isGraded || goal === "collect_slab" && !row.listing.isGraded)) return null;
    if (value && artworkVerified) evaluations.set(id, value);
    let guidePrices: ProviderPrice[] = [];
    let retryAt: number | undefined;
    const attemptedSales = new Set<string>();
    const rejected = new Set(rejectedSales);
    const saleKey = (sale: SoldCitation) => JSON.stringify([value?.identity?.recordId, value?.identity?.printing, value?.identity?.finish,
        value?.slab?.grader, value?.slab?.grade, value?.condition?.rawCondition, sale.url, sale.date, sale.priceUsd]);
    const pendingSales = () => {
        const sales = value ? citedTransactions(value, guideSales, deps.now()) : new Map<string, SoldCitation>();
        for (const [key, sale] of sales) if (attemptedSales.has(key) || rejected.has(saleKey(sale))) sales.delete(key);
        return sales;
    };
    const canVerifySale = (checked: ReadonlySet<DealHuntAction>) => goal === "resell" && value?.identity?.recordId &&
        checked.has("check_listing") && checked.has("inspect_photos") && checked.has("check_sales") &&
        !(retryAt && retryAt > deps.now()) && !huntPhotoIdentityIssue(value) && pendingSales().size > 0 &&
        reader()?.available(referencePrerequisites).includes("check_price_references");
    let retired = false;
    let quotaNote: string | undefined;
    const retire = (message: string) => {
        retired = true;
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
    const copySummary = initial?.summary ?? [card!.isGraded ? "Listed graded" : "Listed raw", card!.cardCondition,
        card!.listedAt && `Listed ${card!.listedAt}`, card!.currentPrice != null && `Item price $${card!.currentPrice}`,
        "Screened listing. A photo check runs the bounded listing assessment."].filter(Boolean).join(". ");
    const auctionClues = auction && card ? [
        card.endTime && `Auction ends ${card.endTime}.`,
        seller && `Seller inventory sample: ${seller.cardListings} card listings and ${seller.otherListings} other listings across ${seller.categories.join(", ")}. This guides photo checks only.`,
        (card.screen?.gradingLead || row?.gradingLead) && "Initial screening suggests grading upside. Inspect the originals and compare the likely grade and one lower.",
    ].filter(Boolean).join(" ") : "";
    return {
        listingId: id, title: initial?.title ?? card!.title,
        ...(freshRawGradingLead && { freshRawGradingLead }),
        summary: [row?.collectorQuery && `Found through “${row.collectorQuery}”. Inspect the original front to verify the searched card and number.`,
            auctionClues, freshClues, copySummary].filter(Boolean).join(" "),
        guidePrices: () => guidePrices,
        retryAfter: () => retryAt,
        rejectedSales: () => [...rejected],
        liveListing() {
            if (!card || retired || !artworkVerified) return null;
            const latest = value ? withFreshListing(card, value) : card;
            if (!latest.images.length || latest.availability === "UNAVAILABLE" ||
                latest.endTime && !(Date.parse(latest.endTime) > deps.now()) ||
                auction && !withinOpportunityWindow(latest.endTime, deps.now()) ||
                freshGrading && freshListingTime(latest, deps.now()) === null) return null;
            return latest;
        },
        available(checked) {
            if (retired || checked.has("move_on")) return [];
            if (!artworkVerified) return ["inspect_photos"];
            const actions = reader()?.available(checked);
            if (!actions) return auction && !checked.has("check_listing") ? ["check_listing", "inspect_photos"] : ["inspect_photos"];
            if (canVerifySale(checked)) actions.unshift("verify_sold_listing");
            if (goal !== "resell" || !actions.includes("check_price_references") ||
                !preferRecentSales && !value?.rawPricing?.tcgplayerComparison) return actions;
            const sources: DealHuntAction[] = ["check_price_tracker", "search_web_sales"];
            if (requireLiquid) sources.push("move_on");
            if (value?.identity?.recordId) sources.push("check_price_history", "compare_cardmarket");
            return [...actions.filter(action => action !== "check_price_references"), ...sources.filter(source => !checked.has(source))];
        },
        canRepeat: (action, checked) => !retired && artworkVerified && (action === "verify_sold_listing" ? !!canVerifySale(checked) : reader()?.canRepeat?.(action, checked) === true),
        outcome(checked) {
            if (!value || retired || !artworkVerified) return null;
            if (checked.has("move_on")) return { decision: "WAIT", section: "sales", reason: "Continuing to another copy with stronger resale evidence." };
            if (canVerifySale(checked)) return null;
            const evidence = reader();
            if (evidence?.available(checked).includes("check_price_references") &&
                !(checked.has("check_price_tracker") && checked.has("search_web_sales"))) return null;
            const searched = checked.has("check_price_tracker") || checked.has("search_web_sales");
            const result = evidence?.outcome(searched ? new Set([...checked, "check_price_references"]) : checked);
            if (!result) return null;
            if ((verifyPhotoIdentity && result.decision === "BUY") || (goal === "resell" && result.decision === "BID")) {
                const reason = huntPhotoIdentityIssue(value);
                if (reason) return { decision: "WAIT", section: "photos", reason };
                if (!(result.recentSales && result.recentSales > 0))
                    return { decision: "WAIT", section: "sales", reason: "No recent matching sales confirmed liquidity for this resale route." };
            }
            if (quotaNote) return { decision: "WAIT", section: result.section, reason: `${result.reason} ${quotaNote}` };
            const { price, shipping } = value.listing;
            if (filters.maxPrice !== undefined && price !== null && shipping !== null) {
                const item = auction ? nextAuctionBid(value.listing, deps.now()) : price;
                const total = item === null ? null : acquisitionCost(item, shipping, MONEY_CONFIG.buying);
                if (total != null && total > filters.maxPrice) return { decision: "WAIT", section: result.section,
                    reason: `The purchase totals ${dollars(total)} after shipping and estimated tax, above your ${dollars(filters.maxPrice)} limit.` };
            }
            if (freshGrading && result.decision === "BUY" && row) {
                const opportunity = newGradingOpportunity(value, deps.now(), targets, withFreshListing(row.listing, value));
                if (!opportunity) return { decision: "WAIT", section: "grading",
                    reason: `${result.reason} A fresh grading buy requires front and back evidence, a supported value at the likely grade, and a profitable sale comparison one grade lower.` };
                const activity = (quote: typeof opportunity.likely) => quote.sales60 === undefined ? `${quote.sales30} sales in 30 days` : `${quote.sales60} sales in 60 days`;
                return { ...result, verifiedPurchase: opportunity.verifiedPurchase, section: "grading", reason: `Grading with ${opportunity.grader} costs ${dollars(opportunity.gradingCosts)} including submission shipping. Grade ${opportunity.likely.grade} projects ${dollars(opportunity.likely.profit)} profit after costs (${activity(opportunity.likely)}). One grade lower, grade ${opportunity.lower.grade} projects ${dollars(opportunity.lower.profit)} (${activity(opportunity.lower)}).` };
            }
            return result;
        },
        async read(action, signal) {
            signal?.throwIfAborted();
            if (retired) return "This copy was excluded from the search.";
            if (action === "move_on") return "Continue to another copy with stronger resale evidence.";
            if (!artworkVerified && action !== "inspect_photos") return "Check the original front against the catalog first.";
            const checkRaw = action === "check_raw_resale" || action === "check_sales" && value?.underwriting?.verdict === "CANT_PRICE";
            if (checkRaw && value) {
                const raw = await deps.restoreRaw(value, deps.now(), signal);
                if (raw) value = retargetEvaluation({ ...value, rawPricing: raw }, targets);
            }
            let verification: string | undefined;
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
                } else if (action === "verify_sold_listing") {
                    // Check the newest outstanding citation. A rejection consumes only that transaction.
                    const next = [...pendingSales()].sort((a, b) => b[1].date!.localeCompare(a[1].date!) || a[0].localeCompare(b[0]))[0];
                    if (!next) return "No new cited transactions remain.";
                    const update = await deps.verifyCitedSales(value, new Map([next]), deps.now(), signal);
                    attemptedSales.add(next[0]);
                    if (!update) rejected.add(saleKey(next[1]));
                    retryAt = undefined;
                    verification = update ? "Verified a cited eBay transaction against the completed sale record and matched copy."
                        : "This transaction did not establish a verified comparison.";
                    if (update) value = retargetEvaluation({ ...value, ...update }, targets);
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
                    return result.offers.length ? `Cardmarket has ${result.offers.length} matched active offers, starting at €${result.offers[0].priceEur.toFixed(2)} before delivery. These are European asking prices.`
                        : result.reason ?? "Cardmarket returned no matching offers.";
                } else if (action === "check_price_references" || action === "check_price_tracker" || action === "search_web_sales") {
                    const eligible = () => reader()?.available(referencePrerequisites).includes("check_price_references");
                    if (!eligible()) return "The current listing terms or market evidence no longer warrant a supplemental lookup.";
                    const now = deps.now();
                    const source = action === "check_price_tracker" ? "tracker" as const : action === "search_web_sales" ? "web" as const : undefined;
                    const options = { now, signal: signal ?? new AbortController().signal, source,
                        ...((requireLiquid || value.rawPricing?.tcgplayerComparison) && { comparePrices: true }) };
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
                } else if ((action === "check_sales" || action === "check_raw_resale") && saved && isSearchDiagnosticId(saved.searchId) && value.listing.availability === "ACTIVE" &&
                    !currentPriceEvidence(value, deps.now())) {
                    // Price-only research retains the original assessment's allowance on a reused copy.
                    const refreshed = await withAiUsageContext({ searchId: saved.searchId, listingId: id }, () =>
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
                if (action === "verify_sold_listing") {
                    const failure = evaluationFailure(error);
                    if (error instanceof PricingProviderError ? error.kind === "TEMPORARY" : failure.retryable) {
                        const retry = error instanceof PricingProviderError ? error.retryAt : undefined;
                        retryAt = Math.max(deps.now() + 1000, retry ?? deps.now() + (failure.retryAfterMs ?? 30_000));
                        return "The sold listing could not be checked yet. Its verification is scheduled for retry.";
                    }
                }
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
                if (!(error instanceof EbayBudgetError && error.reason === "QUOTA" && value &&
                    (action === "check_sales" || action === "check_raw_resale" || action === "check_listing"))) throw error;
                quotaNote = "The eBay allowance prevented a fresh check. These figures use the last checked listing.";
            }
            signal?.throwIfAborted();
            if (value.identity?.notThisCard) return retire(value.identity.notThisCard);
            value = flipResaleEvidence(value, goal, targets);
            if (action === "check_sales" || action === "check_raw_resale") await restoreSavedHuntSales([value], goal, deps.now(), signal);
            let artworkObservation: string | undefined;
            if (!artworkVerified) {
                const assessed = value;
                const market = markets.find(lead => photoMatchesCollectorMarket(assessed, lead));
                if (!market) return retire(`The original front did not verify the card and printing sought by “${row?.collectorQuery}”.`);
                const result = await deps.verifyCollectorArtwork(assessed, market, signal);
                signal?.throwIfAborted();
                if (!result.matches) return retire(result.reason);
                artworkVerified = true;
                artworkObservation = result.reason;
            }
            const evidence = reader();
            if (value.listing.id !== id || !matches(value) || !evidence) return retire("The verified copy falls outside the search, comparison market or buyer goal.");
            evaluations.set(id, value);
            const observation = await evidence.read(action, signal);
            const guide = goal === "resell" && action === "check_sales" && value.identity && !huntPhotoIdentityIssue(value)
                ? await deps.priceCharting(value.identity, signal) : null;
            if (guide) { guidePrices = guide.prices; guideSales = guide.sales ?? []; }
            const liquidity = requireLiquid && (action === "check_sales" || action === "verify_sold_listing")
                ? evidence.outcome(new Set([...referencePrerequisites, "check_raw_resale", "calculate_grading"])) : null;
            return [artworkObservation, verification, observation, guide?.observation, liquidity?.liquidityIssue && liquidity.reason, quotaNote].filter(Boolean).join(" ");
        },
    };
}

interface WatchCheckpoint {
    rounds: number;
    nextCheckAt: number;
    offsets: Record<string, number>;
    checked: Record<string, number>;
    deferred?: Record<string, { listing: ListingSummary; target: InventoryTarget; at: number; rejectedSales?: string[] }>;
    waitingFor?: "provider" | "inventory";
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
        return share(JSON.stringify([budgetSearchId, searchId, request]), active => withPriceResearchSignal(active, () => withAiUsageContext({ searchId, ...(budgetSearchId !== searchId && { watchBudgetId: budgetSearchId }) }, () => huntProgress.observe(budgetSearchId, searchId, active, async progress => {
            const watchKey = request.watch ? "private-hunt-watch:v1:" + createHash("sha256")
                .update(JSON.stringify([budgetSearchId, searchId, request])).digest("hex") : null;
            const watch: WatchCheckpoint | null = watchKey ? await readCache<WatchCheckpoint>(watchKey, 24) ??
                { rounds: 0, nextCheckAt: 0, offsets: {}, checked: {} } : null;
            if (watch) {
                const pressure = await deps.browsePressure();
                // Browse paces individual requests during a burst. Hold the entire pass only at the daily reserve.
                const atReserve = pressure && pressure.remaining <= dailyBrowseReserve(pressure.limit);
                if (atReserve || watch.nextCheckAt > deps.now()) {
                    const reset = Date.parse(pressure?.resetsAt ?? "");
                    const nextCheckAt = Math.max(watch.nextCheckAt, atReserve ? (reset > deps.now() ? reset : deps.now() + HUNT_RECHECK_MS) : 0);
                    const waitingFor = atReserve ? "provider" : watch.waitingFor;
                    return { evaluation: null, nextCheckAt, waitingFor, report: { searchId, goal, decision: "WAIT", destination: null, steps: [],
                        reason: atReserve ? "Waiting for eBay search allowance." : waitingFor === "provider" ? "Waiting to retry the pricing source." : "Waiting for the next inventory check." } };
                }
            }
            const discovery = standalone ? null : await deps.discovery(searchId);
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
            const requireLiquid = standalone && goal === "resell" && preferRecentSales;
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
            const evaluations = new Map<string, Evaluation>();
            const candidates: DealHuntCandidate[] = [];
            const resumedListings = new Set<string>();
            const alternatives = new Map<string, { candidate: ScopedCandidate; leads: HuntMarket[]; reason: string; target?: InventoryTarget }>();
            const observeCandidate = (candidate: ScopedCandidate): ScopedCandidate => ({ ...candidate,
                async read(action, signal) {
                    const observation = await candidate.read(action, signal);
                    const listing = candidate.liveListing();
                    if (listing) progress.candidates?.([listing]);
                    return observation;
                },
            });
            // Keep private SQL reads bounded. Preserve display order even if reads finish out of order.
            for (let offset = 0; offset < listingIds.length; offset += 4) {
                active.throwIfAborted();
                const batch = listingIds.slice(offset, offset + 4).filter(id => !inventories.get(retainedBy.get(id)!) || rows.has(id));
                const snapshots = await Promise.all(batch.map(id => deps.snapshot(id)));
                batch.forEach((id, index) => {
                    const batchId = retainedBy.get(id)!;
                    const candidate = scopedCandidate(id, goal, targets, batchId, snapshots[index], inventories.get(batchId) ?? null,
                        rows.get(id), evaluations, deps, filters, minPotentialGrade, acceptsEvaluation, { preferRecentSales });
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
                            const listings = format === "AUCTION" ? await deps.researchAuctionSellers(found, deps.now(), active) : found;
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
                                    row, evaluations, deps, filters, minPotentialGrade, acceptsEvaluation, { markets: leads, freshGrading, preferRecentSales, requireLiquid });
                                if (!candidate) continue;
                                const matched = saved ? leads.filter(lead => matchesHuntMarket(saved.evaluation, lead)) : [];
                                const reason = (matched.length ? matched : leads).map(describeHuntMarket).join(" ");
                                knownIds.add(listing.id);
                                const observed = observeCandidate(candidate);
                                alternatives.set(listing.id, { candidate: observed, leads, reason });
                                discovered.push({ ...observed, summary: `${candidate.summary} ${reason} Item ${dollars(listing.currentPrice)}.` });
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
                        guided ? [guided.name, guided.number].filter(Boolean).join(" ") : "Ranking catalog cards by seven days of recorded eBay sales");
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
                    let ranked: Awaited<ReturnType<typeof deps.liquidMarkets>> = [];
                    if (!guided && (rankBlank || freshListings) && !sets?.length && !yearRange && !finish && !printing) {
                        try { ranked = await deps.liquidMarkets(filters.kindFilter, deps.now(), active); }
                        catch (error) {
                            active.throwIfAborted();
                            if (!(error instanceof PricingProviderError && error.kind === "TEMPORARY")) throw error;
                            marketNote = "The sampled market ranking was temporarily unavailable. Checking independent eBay inventory.";
                        }
                    }
                    const deferred = watch?.deferred ?? {};
                    const due = Object.values(deferred).filter(item => item.at <= deps.now());
                    const retryTargets = new Map(due.map(item => [JSON.stringify(item.target), item.target]));
                    const pendingTargets: InventoryTarget[] = [...retryTargets.values(), ...ranked];
                    const continuedTargets: InventoryTarget[] = [];
                    let guideEnded = !guide;
                    const allowFallback = !guided;
                    let offerWebDiscovery = !guided && standalone && goal === "resell" && preferRecentSales && releases.length > 0;
                    let fallbackIndex = 0;
                    let currentTarget: InventoryTarget | undefined;
                    let lastMarket: string | undefined;
                    const marketQuery = (target: InventoryTarget) => [target.name, target.number, target.set].filter(Boolean).join(" ") || "Pokemon";
                    let paused = false;
                    const exhaustedQueries = new Set<string>();
                    const checkedQueries = new Set<string>();
                    const queryOffsets = new Map<string, number | undefined>();
                    const hasTargets = () => !paused && Boolean(currentTarget || pendingTargets.length || continuedTargets.length || !guideEnded || offerWebDiscovery || allowFallback && fallbackIndex < releases.length);
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
                            hasOtherMarket: () => !paused && (!guideEnded || allowFallback && fallbackIndex < releases.length ||
                                [...pendingTargets, ...continuedTargets].some(target => marketQuery(target) !== lastMarket)),
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
                                            summary: target.sales === undefined ? "Continue the retained copies and remaining source pages within the buyer's filters."
                                                : catalogActivity(target),
                                        })));
                                    }
                                    active.throwIfAborted();
                                    const [next] = pendingTargets.splice(targetIndex, 1);
                                    const nextQuery = marketQuery(next);
                                    if (!exhaustedQueries.has(JSON.stringify([nextQuery, format]))) currentTarget = next;
                                }
                                const target = currentTarget;
                                const release = target.set;
                                const query = marketQuery(target);
                                lastMarket = query;
                                const cursorKey = JSON.stringify([query, format]);
                                let pageOffset = queryOffsets.get(cursorKey);
                                const stageLabel = target?.stage ? target.stage + " · " + query : query === "Pokemon" ? "Newly listed singles across sets" : query;
                                const cohort = target.sales ? stageLabel + " · " + target.sales + " recorded eBay sales in 7 days" +
                                    (target.activeDays === undefined ? "" : ` on ${target.activeDays} selling days`) : stageLabel;
                                const scanIntent = { ...intent, sets: release ? [release] : [],
                                    ...(target && { cardName: target.name, cardNumber: target.number, titleWords: target.name ? [target.name] : [] }) };
                                started = true;
                                checkedQueries.add(cursorKey);
                                progress.stage("discovering", cohort, "find_listings");
                                let observedFound = 0, observedScreened = 0;
                                const recordSourceCounts = ({ found, screened }: { found: number; screened: number }) => {
                                    const added = Math.max(0, found - observedFound);
                                    const priced = Math.max(0, screened - observedScreened);
                                    if (added || priced) progress.source(added, priced);
                                    observedFound += added;
                                    observedScreened += priced;
                                };
                                const { listings, summary, hasMore, sourcePages } = await scan(query, scanIntent,
                                    inventoryFilters, targets, scanStartedAt, { excludeIds: knownIds, freshGrading,
                                        ...(freshListings && { freshListings }),
                                        ...((freshListings || watch) && { offset: pageOffset ?? (watch && watch.rounds % 3 !== 0 ? watch.offsets[cursorKey] : undefined),
                                            onNextPage: offset => {
                                                pageOffset = offset;
                                                queryOffsets.set(cursorKey, offset);
                                                if (watch) watch.offsets[cursorKey] = offset ?? 0;
                                            } }),
                                        ...(watch && { previouslyChecked: row => (watch.checked[listingFingerprint(row)] ?? 0) > deps.now() }),
                                        onStage: stage => progress.stage(stage, cohort, "find_listings"), onProgress: recordSourceCounts });
                                recordSourceCounts({ found: summary.found, screened: summary.screened ?? 0 });
                                progress.source(0, 0, sourcePages ?? 1);
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
                                if (target?.sales) reportQueries?.(`${target.name} ${target.number} · ${catalogActivity(target)} Ranked among sampled catalog cards.`);
                                reportQueries?.(`“${query}” loaded ${summary.found} distinct listing summaries and screened prices for ${summary.screened ?? 0}.${summary.sourceCoverage === "PARTIAL"
                                    ? " This scan covered part of the source results." : " Coverage applies to this eBay query."}`);
                                const discovered: DealHuntCandidate[] = [];
                                const current = format === "AUCTION" ? await deps.researchAuctionSellers(listings, deps.now(), active)
                                    : listings;
                                // A provider retry retains the specific physical copy even when it has moved off the newest page.
                                const retryRows = due.filter(item => item.target.name === target.name && item.target.set === target.set &&
                                    item.target.number === target.number).map(item => item.listing);
                                for (const listing of retryRows) resumedListings.add(listing.id);
                                const page = new Map([...retryRows, ...current].map(listing => [listing.id, listing]));
                                const eligible = [...page.values()].filter(listing => (deferred[listing.id]?.at ?? 0) <= deps.now() && !knownIds.has(listing.id) && buyerReviewBlock(listing, deps.now()) === null &&
                                    matchesListingFilters(listing, inventoryFilters));
                                const copies = (freshListings ? freshResaleCandidates(eligible, targets, scanStartedAt) : eligible).map(listing => ({ listing }));
                                for (const { listing } of await rankFreshCopies(copies)) {
                                    active.throwIfAborted();
                                    if (knownIds.has(listing.id)) continue;
                                    const saved = await deps.snapshot(listing.id);
                                    const candidate = scopedCandidate(listing.id, goal, targets, searchId, saved, null,
                                        { listing, assessable: true }, evaluations, deps, inventoryFilters, minPotentialGrade,
                                        evaluation => acceptsEvaluation(evaluation) && (!release || sameSetFamily(evaluation.identity?.set, release)) &&
                                            (!target || !evaluatedCriteriaMismatch(evaluation, scanIntent)),
                                        { freshGrading, preferRecentSales, requireLiquid, verifyPhotoIdentity: Boolean(freshListings || guided || rankBlank),
                                            rejectedSales: deferred[listing.id] && listingFingerprint(deferred[listing.id].listing) === listingFingerprint(listing)
                                                ? deferred[listing.id].rejectedSales : undefined });
                                    if (!candidate) continue;
                                    const reason = target?.stage ? cohort : freshListings ? "Found in current Buy It Now listings." : `Found in the broader eBay search for ${query}.`;
                                    knownIds.add(listing.id);
                                    const observed = observeCandidate(candidate);
                                    alternatives.set(listing.id, { candidate: observed, leads: [], reason, target });
                                    discovered.push(observed);
                                }
                                progress.retain(candidates.length + alternatives.size);
                                progress.candidates?.(discovered.flatMap(candidate => alternatives.get(candidate.listingId)?.candidate.liveListing() ?? []));
                                await assessFirstFreshCopies(discovered, copies.length, release ?? "the broader eBay search");
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
            const seed = request.marketPreferences?.seed;
            const guidedResale = standalone && goal === "resell" && request.marketPreferences?.preferRecentSales === true;
            const rotateMarkets = guidedResale && (!seed || seed.expand && !seed.number);
            const report = await deps.plan({ rotateMarkets, searchId, goal, candidates, markets, auction: format === "AUCTION", progress,
                guidedResale,
                ...(freshListings && { freshListings }),
                ...(preferRecentSales && { preferRecentSales: true }) }, active);
            active.throwIfAborted();
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
            const capturePrices = (id: string, listing: ListingSummary) => {
                const assessment = evaluations.get(id), now = deps.now();
                const prices = listingMarketPrices(assessment, listing, now);
                if (prices && assessment) candidatePrices[id] = { ...prices, additional: [...(prices.additional ?? []), ...providerPrices(assessment, now), ...(alternatives.get(id)?.candidate.guidePrices() ?? [])] };
            };
            for (const [id, { candidate, leads, reason }] of visibleAlternatives) {
                const listing = candidate.liveListing();
                if (!listing) continue;
                if (id === report.destination?.listingId) {
                    alternative = { listing, reason };
                    capturePrices(id, listing);
                }
                else if (standalone && otherCopies.length < DEVELOPMENT_SEARCH_LIMIT &&
                    (!leads.length || leads.some(lead => shortlistMarketCopies([listing], lead, goal, targets, filters).length))) {
                    otherCopies.push(listing);
                    capturePrices(id, listing);
                }
            }
            if (watch && watchKey) {
                const deferred = watch.deferred ??= {};
                for (const id of resumedListings) delete deferred[id];
                for (const [id, { candidate, target }] of alternatives) {
                    const listing = candidate.liveListing(), e = evaluations.get(id);
                    const retry = candidate.retryAfter();
                    if (listing && target && retry !== undefined) {
                        deferred[id] = { listing, target, at: retry, rejectedSales: candidate.rejectedSales() };
                        continue;
                    }
                    delete deferred[id];
                    if (listing && e && (e.identity?.notThisCard || e.underwriting?.verdict === "PASS" && !releaseIssue(e)))
                        watch.checked[listingFingerprint(listing)] = deps.now() + 6 * 3_600_000;
                }
                watch.checked = Object.fromEntries(Object.entries(watch.checked).filter(([, expires]) => expires > deps.now()).slice(-1000));
                watch.rounds++;
                const earliestRetry = Object.values(deferred).reduce((earliest, item) => Math.min(earliest, item.at), Infinity);
                watch.nextCheckAt = Math.max(deps.now() + 1000, Math.min(deps.now() + HUNT_RECHECK_MS, earliestRetry));
                watch.waitingFor = earliestRetry <= watch.nextCheckAt || report.providerStop === "daily_ebay" ? "provider" : "inventory";
                await writeCache(watchKey, watch);
            }
            const copies = { ...(watch && { nextCheckAt: watch.nextCheckAt, waitingFor: watch.waitingFor }), ...(alternative && { alternative }), ...(standalone && { candidates: otherCopies }),
                ...(Object.keys(candidatePrices).length > 0 && { candidatePrices }) };
            if (standalone && report.destination && !alternative) {
                return { report: { ...report, decision: "WAIT", destination: null, reason: "The selected listing became unavailable before the search finished." },
                    evaluation: null, ...copies };
            }
            const gradingOpportunity = freshGrading && report.decision === "BUY" && evaluation && alternative
                ? newGradingOpportunity(evaluation, deps.now(), targets, alternative.listing) : undefined;
            if (freshGrading && report.decision === "BUY" && !gradingOpportunity) {
                return { report: { ...report, decision: "WAIT", reason: "The grading comparisons or listing terms expired before the search finished.", marketNote },
                    evaluation: evaluation ?? null, ...copies };
            }
            if (searchedPrices.length && !report.destination && !marketNote && report.steps.length && report.steps.every(step => step.action === "find_listings")) {
                marketNote = `Searched item prices for ${new Intl.ListFormat("en-US").format(searchedPrices)}.`;
            }
            const selectedBid = evaluation && report.decision === "BID" ? evaluation : null;
            const collector = selectedBid && goal === "collect_slab" ? collectorAuction(selectedBid, deps.now(), filters.maxPrice) : null;
            const opportunity = selectedBid && goal !== "collect_slab" ? auctionOpportunity(selectedBid, targets, deps.now(), filters.maxPrice) : null;
            if (report.decision === "BID" && (collector ?? opportunity)?.status !== "BID") {
                return { report: { ...report, decision: "WAIT", reason: "The auction terms expired before the search finished.", marketNote }, evaluation: evaluation ?? null,
                    ...copies };
            }
            return { ...(collector && { collectorAuction: collector }), ...(opportunity && { auctionOpportunity: opportunity }),
                ...(gradingOpportunity && { gradingOpportunity }),
                report: marketNote ? { ...report, marketNote } : report, evaluation: evaluation ?? null,
                ...copies };
        }))), signal);
    };
}
export const runSearchDealHunt = createDealHuntService();
