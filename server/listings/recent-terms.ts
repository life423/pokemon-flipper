import type { ListingSummary } from "../../shared/types.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import type { CurrentState } from "../analysis/types.ts";

// Short-lived server observations. An eviction or restart falls back to the eBay detail reader.
export function createRecentListingTerms(now = Date.now) {
    const receipts = new Map<string, CurrentState>();
    const key = (owner: string, id: string, zip: string | null) => JSON.stringify([owner, id, zip]);
    return {
        remember(owner: string | undefined, listing: ListingSummary) {
            if (!owner) return;
            const at = Date.parse(listing.termsCheckedAt ?? "");
            const age = now() - at;
            if (!(age >= 0 && age < BEST_BUY_TERMS_MAX_AGE_MS)) return;
            const id = key(owner, listing.id, listing.shippingDestination ?? null);
            const prior = receipts.get(id);
            if (prior && Date.parse(prior.termsCheckedAt!) > at) return;
            receipts.delete(id);
            receipts.set(id, { title: listing.title, images: listing.images, price: listing.currentPrice,
                shipping: listing.shipping, shippingDestination: listing.shippingDestination, bids: listing.bids,
                endTime: listing.endTime, termsCheckedAt: listing.termsCheckedAt, buyingOption: listing.buyingOption, bestOffer: listing.bestOffer });
            if (receipts.size > 2000) receipts.delete(receipts.keys().next().value!);
        },
        read(owner: string | undefined, listingId: string, zip: string | null) {
            if (!owner) return null;
            const receipt = receipts.get(key(owner, listingId, zip));
            const age = now() - Date.parse(receipt?.termsCheckedAt ?? "");
            return receipt && age >= 0 && age < BEST_BUY_TERMS_MAX_AGE_MS ? receipt : null;
        },
    };
}
export const recentListingTerms = createRecentListingTerms();
