import { parseListingLink } from "../../shared/listing-link.ts";
import type { ListingSummary } from "../../shared/types.ts";
import { exclusionReason } from "../ebay/filters.ts";
import { getListingDetails } from "../ebay/listings.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import { searchAttributes } from "../../shared/search-criteria.ts";

export class ListingLinkError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}
export function createListingResolver({ details = getListingDetails, now = () => Date.now() } = {}) {
    return async (input: unknown, signal?: AbortSignal, comparison = false): Promise<ListingSummary> => {
        signal?.throwIfAborted();
        const parsed = parseListingLink(input);
        if (!parsed) throw new ListingLinkError("Paste a full ebay.com/itm/ listing link or its item number.");
        if (!parsed.itemId.endsWith("|0")) throw new ListingLinkError("Pick-your-card variations are not supported. Use a single-card listing.", 422);
        const listing = await details(parsed.itemId, { maxAgeHours: comparison ? BEST_BUY_TERMS_MAX_AGE_MS / 3_600_000 : 0, keepReserve: comparison, signal });
        signal?.throwIfAborted();
        const excluded = exclusionReason({ title: listing.title, itemId: listing.id, itemGroupType: listing.itemGroupType });
        if (excluded) throw new ListingLinkError(`${excluded}. This app evaluates individual collectible cards. No AI analysis was started.`, 422);
        if (listing.availability === "UNAVAILABLE" || listing.endTime && Date.parse(listing.endTime) <= now()) throw new ListingLinkError("This listing is unavailable or ended. No AI analysis was started.", 410);
        if (!listing.images.length) throw new ListingLinkError("This listing has no photos to assess. No AI analysis was started.", 422);
        return { id: listing.id, title: listing.title, url: parsed.url, images: listing.images, currentPrice: listing.price,
            listedAttributes: searchAttributes(listing.title, listing.aspects),
            shipping: listing.shipping, shippingDestination: listing.shippingDestination, bids: listing.bids, buyingOption: listing.buyingOption, endTime: listing.endTime,
            seller: listing.seller, bestOffer: listing.bestOffer, availability: listing.availability ?? "UNKNOWN",
            termsCheckedAt: listing.retrievedAt ?? new Date(now()).toISOString(),
            listedAt: listing.listedAt, createdAt: listing.createdAt,
            isGraded: /graded/i.test(listing.condition ?? "") && !/ungraded/i.test(listing.condition ?? "") || Boolean(listing.aspects["Professional Grader"]),
            cardCondition: listing.cardCondition, conditionNotes: listing.conditionNotes };
    };
}
export const resolveListingLink = createListingResolver();
