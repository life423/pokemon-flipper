import type { AuctionOpportunity } from "../../../shared/auction-opportunity.ts";
import type { SniperQuote } from "../../../shared/sniper.ts";
import type { ListingSummary } from "../../../shared/types.ts";

export interface SniperDraft {
    itemId: string;
    title: string;
    url: string;
    searchId?: string;
    suggestion: { maxBid: number; shipping: number; title: string; endTime: string; validUntil?: number } | null;
}

export function flipSniperDraft(listing: ListingSummary, offer: AuctionOpportunity, now: number, searchId?: string): SniperDraft | null {
    if (offer.status !== "BID" || offer.listingId !== listing.id || listing.buyingOption !== "AUCTION" || listing.availability !== "ACTIVE" ||
        offer.marketBasis?.startsWith("TCGPLAYER_") || !(offer.validUntil > now) || offer.endsAt !== listing.endTime ||
        offer.checkedAt !== listing.termsCheckedAt || listing.currentPrice !== offer.currentPrice || listing.shipping == null ||
        offer.maxBid == null || offer.nextBid == null || !(offer.maxBid >= offer.nextBid && offer.nextBid > 0)) return null;
    return { itemId: listing.id, title: listing.title, url: listing.url, searchId,
        suggestion: { title: listing.title, endTime: offer.endsAt, shipping: listing.shipping, maxBid: offer.maxBid, validUntil: offer.validUntil } };
}

export function suggestedBid(draft: SniperDraft | null, quote: SniperQuote | null, now = Date.now()) {
    const suggestion = draft?.suggestion;
    return suggestion && quote && (suggestion.validUntil == null || suggestion.validUntil > now) &&
        quote.itemId === draft.itemId && quote.shipping === suggestion.shipping && quote.minimumBid != null &&
        quote.minimumBid > 0 && Math.max(quote.minimumBid, quote.currentBid ?? 0) <= suggestion.maxBid &&
        quote.title.trim() === suggestion.title.trim() && Date.parse(quote.endTime) === Date.parse(suggestion.endTime) && Date.parse(quote.endTime) > now
        ? suggestion.maxBid : undefined;
}
