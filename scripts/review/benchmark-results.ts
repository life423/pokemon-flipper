import type { AnalysisState } from "../../client/src/analysis-state.ts";
import { filterSearchResults, groupSearchResults, countSearchResults, type SearchFilters } from "../../client/src/search/results.ts";
import { canAutoAnalyze } from "../../shared/analysis.ts";
import { analysisPriority, compareAnalysisPriority } from "../../shared/analysis-priority.ts";
import { englishListingEligible } from "../../shared/card-language.ts";
import { withFreshListing } from "../../shared/fresh-listing.ts";
import { listingEvidenceKey } from "../../shared/listing-evidence.ts";
import { AUTOMATIC_PRICE_CEILING, withinAutomaticAuctionWindow, matchesListingFilters, type ListingFilters } from "../../shared/listing-filters.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { retargetEvaluation, retargetScreen } from "../../shared/money/targets.ts";
import { withResolvedCriteria } from "../../shared/search-criteria.ts";
import type { Evaluation, ListingSummary, SearchIntent, Targets } from "../../shared/types.ts";

export { compareAnalysisPriority };

// Reasons explain the existing eligibility result; they never add admission
// rules. The clock argument supports diagnostic descriptions and view expiry;
// canAutoAnalyze retains the production clock used by the actual client.
export function candidateAdmission(listing: ListingSummary, filters: ListingFilters = {}, now = Date.now(), targets: Targets = MONEY_CONFIG.targets) {
    const eligible = englishListingEligible(listing) && matchesListingFilters(listing, filters) && canAutoAnalyze(listing);
    const reasons: string[] = [];
    const screen = listing.screen;
    if (!englishListingEligible(listing)) reasons.push("OTHER_LANGUAGE");
    if (!matchesListingFilters(listing, filters)) reasons.push("FILTER_MISMATCH");
    if (!withinAutomaticAuctionWindow(listing, now)) {
        const end = Date.parse(listing.endTime ?? "");
        reasons.push(!Number.isFinite(end) ? "INVALID_AUCTION_END" : end <= now ? "ENDED_AUCTION" : "OUTSIDE_AUCTION_WINDOW");
    }
    if (listing.availability === "UNAVAILABLE") reasons.push("UNAVAILABLE_LISTING");
    if (!listing.images.length) reasons.push("NO_PHOTOS");
    if (listing.currentPrice === null || !Number.isFinite(listing.currentPrice) || listing.currentPrice < 0) reasons.push("INVALID_PRICE");
    else if (listing.currentPrice > AUTOMATIC_PRICE_CEILING) reasons.push("AUTOMATIC_PRICE_CEILING");
    if (screen?.junk || listing.match === "JUNK") reasons.push("JUNK");
    else if (listing.match) reasons.push(listing.match);
    if (screen?.pricingIssue) reasons.push(`PRICING_${screen.pricingIssue.kind}`);
    if (screen?.lowResale && !screen.lowResale.cheapFirstEditionBaseSet) reasons.push("LOW_RESALE");
    if (screen?.soldEvidence) {
        if (screen.status === "DROPPED") reasons.push("SOLD_DROPPED");
        if (screen.soldEvidence.status !== "AVAILABLE") reasons.push(`SOLD_${screen.soldEvidence.status}`);
        if (screen.focusedReview === "CHEAP_FIRST_EDITION_BASE_SET") reasons.push("FOCUSED_FIRST_EDITION_EXCEPTION");
    }
    if (eligible) reasons.unshift("ELIGIBLE");
    else if (!reasons.length) reasons.push("NO_AUTOMATIC_WORK_REQUESTED");
    return { eligible, reasons: [...new Set(reasons)], screenReason: screen?.reason ?? null, priority: analysisPriority(listing, targets) };
}

