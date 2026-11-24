import { auctionOpportunity, nextAuctionBid, withinOpportunityWindow } from "../../shared/auction-opportunity.ts";
import { collectorAuction } from "../../shared/collector-auction.ts";
import { yearOf } from "../../shared/sets.ts";
import { setYears } from "../pricing/price-tracker.ts";
import { researchAuctionSellers, researchFreshRawSellers } from "../deals/auction-seller-research.ts";
import { chooseReviewSelection } from "../deals/search-review-selection.ts";
import { availablePhotoCount } from "../../shared/analysis-priority.ts";
import { freshListingTime } from "../../shared/grading-watch.ts";
import { sellerConditionClues } from "../../shared/raw-condition-claim.ts";
import { autoAnalysisBlockReason, meetsMinimumGrade, type AutoAnalysisBlockReason } from "../../shared/analysis.ts";
import { englishListingEligible } from "../../shared/card-language.ts";
import { dealHuntGoals, type DealHuntAction, type DealHuntGoal, type DealHuntRequest, type DealHuntResponse } from "../../shared/deal-hunt.ts";
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
import { withAiUsageContext } from "../ai/usage-context.ts";
import { getListingDetails } from "../ebay/listings.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { evaluateBoundedListing, PriceOnlyEvidenceError } from "./bounded-evaluate.ts";
import { EnglishOnlyError, RejectedPhotoAssessmentError } from "./failure.ts";
import { runDealHunt, type DealHuntCandidate } from "./deal-hunt.ts";
import { verifyCollectorArtwork } from "./collector-artwork.ts";
import { huntPrintingCheck, huntPrintingTerms } from "./deal-hunt-printing.ts";
import { dealHuntCandidate, newGradingOpportunity } from "./deal-hunt-evidence.ts";
import { evaluationContextKey, loadPrivateEvaluation, type PrivateEvaluationSnapshot } from "./private-evaluation.ts";
import { loadDiagnosticDiscovery } from "./search-diagnostics.ts";
import { isSearchDiagnosticId } from "./search-diagnostic-store.ts";
import { findHuntMarkets, restoreSavedHuntSales, type HuntMarket } from "./same-set-markets.ts";
import { discoverMarketListings, type MarketQueryObservation } from "./same-set-listings.ts";
import { describeHuntMarket, huntOrigin, keepsSetSearchPreferences, marketItemLimit, marketIntent, matchesHuntMarket, photoMatchesCollectorMarket, shortlistMarketCopies } from "./deal-hunt-market-checks.ts";
import { groupMarketCopies, groupMarketSearches, huntMarketCardKey } from "./deal-hunt-market-groups.ts";
import { supplementalResearch } from "../pricing/supplemental-research.ts";
import { restoreRawComparisons } from "../pricing/saved-raw-comparisons.ts";

export class DealHuntInputError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}

