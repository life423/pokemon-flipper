import type { Evaluation, ListingSummary } from "./types.ts";
import { searchAttributes } from "./search-criteria.ts";

import { BEST_BUY_TERMS_MAX_AGE_MS } from "./search-diagnostic.ts";

export function currentQuote(checkedAt: string | undefined, now: number): boolean {
    const age = now - Date.parse(checkedAt ?? "");
    return age >= 0 && age < BEST_BUY_TERMS_MAX_AGE_MS;
}

export function purchaseNeedsRecheck(evaluation: Evaluation | null | undefined, now: number): boolean {
    const listing = evaluation?.listing;
    return Boolean(listing?.buyingOption === "FIXED_PRICE" && evaluation?.underwriting?.verdict.startsWith("BUY") &&
        (listing.availability !== "ACTIVE" || listing.shipping == null || evaluation.underwriting.shippingUnconfirmed ||
         Date.parse(listing.endTime ?? "") <= now || !currentQuote(listing.termsCheckedAt, now)));
}

// An explicit fresh evaluation carries server-checked terms. Do not put an older
// browser snapshot back over them. A later selected refresh still takes priority.
export function withFreshListing(current: ListingSummary, evaluation: Evaluation): ListingSummary {
    if (current.shippingDestination !== undefined && (current.shippingDestination ?? null) !== (evaluation.listing.shippingDestination ?? null)) return current;
    const checked = evaluation.listing.termsCheckedAt;
    if (!checked || !Number.isFinite(Date.parse(checked))) return current;
    if (current.termsCheckedAt && Date.parse(current.termsCheckedAt) > Date.parse(checked)) return current;
    const listing = evaluation.listing;
    return { ...current, title: listing.title, url: listing.url, currentPrice: listing.price, shipping: listing.shipping,
        shippingDestination: listing.shippingDestination,
        listedAt: listing.listedAt ?? current.listedAt, createdAt: listing.createdAt ?? current.createdAt,
        listedAttributes: searchAttributes(listing.title, listing.aspects),
        bids: listing.bids, endTime: listing.endTime, buyingOption: listing.buyingOption, bestOffer: listing.bestOffer ?? current.bestOffer, images: listing.photos ?? current.images,
        cardCondition: listing.cardCondition === undefined ? current.cardCondition : listing.cardCondition,
        conditionNotes: listing.conditionNotes ?? current.conditionNotes,
        seller: listing.seller, availability: listing.availability, termsCheckedAt: checked, screen: undefined, match: undefined, mistakes: undefined };
}