const defaults: SearchFilters = { typeFilter: "all", kindFilter: "all", maxPrice: "", minPrice: "", minGrade: 0 };
function listingFilters(filters: SearchFilters): ListingFilters {
    return { typeFilter: filters.typeFilter, kindFilter: filters.kindFilter, minPrice: Number(filters.minPrice) || 0,
        maxPrice: filters.maxPrice === "" ? undefined : Number(filters.maxPrice) };
}

// A report of returned metadata/evaluations, using the same local price
// recalculation and final views as the client. Returned usage omits failed or
// unreported transport attempts; the search usage ledger remains authoritative.
export function summarizeBenchmark(listings: readonly ListingSummary[], evaluations: Readonly<Record<string, Evaluation>>,
    errors: Readonly<Record<string, string>>, intent: SearchIntent, targets: Targets,
    { filters: selected = {}, includeOffers = false, now = Date.now() }: { filters?: Partial<SearchFilters>; includeOffers?: boolean; now?: number } = {}) {
    const filters = { ...defaults, ...selected };
    const metadata = [...new Map(listings.map(listing => [listing.id, listing])).values()];
    const analyses: Record<string, AnalysisState> = {};
    const current = metadata.map(listing => {
        const evaluation = evaluations[listing.id];
        const fresh = evaluation ? withFreshListing(listing, evaluation) : listing;
        const resolved = withResolvedCriteria(fresh, evaluation, intent);
        const value = resolved.screen ? { ...resolved, screen: retargetScreen(resolved.screen, resolved.currentPrice, targets, undefined, includeOffers) } : resolved;
        if (evaluation) analyses[value.id] = { status: "done", evidenceKey: listingEvidenceKey(value), evaluation: retargetEvaluation(evaluation, targets, value) };
        else if (errors[value.id]) analyses[value.id] = { status: "error", evidenceKey: listingEvidenceKey(value), message: errors[value.id] };
        return value;
    });
    const filtered = filterSearchResults({ listings: current, analyses, filters, page: "search", intent, now });
    const groups = groupSearchResults(filtered, analyses, includeOffers, new Set());
    const uiCounts = countSearchResults({ listings: current, analyses, filters, page: "search", intent, newMode: false, newIds: new Set() });
    const returned = metadata.flatMap(listing => evaluations[listing.id] ? [evaluations[listing.id]] : []);
    const usage = returned.flatMap(evaluation => evaluation.usage);
    const stages = [...new Set(usage.map(item => item.step))].map(step => {
        const entries = usage.filter(item => item.step === step);
        return { step, returnedStages: entries.length,
            reportedInputTokens: entries.reduce((total, item) => total + (item.inputTokens ?? 0), 0),
            reportedOutputTokens: entries.reduce((total, item) => total + (item.outputTokens ?? 0), 0),
            unreportedStages: entries.filter(item => item.inputTokens === null || item.outputTokens === null).length };
    });
    return {
        counts: { metadataLoaded: metadata.length, evaluationsReturned: returned.length,
            photoAssessed: returned.filter(evaluation => evaluation.photoCheck && evaluation.listing.photosAnalyzed > 0).length,
            resultsWithGenerationUsage: returned.filter(evaluation => evaluation.usage.length > 0).length,
            resultsWithReusedEvidence: returned.filter(evaluation => evaluation.reusedSteps.length > 0).length,
            errors: Object.values(analyses).filter(analysis => analysis.status === "error").length,
            unassessed: metadata.length - returned.length,
            visibleMatching: groups.all.length, excludedFromMatching: metadata.length - groups.all.length,
            deals: groups.deals.length, offers: groups.offers.length, sorting: groups.candidates.length, needsAttention: groups.review.length },
        groups: Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, rows.map(row => row.id)])),
        uiCounts, listings: current, analyses,
        admissions: Object.fromEntries(metadata.map(listing => [listing.id, candidateAdmission(listing, listingFilters(filters), now, targets)])),
        usage: { source: "Returned evaluations only; use the search usage ledger for all attempts and cost.", returnedStages: usage.length, stages },
    };
}
