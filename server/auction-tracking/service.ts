import { createAuctionTracker } from "./tracker.ts";
import { withAiUsageContext } from "../ai/usage-context.ts";
import { getListingDetails } from "../ebay/listings.ts";
import { EbayError } from "../ebay/api.ts";
import { fetchComps, fetchRawComps } from "../pricing/pkmnprices.ts";
import { withPriceResearchSignal } from "../pricing/research-budget.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import type { Comp } from "../pricing/types.ts";

export const auctionTracker = createAuctionTracker({
    details: (id, searchId, signal) => withAiUsageContext({ searchId, listingId: id }, async () => {
        try { return await getListingDetails(id, { maxAgeHours: 1 / 60, keepReserve: true, signal }); }
        catch (error) {
            if (error instanceof EbayError && [404, 410].includes(error.status)) return null;
            throw error;
        }
    }),
    sales: (market, searchId, listingId, end, signal) => withAiUsageContext({ searchId, listingId }, () =>
        withPriceResearchSignal(signal, () => {
            const stopWhen = (sales: readonly Comp[]) => sales.some(s => parseListingLink(s.listing_url)?.itemId === listingId ||
                Date.parse(s.sold_at) < Date.parse(end) - 2 * 86_400_000);
            return market.grader && market.grade != null
                ? fetchComps(market.recordId, { variant: market.variant, grader: market.grader, grade: market.grade, stopWhen })
                : fetchRawComps(market.recordId, market.variant, { stopWhen });
        })),
});
