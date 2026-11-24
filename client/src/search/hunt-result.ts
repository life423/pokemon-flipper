import type { BuyingOption, Evaluation, Targets } from "../../../shared/types.ts";
import { auctionOpportunity } from "../../../shared/auction-opportunity.ts";
import { collectorAuction } from "../../../shared/collector-auction.ts";
import type { DealHuntGoal, DealHuntReport, DealHuntResponse, DealHuntScope, DealHuntSection } from "../../../shared/deal-hunt.ts";
import { searchPhotosFitDetails } from "../../../shared/listing-evidence.ts";
import { parseListingLink } from "../../../shared/listing-link.ts";
import type { ListingSummary } from "../../../shared/types.ts";

export const huntSections: Record<DealHuntSection, string> = {
    grading: "grading breakdown", sales: "price evidence", photos: "photo evidence",
};

export function huntDecisionLabel({ decision, goal }: DealHuntReport) {
    if (decision === "BID") return goal === "collect_slab" ? "Collector bid" : "Bid opportunity";
    return decision === "BUY" ? "Buy" : "Wait";
}

export function currentHuntBid(goal: DealHuntGoal, evaluation: Evaluation, targets: Targets, now: number, maxDelivered?: number) {
    return goal === "collect_slab" ? collectorAuction(evaluation, now, maxDelivered)
        : auctionOpportunity(evaluation, targets, now, maxDelivered);
}

export function selectedHuntListing(response: DealHuntResponse, searchId: string, goal: DealHuntGoal, scope: DealHuntScope, listings: ListingSummary[], format: BuyingOption = "FIXED_PRICE") {
    const { report, evaluation, alternative } = response;
    const destination = report.destination;
    const mismatch = "The returned evidence does not match this hunt. Run it again on the current results.";
    if (report.searchId !== searchId || report.goal !== goal || !["WAIT", format === "AUCTION" ? "BID" : "BUY"].includes(report.decision)) throw new Error(mismatch);
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
    const openMarket = goal === "resell" || goal === "collect_slab" && format === "AUCTION";
    if (retained || scope === "search" || scope === "any_card" && !openMarket || !reason?.trim() ||
        listing.id !== destination.listingId || listing.buyingOption !== format ||
        parseListingLink(listing.url)?.itemId !== listing.id || parseListingLink(evaluation.listing.url)?.itemId !== listing.id ||
        listing.title.trim() !== evaluation.listing.title.trim() || !searchPhotosFitDetails(listing.images, evaluation.listing.photos ?? [])) throw new Error(mismatch);
    return listing;
}
