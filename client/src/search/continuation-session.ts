import type { ListingFilters, MarketplaceOrder } from "../../../shared/listing-filters.ts";
import type { SearchPlan } from "../../../shared/search-plan.ts";
import type { AnalysisState } from "../analysis-state";
import type { DealsMessage } from "../api";
import type { ListingSummary, Targets } from "../types";
import type { AnalysisBlockCode } from "./presentation";
import type { BuyerReviewCheckpoint } from "./useBuyerReviews";

const SESSION_KEY = "pokemon-flipper.discovery.v1";

export type ContinuationRequest = {
    rootId: string;
    query: string;
    filters: ListingFilters;
    targets: Targets;
    offers: boolean;
    automaticPhotos: boolean;
    order: MarketplaceOrder;
};

export type SearchCoverage = Extract<DealsMessage, { type: "done" }> & { searchTargets: Targets };

export interface ContinuationSession {
    originalQuery: string;
    shippingDestination?: string | null;
    request: ContinuationRequest;
    plan: SearchPlan | null;
    filters: ListingFilters;
    targets: Targets;
    offers: boolean;
    lastBatchId: string;
    owners: [string, string][];
    listings: ListingSummary[];
    analyses: Record<string, Extract<AnalysisState, { status: "done" }>>;
    reviews: BuyerReviewCheckpoint;
    summary: Extract<DealsMessage, { type: "start" }>;
    coverage: SearchCoverage | null;
    newIds: string[] | null;
    stopped: boolean;
    searchError: string;
    analysisBlocked: string;
    analysisBlockCode: AnalysisBlockCode | null;
}

export function matchesContinuationDestination(saved: ContinuationSession, zip: string | null) {
    if (saved.shippingDestination !== undefined) return saved.shippingDestination === zip;
    const matches = (listing: { shippingDestination?: string | null }) => (listing.shippingDestination ?? null) === zip;
    return saved.listings.every(matches) && Object.values(saved.analyses).every(analysis => matches(analysis.evaluation.listing)) &&
        saved.reviews.every(([, review]) => !review.decision.verifiedPurchase || matches(review.decision.verifiedPurchase));
}

export function readContinuationSession(): ContinuationSession | null {
    try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const saved = JSON.parse(raw) as ContinuationSession;
        if (typeof saved.originalQuery !== "string" || !saved.request?.query || !saved.request.filters ||
            !saved.filters || !saved.targets || !saved.request.rootId || !saved.lastBatchId ||
            saved.summary?.type !== "start" || !saved.summary.intent || !Array.isArray(saved.listings) ||
            !Array.isArray(saved.owners) || !Array.isArray(saved.reviews) || !saved.analyses) return null;
        return saved;
    } catch {
        return null;
    }
}

export function writeContinuationSession(saved: ContinuationSession | null) {
    try {
        if (saved) sessionStorage.setItem(SESSION_KEY, JSON.stringify(saved));
        else sessionStorage.removeItem(SESSION_KEY);
    } catch {
        // A full or disabled store must not stop the running search. Keep the
        // previous successful batch so recovery can replay the same receipts.
    }
}
