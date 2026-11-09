import { autoAnalysisBlockReason, type AutoAnalysisBlockReason } from "../../../shared/analysis.ts";
import { englishListingEligible } from "../../../shared/card-language.ts";
import { listingFilterBlock, AUTOMATIC_AUCTION_WINDOW_HOURS, type ListingFilters } from "../../../shared/listing-filters.ts";
import type { Evaluation, ListingSummary } from "../types";
import { name } from "../format";

type ListingBlock = AutoAnalysisBlockReason | NonNullable<ReturnType<typeof listingFilterBlock>> | "OTHER_LANGUAGE" | "ALREADY_SEEN";

export function automaticListingBlock(listing: ListingSummary, filters: ListingFilters, evaluation: Evaluation | undefined,
    requestedGraded: boolean | null | undefined, newIds: ReadonlySet<string> | null, now?: number): ListingBlock | null {
    if (!englishListingEligible(listing, evaluation)) return "OTHER_LANGUAGE";
    const filterBlock = listingFilterBlock(listing, filters, evaluation, requestedGraded);
    if (filterBlock) return filterBlock;
    if (newIds && !newIds.has(listing.id)) return "ALREADY_SEEN";
    return autoAnalysisBlockReason(listing, now);
}

export function describeListingBlock(listing: ListingSummary, block: ListingBlock) {
    switch (block) {
        case "OTHER_LANGUAGE": return { label: "Non-English card" };
        case "LISTING_FORMAT": return { label: "Different listing format" };
        case "CARD_TYPE": return { label: "Outside the raw or graded selection" };
        case "ABOVE_MAX_PRICE": return { label: "Above your maximum purchase price" };
        case "BELOW_MIN_PRICE": return { label: "Below your minimum Buy It Now price" };
        case "ALREADY_SEEN": return { label: "Outside this newest-listing scan" };
        case "OUTSIDE_AUCTION_WINDOW": return { label: `Outside the ${AUTOMATIC_AUCTION_WINDOW_HOURS}-hour auction window` };
        case "NO_IMAGES": return { label: "No listing photos" };
        case "UNAVAILABLE": return { label: "Listing unavailable" };
        case "JUNK": return { label: "Screened out as unrelated" };
        case "UNSUPPORTED_TEXTURE": return { label: "Unsupported card treatment" };
        case "INVALID_PRICE": return { label: "No usable listing price" };
        case "PRICE_ABOVE_CEILING": return { label: "Above the automatic research price ceiling" };
        case "PRICING_CONFIG": return { label: "Pricing provider setup required" };
        case "PRICING_CREDITS": return { label: "Pricing provider credits unavailable" };
        case "SCREEN_DROPPED": return { label: "Above target in price screening", detail: listing.screen?.reason };
        case "SOLD_EVIDENCE_MISSING": return {
            label: listing.screen?.soldEvidence?.exactScope ? "No matching sold-price evidence" : "Exact sold market unconfirmed",
            detail: listing.screen?.soldEvidence?.note,
        };
        case "SOLD_EVIDENCE_DEFERRED": return { label: "Sold-price lookup deferred", detail: listing.screen?.soldEvidence?.note };
        case "CRITERIA_MISMATCH": return { label: listing.match === "UNCONFIRMED_CRITERIA" ? "Search criteria unconfirmed" : name(listing.match) };
        case "NO_ANALYSIS_CANDIDATE": return { label: "Preliminary screening did not qualify this listing", detail: listing.screen?.reason };
    }
}
