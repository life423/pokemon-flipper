import { withinOpportunityWindow } from "./auction-window.ts";
import { listingDisclosesCardCrease } from "./ebay-condition-notes.ts";
import { sellerConditionClues } from "./raw-condition-claim.ts";
import type { ListingSummary } from "./types.ts";

// This ranking chooses research work. Only the separate photo and money checks can recommend a bid.
export function auctionPhotoPriority(listing: ListingSummary, now: number): number {
    if (listing.buyingOption !== "AUCTION" || listing.isGraded || listing.match || listing.screen?.status === "DROPPED" ||
        listing.availability === "UNAVAILABLE" || !listing.images.length || !withinOpportunityWindow(listing.endTime, now)) return 0;
    const claim = sellerConditionClues(listing);
    if (claim.severe || claim.conflict || listingDisclosesCardCrease(listing)) return 0;
    const profile = listing.auctionResearch;
    const mixedInventory = profile && profile.otherListings >= 5 && profile.otherListings > profile.cardListings * 2;
    const vague = listing.mistakes?.some(m => m.kind === "GENERIC_TITLE") || !/\d{1,3}\s*\/\s*\d{1,3}/.test(listing.title);
    const cleanClaim = claim.claim === "NEAR_MINT" || claim.claim === "MINT";
    return 1 + Number(vague) + Number(cleanClaim) + (listing.screen?.gradingLead ? 3 : 0) + (mixedInventory ? 4 : 0);
}
