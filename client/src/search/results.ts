import type { Evaluation, ListingSummary, RatingLevel, SearchIntent, Targets } from "../types.ts";
import type { AnalysisState } from "../analysis-state.ts";
import { canAutoAnalyze, meetsMinimumGrade, resultGroup, type ResultGroup } from "../../../shared/analysis.ts";
import { compareAnalysisPriority } from "../../../shared/analysis-priority.ts";
import { evaluatedCriteriaMismatch } from "../../../shared/search-criteria.ts";
import { rateDeal } from "../../../shared/money/rating.ts";
import { compareListingEvidence, listingSignals } from "../../../shared/signals.ts";
import { matchesListingFilters } from "../../../shared/listing-filters.ts";
import { englishListingEligible } from "../../../shared/card-language.ts";

export type View = ResultGroup | "all" | "new";

export type SortKey = "best" | "overlooked" | "ending" | "priceLow" | "priceHigh";
export type TypeFilter = "all" | "AUCTION" | "FIXED_PRICE";
export type KindFilter = "all" | "raw" | "graded";

export type SearchPage = "search" | "shortlist" | "listing";
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
        .filter((listing) => listing.availability !== "UNAVAILABLE")
        .filter((listing) => matchesListingFilters(listing, { typeFilter, kindFilter, maxPrice: limit, minPrice: floor }, evaluationOf(analyses[listing.id]), page === "search" ? intent?.graded : null))
        .filter((listing) => {
            const evaluation = evaluationOf(analyses[listing.id]);
            return !evaluation || meetsMinimumGrade(evaluation, minGrade);
        })
        .filter((listing) => !listing.endTime || Date.parse(listing.endTime) > now);
}

export function groupSearchResults(filtered: ListingSummary[], analyses: Record<string, AnalysisState>, includeOffers: boolean, newIds: ReadonlySet<string>): ResultGroups {
    const grouped: Record<ResultGroup, ListingSummary[]> = { deals: [], offers: [], candidates: [], review: [] };

    for (const listing of filtered) {
        const evaluation = evaluationOf(analyses[listing.id]);
        const group = resultGroup(listing, evaluation, includeOffers, analyses[listing.id]?.status === "error");
        if (group) grouped[group].push(listing);
    }

    return { ...grouped, all: filtered, new: filtered.filter((listing) => newIds.has(listing.id)) };
}

export function sortSearchResults(listings: ListingSummary[], analyses: Record<string, AnalysisState>, sort: SortKey, targets: Targets, now: number): ListingSummary[] {
    const compareBest = (a: ListingSummary, b: ListingSummary) => {
        const ea = evaluationOf(analyses[a.id]);
        const eb = evaluationOf(analyses[b.id]);
        const ra = isDeal(ea) ? currentRating(ea) : null;
        const rb = isDeal(eb) ? currentRating(eb) : null;

        if (ra && rb) {
            if (ra.level !== rb.level) return LEVEL_ORDER[ra.level] - LEVEL_ORDER[rb.level];
            return (eb?.underwriting?.best?.profit ?? 0) - (ea?.underwriting?.best?.profit ?? 0);
        }
        if (ra) return -1;
        if (rb) return 1;

        return compareAnalysisPriority(a, b, targets);
    };

    // The listings with the strongest signs of being overlooked first.
    const compareOverlooked = (a: ListingSummary, b: ListingSummary) => {
        const verified = Number(isDeal(evaluationOf(analyses[b.id]))) - Number(isDeal(evaluationOf(analyses[a.id])));
        return verified || compareListingEvidence(listingSignals(a, evaluationOf(analyses[a.id]), now), listingSignals(b, evaluationOf(analyses[b.id]), now)) || compareBest(a, b);
    };

    return [...listings].sort(sort === "best" ? compareBest : sort === "overlooked" ? compareOverlooked : SORTS[sort]);
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