export function dealHuntRequest(input: unknown): DealHuntRequest {
    const body = input as Partial<DealHuntRequest> | null;
    const targets = body?.targets;
    const scope = body?.scope === undefined ? "search" : body.scope;
    const filters = body?.filters, minimumGrade = body?.minPotentialGrade ?? 0;
    const preferences = body?.marketPreferences;
    const years = [preferences?.minYear, preferences?.maxYear];
    const freshGrading = body?.standalone === true && body.goal === "grade_raw" &&
        filters?.typeFilter === "FIXED_PRICE" && filters.kindFilter !== "graded";
    if (!body || typeof body.goal !== "string" || !Object.hasOwn(dealHuntGoals, body.goal) ||
        !["search", "same_set", "any_card"].includes(scope) || scope === "any_card" && body.goal !== "resell" &&
            !(body.goal === "collect_slab" && filters?.typeFilter === "AUCTION") && !freshGrading ||
        (body.standalone !== undefined && typeof body.standalone !== "boolean") ||
        !Array.isArray(body.listingIds) || !body.listingIds.length && scope === "search" || body.listingIds.length > DEVELOPMENT_SEARCH_LIMIT ||
        body.standalone && (scope !== "any_card" || body.listingIds.length !== 0) ||
        !Number.isFinite(minimumGrade) || minimumGrade < 0 || minimumGrade > 10 ||
        (filters !== undefined && (!filters || typeof filters !== "object" || Array.isArray(filters) ||
            ![undefined, "FIXED_PRICE", "AUCTION", "all"].includes(filters.typeFilter) ||
            ![undefined, "raw", "graded", "all"].includes(filters.kindFilter) ||
            [filters.minPrice, filters.maxPrice].some(p => p !== undefined && (!Number.isFinite(p) || p < 0)) ||
            (filters.minPrice ?? 0) > (filters.maxPrice ?? Infinity))) ||
        (preferences !== undefined && (!preferences || typeof preferences !== "object" || Array.isArray(preferences) ||
            years.some(year => year !== undefined && (!Number.isInteger(year) || year < 1900 || year > 2100)) ||
            (preferences.minYear ?? 1900) > (preferences.maxYear ?? 2100) ||
            ![undefined, "HOLO", "REVERSE_HOLO", "NON_HOLO"].includes(preferences.finish))) ||
        body.listingIds.some(id => typeof id !== "string" || !/^[\w|-]{1,120}$/.test(id)) ||
        new Set(body.listingIds).size !== body.listingIds.length || !targets ||
        ![targets.minProfit, targets.minRoi].every(amount => Number.isFinite(amount) && amount >= 0)) {
        throw new DealHuntInputError("Choose a hunt goal, valid profit and ROI targets, and listings from one completed search.");
    }
    return { goal: body.goal, scope, standalone: body.standalone === true, minPotentialGrade: minimumGrade,
        filters: filters && { typeFilter: filters.typeFilter, kindFilter: filters.kindFilter, minPrice: filters.minPrice, maxPrice: filters.maxPrice },
        ...(preferences && { marketPreferences: { minYear: preferences.minYear, maxYear: preferences.maxYear, finish: preferences.finish } }),
        listingIds: [...body.listingIds], targets: { minProfit: targets.minProfit, minRoi: targets.minRoi } };
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
        rows.push({ listing, block, assessable: autoAnalysisBlockReason(source) === null, ...(excluded && { excludedFromHunt: true }),
            ...(screen?.reason && { screenReason: screen.reason }), ...(screen?.gradingLead && { gradingLead: true }) });
    }
    await writeCache(inventoryKey(searchId), { intent, filters, rows } satisfies HuntInventory);
}

const defaults = {
    discovery: loadDiagnosticDiscovery,
    inventory: loadSearchReviewInventory,
    snapshot: loadPrivateEvaluation,
    details: getListingDetails,
    restoreRaw: restoreRawComparisons,
    supplement: supplementalResearch,
    evaluate: evaluateBoundedListing,
    verifyCollectorArtwork,
    plan: runDealHunt,
    markets: findHuntMarkets,
    discoverMarket: discoverMarketListings,
    now: Date.now,
    setYears,
    researchAuctionSellers,
    researchFreshRawSellers,
    selectReviews: chooseReviewSelection,
};
type Dependencies = typeof defaults;
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
    liveListing(): ListingSummary | null;
}

