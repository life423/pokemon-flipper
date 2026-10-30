import type { Evaluation, ListingSummary } from "./types.ts";

// An explicit fresh evaluation carries server-checked terms. Do not put an older
// browser snapshot back over them. A later selected refresh still takes priority.
export function withFreshListing(current: ListingSummary, evaluation: Evaluation): ListingSummary {
    const checked = evaluation.listing.termsCheckedAt;
    if (!checked || !Number.isFinite(Date.parse(checked))) return current;
    if (current.termsCheckedAt && Date.parse(current.termsCheckedAt) > Date.parse(checked)) return current;
    const listing = evaluation.listing;
    return { ...current, title: listing.title, url: listing.url, currentPrice: listing.price, shipping: listing.shipping,
        bids: listing.bids, endTime: listing.endTime, buyingOption: listing.buyingOption, images: listing.photos ?? current.images,
        seller: listing.seller, availability: listing.availability, termsCheckedAt: checked, screen: undefined, match: undefined, mistakes: undefined };
}
