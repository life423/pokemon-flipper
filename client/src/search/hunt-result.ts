import type { BuyingOption, Evaluation, Targets } from "../../../shared/types.ts";
import { auctionOpportunity } from "../../../shared/auction-opportunity.ts";
import { GRADING_WATCH_FRESH_MS, freshListingTime } from "../../../shared/grading-watch.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../../shared/search-diagnostic.ts";
import { observedCardKind } from "../../../shared/photo-evidence.ts";
import { collectorAuction } from "../../../shared/collector-auction.ts";
import type { DealHuntGoal, DealHuntReport, DealHuntResponse, DealHuntScope, DealHuntSection } from "../../../shared/deal-hunt.ts";
import { listingEvidenceKey, searchPhotosFitDetails } from "../../../shared/listing-evidence.ts";
import { parseListingLink } from "../../../shared/listing-link.ts";
import type { ListingSummary } from "../../../shared/types.ts";
import { withFreshListing } from "../../../shared/fresh-listing.ts";

export const expiredGradingReason = "This grading quote has expired. Run the hunt again for current listings and resale evidence.";

export const huntSections: Record<DealHuntSection, string> = {
    grading: "grading breakdown", sales: "price evidence", photos: "photo evidence",
};

export function huntDecisionLabel({ decision, goal }: DealHuntReport) {
    if (decision === "BID") return goal === "collect_slab" ? "Collector bid" : "Bid opportunity";
    return decision === "BUY" ? "Buy" : "Wait";
}

export function supportsCrossCardHunt(goal: DealHuntGoal, format: BuyingOption): boolean {
    return goal === "resell" || (format === "FIXED_PRICE" ? goal === "grade_raw" : goal === "collect_slab");
}

export function currentHuntBid(goal: DealHuntGoal, evaluation: Evaluation, targets: Targets, now: number, maxDelivered?: number) {
    return goal === "collect_slab" ? collectorAuction(evaluation, now, maxDelivered)
        : auctionOpportunity(evaluation, targets, now, maxDelivered);
}

export function reconcileHuntListing(original: ListingSummary, evaluation: Evaluation, current = original) {
    const reviewed = evaluation.listing;
    const updated = withFreshListing(original, evaluation);
    const matchesSnapshot = (snapshot: ListingSummary) => listingEvidenceKey(snapshot) === listingEvidenceKey(current) &&
        snapshot.currentPrice === current.currentPrice && snapshot.shipping === current.shipping;
    const compatible = original.id === reviewed.id && current.id === reviewed.id &&
        (matchesSnapshot(original) || matchesSnapshot(updated));
    const checked = Date.parse(reviewed.termsCheckedAt ?? "");
    const currentChecked = Date.parse(current.termsCheckedAt ?? "");
    // Keep an explicit unavailable update even if it carries no comparable timestamp.
    const unavailable = current.availability === "UNAVAILABLE" && !(currentChecked < checked);
    const listing = compatible && !unavailable ? withFreshListing(current, evaluation) : current;
    const currentTerms = compatible && listing.availability === "ACTIVE" && reviewed.availability === "ACTIVE" &&
        listing.currentPrice === reviewed.price && listing.shipping === reviewed.shipping &&
        (listing.shippingDestination ?? null) === (reviewed.shippingDestination ?? null) &&
        listing.termsCheckedAt === reviewed.termsCheckedAt && listing.endTime === reviewed.endTime &&
        listing.buyingOption === reviewed.buyingOption && listing.bids === reviewed.bids;
    return { compatible, currentTerms, listing };
}

export function selectedHuntListing(response: DealHuntResponse, searchId: string, goal: DealHuntGoal, scope: DealHuntScope, listings: ListingSummary[], format: BuyingOption = "FIXED_PRICE") {
    const { report, evaluation, alternative } = response;
    const destination = report.destination;
    const mismatch = "The returned evidence does not match this hunt. Run it again on the current results.";
    if (report.searchId !== searchId || report.goal !== goal || !["WAIT", format === "AUCTION" ? "BID" : "BUY"].includes(report.decision)) throw new Error(mismatch);
    if (scope === "search" && response.candidates?.some(row => !listings.some(match => match.id === row.id))) throw new Error(mismatch);
    if (!destination) {
        if (report.decision !== "WAIT" || alternative || evaluation) throw new Error(mismatch);
        return undefined;
    }
    if (!Object.hasOwn(huntSections, destination.section) || evaluation?.listing.id !== destination.listingId) throw new Error(mismatch);
    const bid = goal === "collect_slab" ? response.collectorAuction : response.auctionOpportunity;
    if (evaluation.listing.buyingOption !== format || report.decision === "BID" &&
        (bid?.listingId !== destination.listingId || bid.status !== "BID" || !(bid.validUntil > Date.now()))) throw new Error(mismatch);
    const retained = listings.find(row => row.id === destination.listingId);
    if (!alternative) {
        if (!retained || retained.buyingOption !== format) throw new Error(mismatch);
        return retained;
    }
    const { listing, reason } = alternative;
    if (retained || scope === "search" || scope === "any_card" && !supportsCrossCardHunt(goal, format) || !reason?.trim() ||
        listing.id !== destination.listingId || listing.buyingOption !== format ||
        parseListingLink(listing.url)?.itemId !== listing.id || parseListingLink(evaluation.listing.url)?.itemId !== listing.id ||
        listing.title.trim() !== evaluation.listing.title.trim() || !searchPhotosFitDetails(listing.images, evaluation.listing.photos ?? [])) throw new Error(mismatch);
    if (goal === "grade_raw" && scope === "any_card" && report.decision === "BUY") {
        const now = Date.now();
        const listed = freshListingTime(listing, now);
        const quote = response.gradingOpportunity;
        const checked = Date.parse(evaluation.listing.termsCheckedAt ?? "");
        if (!quote || listed === null || Date.parse(quote.listingDate) !== listed || observedCardKind(evaluation) !== "raw" ||
            !(checked <= now && quote.validUntil > now && quote.validUntil <= checked + BEST_BUY_TERMS_MAX_AGE_MS &&
                quote.validUntil <= listed + GRADING_WATCH_FRESH_MS)) throw new Error(mismatch);
    }
    return listing;
}