function scopedCandidate(id: string, goal: DealHuntGoal, targets: Targets, searchId: string, saved: PrivateEvaluationSnapshot | null,
    inventory: HuntInventory | null, row: HuntRow | undefined, evaluations: Map<string, Evaluation>, deps: Dependencies,
    filters: ListingFilters, minGrade: number, acceptsMarket: (set?: string | null, finish?: string | null) => boolean, markets: HuntMarket[] = [],
    freshGrading = false): ScopedCandidate | null {
    // Never use an unrelated old version of a card simply because its eBay ID is the same.
    if (saved && (saved.evaluation.listing.id !== id || (row ? !rowMatches(row, saved) : saved.searchId !== searchId))) saved = null;
    const format = filters.typeFilter === "AUCTION" ? "AUCTION" : "FIXED_PRICE";
    const auction = format === "AUCTION";
    if (auction && !withinOpportunityWindow(row?.listing.endTime ?? saved?.evaluation.listing.endTime, deps.now())) return null;
    let checkFullListing = Boolean((markets.length || auction) && saved);
    let value = saved && retargetEvaluation(saved.evaluation, targets, row?.listing);
    if (freshGrading && (!row || freshListingTime(row.listing, deps.now()) === null)) return null;
    const matches = (e: Evaluation) => e.listing.buyingOption === format && acceptsMarket(e.identity?.set, e.identity?.finish) && fits(e, row, inventory) && meetsMinimumGrade(e, minGrade) && (!markets.length || markets.some(market => matchesHuntMarket(e, market, !!huntPrintingCheck(e), freshGrading) && !evaluatedCriteriaMismatch(e, marketIntent(market)))) &&
        (!row || matchesListingFilters({ ...row.listing, currentPrice: e.listing.price }, filters, e));
    if (value && !matches(value)) return null;
    const reader = () => value && dealHuntCandidate(value, goal, deps.now, markets, targets, filters.maxPrice);
    const initial = reader();
    let artworkVerified = !row?.collectorQuery;
    if (value && !initial) return null;
    if (!value && (!row?.assessable || goal === "grade_raw" && row.listing.isGraded || goal === "collect_slab" && !row.listing.isGraded)) return null;
    if (value && artworkVerified) evaluations.set(id, value);
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
        liveListing() {
            if (!card || retired || !artworkVerified) return null;
            const latest = value ? withFreshListing(card, value) : card;
            if (!latest.images.length || latest.availability === "UNAVAILABLE" ||
                latest.endTime && !(Date.parse(latest.endTime) > deps.now()) ||
                auction && !withinOpportunityWindow(latest.endTime, deps.now()) ||
                freshGrading && freshListingTime(latest, deps.now()) === null) return null;
            return latest;
        },
        available: checked => retired ? [] : !artworkVerified ? ["inspect_photos"] : reader()?.available(checked) ??
            (auction && !checked.has("check_listing") ? ["check_listing", "inspect_photos"] : ["inspect_photos"]),
        outcome(checked) {
            if (!value || retired || !artworkVerified) return null;
            const evidence = reader();
            if (evidence?.available(checked).includes("check_price_references")) return null;
            const result = evidence?.outcome(checked);
            if (!result) return null;
            if (quotaNote) return { ...result, decision: "WAIT", reason: `${result.reason} ${quotaNote}` };
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
                    reason: `${result.reason} A fresh grading buy requires front and back evidence, three recent sales at the likely grade, and a profitable sale comparison one grade lower.` };
                return { ...result, section: "grading", reason: `Grading with ${opportunity.grader} costs ${dollars(opportunity.gradingCosts)} including submission shipping. Grade ${opportunity.likely.grade} projects ${dollars(opportunity.likely.profit)} profit after costs (${opportunity.likely.sales30} recent sales). One grade lower, grade ${opportunity.lower.grade} projects ${dollars(opportunity.lower.profit)} (${opportunity.lower.sales30} recent sales).` };
            }
            return result;
        },
        async read(action, signal) {
            signal?.throwIfAborted();
            if (retired) return "This copy was excluded from the hunt.";
            if (!artworkVerified && action !== "inspect_photos") return "Check the original front against the catalog first.";
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
                        card = { ...row.listing, currentPrice: detail.price, shipping: detail.shipping, images: detail.images,
                            availability: detail.availability, endTime: detail.endTime, bids: detail.bids, termsCheckedAt: detail.retrievedAt };
                        return `eBay shows the next bid at ${dollars(next)} and the total with shipping and estimated tax at ${dollars(total)}. The original photos can now be assessed.`;
                    }
                    if (action !== "inspect_photos" || !row?.assessable) return retire("This copy has no eligible photo check.");
                    value = await deps.evaluate(id, { automatic: true, typeFilter: format, targets, signal });
                    if (row.listing.title.trim() !== value.listing.title.trim() ||
                        !searchPhotosFitDetails(row.listing.images, value.listing.photos ?? [])) {
                        return retire("The listing or gallery changed since this search. Its original evidence cannot support a buy.");
                    }
                } else if (action === "resolve_printing") {
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
                } else if (action === "check_price_references") {
                    const eligible = () => reader()?.available(referencePrerequisites).includes("check_price_references");
                    if (!eligible()) return "The current listing terms or market evidence no longer warrant a supplemental lookup.";
                    const now = deps.now();
                    const options = { now, signal: signal ?? new AbortController().signal };
                    const cached = await deps.supplement(value, { ...options, cacheOnly: true });
                    value = { ...value, ...cached };
                    if (eligible()) {
                        signal?.throwIfAborted();
                        value = { ...value, ...await deps.supplement(value, { ...options, cacheOnly: false }) };
                    }
                } else if (action === "check_listing" && value.listing.availability !== "UNAVAILABLE") {
                    const age = deps.now() - Date.parse(value.listing.termsCheckedAt ?? "");
                    if (checkFullListing || !(age >= 0 && age <= BEST_BUY_TERMS_MAX_AGE_MS) || auction && nextAuctionBid(value.listing, deps.now()) === null) {
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
                if (error instanceof EbayError && [404, 410].includes(error.status)) return retire("This copy is no longer available on eBay.");
                if (error instanceof EnglishOnlyError || error instanceof PriceOnlyEvidenceError || error instanceof RejectedPhotoAssessmentError) {
                    return retire("The updated listing could not be matched to eligible photo and price evidence. The hunt can check another copy.");
                }
                if (!(error instanceof EbayBudgetError && error.reason === "QUOTA" && value &&
                    (action === "check_sales" || action === "check_raw_resale" || action === "check_listing"))) throw error;
                quotaNote = "The eBay allowance prevented a fresh check. These figures use the last checked listing.";
            }
            signal?.throwIfAborted();
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
            return [artworkObservation, observation, quotaNote].filter(Boolean).join(" ");
        },
    };
}

