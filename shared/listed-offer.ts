import { parseListingLink } from "./listing-link.ts";
import { acquisitionCost } from "./money/underwriting.ts";
import { MONEY_CONFIG } from "./money/config.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "./search-diagnostic.ts";
import type { ListingSummary } from "./types.ts";

// Compare seller quotes only. A known price does not establish market value.
export function lowestQuotedOffer(rows: readonly ListingSummary[], now: number, maxDelivered = Infinity) {
    let lowest: { listing: ListingSummary; total: number } | undefined;
    for (const listing of rows) {
        const { currentPrice: price, shipping, endTime } = listing;
        const age = now - Date.parse(listing.termsCheckedAt ?? "");
        if (listing.buyingOption !== "FIXED_PRICE" || listing.availability === "UNAVAILABLE" || (endTime && !(Date.parse(endTime) > now)) ||
            !Number.isFinite(age) || age < 0 || age >= BEST_BUY_TERMS_MAX_AGE_MS || listing.match || listing.screen?.junk ||
            listing.researchIdentity || listing.researchKind || (listing.screen?.needsAnalysis && listing.screen.needsAnalysis !== "PRICE_EVIDENCE") ||
            !listing.images.length || !parseListingLink(listing.url) ||
            price == null || !Number.isFinite(price) || price <= 0 || shipping == null || !Number.isFinite(shipping) || shipping < 0) continue;
        const total = acquisitionCost(price, shipping, MONEY_CONFIG.buying);
        if (total <= maxDelivered && (!lowest || total < lowest.total || total === lowest.total && listing.id < lowest.listing.id)) {
            lowest = { listing, total };
        }
    }
    return lowest;
}