export function createDealHuntService(overrides: Partial<Dependencies> = {}) {
    const deps = { ...defaults, ...overrides };
    const share = createSharedWork();
    return (searchId: string, input: unknown, signal: AbortSignal): Promise<DealHuntResponse> => {
        if (!isSearchDiagnosticId(searchId)) throw new DealHuntInputError("A valid completed search is required.");
        const request = dealHuntRequest(input);
        const { listingIds, goal, targets, scope, standalone, minPotentialGrade = 0 } = request;
        return share(JSON.stringify([searchId, request]), async active => {
            const discovery = standalone ? null : await deps.discovery(searchId);
            if (!standalone && !discovery) throw new DealHuntInputError("This saved search is no longer available.", 404);
            const retained = new Set(discovery?.discovery.retainedIds);
            if (listingIds.some(id => !retained.has(id))) throw new DealHuntInputError("The hunt contains a listing outside this search.", 409);
            const inventory = standalone ? null : await deps.inventory(searchId);
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
            const { minYear, maxYear, finish } = request.marketPreferences ?? {};
            const yearRange = minYear !== undefined || maxYear !== undefined;
            const years = yearRange ? await deps.setYears() : {};
            const acceptsSet = (set?: string | null) => {
                if (!yearRange) return true;
                const year = yearOf(years, set);
                return year !== null && year >= (minYear ?? 1900) && year <= (maxYear ?? 2100);
            };
            const acceptsMarket = (set?: string | null, cardFinish?: string | null) => (!finish || finish === cardFinish) && acceptsSet(set);
            const rows = new Map(inventory?.rows.filter(row => row.listing.buyingOption === format &&
                (!row.excludedFromHunt || format === "AUCTION" && row.assessable && !row.listing.match && englishListingEligible(row.listing))).map(row => [row.listing.id, row]));
            const evaluations = new Map<string, Evaluation>();
            const candidates: DealHuntCandidate[] = [];
            const alternatives = new Map<string, { candidate: ScopedCandidate; leads: HuntMarket[]; reason: string }>();
            // Keep private SQL reads bounded. Preserve display order even if reads finish out of order.
            for (let offset = 0; offset < listingIds.length; offset += 4) {
                active.throwIfAborted();
                const batch = listingIds.slice(offset, offset + 4).filter(id => !inventory || rows.has(id));
                const snapshots = await Promise.all(batch.map(id => deps.snapshot(id)));
                batch.forEach((id, index) => {
                    const candidate = scopedCandidate(id, goal, targets, searchId, snapshots[index], inventory,
                        rows.get(id), evaluations, deps, filters, minPotentialGrade, acceptsMarket);
                    if (candidate) candidates.push(candidate);
                });
            }
            const markets = [];
            const searchedPrices: string[] = [];
            let marketNote: string | undefined;
            if (scope === "any_card" || scope === "same_set") {
                const origin = huntOrigin(inventory?.intent, evaluations.values());
                const leads = scope === "same_set" && !origin ? [] : await deps.markets(origin, goal, scope, active, acceptsSet);
                active.throwIfAborted();
                const knownIds = new Set(retained);
                const permitted = leads.filter(lead => acceptsMarket(lead.set, lead.finish) && (scope !== "same_set" || keepsSetSearchPreferences(lead, inventory?.intent)));
                for (const group of groupMarketSearches(permitted, goal, targets, filters, minPotentialGrade, knownIds)) {
                    const [intent, ...relatedIntents] = group.intents;
                    const reference = group.leads[0];
                    const recentAsk = group.observedPurchaseTotal === undefined ? "" :
                        ` A matching copy was seen in the last 24 hours at ${dollars(group.observedPurchaseTotal)} including shipping and estimated tax. Check its current price and availability.`;
                    const summary = group.leads.map(describeHuntMarket).join(" ") + recentAsk;
                    markets.push({ cardKey: huntMarketCardKey(reference), releaseYear: yearOf(years, reference.set) ?? undefined,
                        title: `${reference.name} ${reference.cardNumber} · ${reference.set}`,
                        summary: summary + ` Research item prices up to ${dollars(group.ceiling)} before adjusting for shipping.`,
                        async discover(_signal?: AbortSignal, reportQueries?: (description: string) => void) {
                            const queries: MarketQueryObservation[] = [];
                            const useNumbers = format === "FIXED_PRICE" && !intent.graded;
                            const found = await deps.discoverMarket(searchId, intent, { ...filters, maxPrice: group.ceiling }, active,
                                { relatedIntents, ...(freshGrading && { newlyListedRaw: true }), ...(useNumbers && {
                                    collectorNumberDiscovery: "fallback", knownListingIds: knownIds,
                                    isUsable: listing => group.leads.some(lead => shortlistMarketCopies([listing], lead, goal, targets, filters).length > 0),
                                    onQuery: query => queries.push(query),
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
                            let picks = fresh.slice(0, 6);
                            if (freshGrading && fresh.length) {
                                const pool = fresh.slice(0, DEVELOPMENT_SEARCH_LIMIT);
                                const rows = await deps.researchFreshRawSellers(pool.map(copy => copy.listing), deps.now(), active);
                                const ranked = await deps.selectReviews(rows, targets, active, deps.now());
                                const copies = new Map(pool.map((copy, index) => [copy.listing.id, { ...copy, listing: rows[index] }]));
                                picks = ranked.listingIds.map(id => copies.get(id)!).filter(Boolean);
                            }
                            const discovered: DealHuntCandidate[] = [];
                            for (const { listing, leads } of picks) {
                                active.throwIfAborted();
                                const row = { listing, assessable: autoAnalysisBlockReason(listing, deps.now()) === null, collectorQuery: numberQueries.get(listing.id) };
                                const saved = await deps.snapshot(listing.id);
                                // Each candidate verifies the complete identity against its viable exits.
                                const candidate = scopedCandidate(listing.id, goal, targets, searchId, saved, null,
                                    row, evaluations, deps, filters, minPotentialGrade, acceptsMarket, leads, freshGrading);
                                if (!candidate) continue;
                                const matched = saved ? leads.filter(lead => matchesHuntMarket(saved.evaluation, lead)) : [];
                                const reason = (matched.length ? matched : leads).map(describeHuntMarket).join(" ");
                                knownIds.add(listing.id);
                                alternatives.set(listing.id, { candidate, leads, reason });
                                discovered.push({ ...candidate, summary: `${candidate.summary} ${reason} Item ${dollars(listing.currentPrice)}.` });
                            }
                            if (freshGrading && fresh.length >= DEVELOPMENT_SEARCH_LIMIT) {
                                // The same candidate closure retains its assessment for every subsequent planner check.
                                let reviewed = 0;
                                for (let i = 0; i < discovered.length; i += BOUNDED_AUTO_CONCURRENCY) {
                                    active.throwIfAborted();
                                    const batch = discovered.slice(i, i + BOUNDED_AUTO_CONCURRENCY);
                                    const results = await Promise.allSettled(batch.map(async candidate => {
                                        const photos = await withAiUsageContext({ searchId, listingId: candidate.listingId }, () =>
                                            Promise.resolve(candidate.read("inspect_photos", active)));
                                        candidate.summary = `${photos} ${candidate.summary}`;
                                        if (evaluations.has(candidate.listingId)) reviewed++;
                                    }));
                                    const failure = results.find(result => result.status === "rejected");
                                    if (failure) throw failure.reason;
                                }
                                marketNote = `Reviewed photos for ${reviewed} of ${picks.length} selected copies from ${DEVELOPMENT_SEARCH_LIMIT} eligible listings for ${reference.name}.`;
                            }
                            return discovered;
                        } });
                }
                if (!markets.length) marketNote = scope === "same_set" && !origin
                    ? "The original results did not establish a single set to explore."
                    : goal === "collect_slab" ? "No matching slab market in the saved research had a verified sale in the past 30 days."
                    : "No other market in the saved research met your filters and had three distinct matching sales in the past 30 days.";
            }
            const report = await deps.plan({ searchId, goal, candidates, markets, auction: format === "AUCTION" }, active);
            active.throwIfAborted();
            const evaluation = report.destination ? evaluations.get(report.destination.listingId) : null;
            if (report.destination && !evaluation) throw new Error("The selected evidence is unavailable.");
            let alternative: DealHuntResponse["alternative"];
            const otherCopies: ListingSummary[] = [];
            for (const [id, { candidate, leads, reason }] of alternatives) {
                const listing = candidate.liveListing();
                if (!listing) continue;
                if (id === report.destination?.listingId) alternative = { listing, reason };
                else if (standalone && otherCopies.length < DEVELOPMENT_SEARCH_LIMIT &&
                    leads.some(lead => shortlistMarketCopies([listing], lead, goal, targets, filters).length)) otherCopies.push(listing);
            }
            const copies = { ...(alternative && { alternative }), ...(standalone && { candidates: otherCopies }) };
            if (standalone && report.destination && !alternative) {
                return { report: { ...report, decision: "WAIT", destination: null, reason: "The selected listing became unavailable before the hunt finished." },
                    evaluation: null, ...copies };
            }
            const gradingOpportunity = freshGrading && report.decision === "BUY" && evaluation && alternative
                ? newGradingOpportunity(evaluation, deps.now(), targets, alternative.listing) : undefined;
            if (freshGrading && report.decision === "BUY" && !gradingOpportunity) {
                return { report: { ...report, decision: "WAIT", reason: "The grading comparisons or listing terms expired before the hunt finished.", marketNote },
                    evaluation: evaluation ?? null, ...copies };
            }
            if (!report.destination && !marketNote && report.steps.length && report.steps.every(step => step.action === "find_listings")) {
                marketNote = `Searched item prices for ${new Intl.ListFormat("en-US").format(searchedPrices)}.`;
            }
            const selectedBid = evaluation && report.decision === "BID" ? evaluation : null;
            const collector = selectedBid && goal === "collect_slab" ? collectorAuction(selectedBid, deps.now(), filters.maxPrice) : null;
            const opportunity = selectedBid && goal !== "collect_slab" ? auctionOpportunity(selectedBid, targets, deps.now(), filters.maxPrice) : null;
            if (report.decision === "BID" && (collector ?? opportunity)?.status !== "BID") {
                return { report: { ...report, decision: "WAIT", reason: "The auction terms expired before the hunt finished.", marketNote }, evaluation: evaluation ?? null,
                    ...copies };
            }
            return { ...(collector && { collectorAuction: collector }), ...(opportunity && { auctionOpportunity: opportunity }),
                ...(gradingOpportunity && { gradingOpportunity }),
                report: marketNote ? { ...report, marketNote } : report, evaluation: evaluation ?? null,
                ...copies };
        }, signal);
    };
}
export const runSearchDealHunt = createDealHuntService();
