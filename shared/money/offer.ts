import { dollars, percent } from "../format.ts";

// What to offer on a Buy It Now that accepts Best Offer. The max price
// (the most that still clears your targets) is where you walk away.

// Opening offer on a listing that's already a deal at its asking price.
const OPENING_DISCOUNT = 0.15;

// Sellers rarely take more than this far below their asking price.
const LONG_SHOT_DISCOUNT = 0.4;

export interface OfferPlan {
    // What to offer, rounded to a number that reads as deliberate.
    offer: number;
    // The most worth paying: above this, it no longer clears your targets.
    walkAway: number;
    // Paying the full asking price would still clear your targets.
    clearsAtAsking: boolean;
    // More than 40% under asking: a seller is unlikely to take it.
    longShot: boolean;
}

// $125, not $127.50: whole steps that grow with the price.
export function roundOffer(amount: number): number {
    const step = amount < 200 ? 5 : amount < 1000 ? 10 : 25;

    return Math.floor(amount / step) * step;
}

export function offerPlan(asking: number, maxPrice: number): OfferPlan | null {
    if (maxPrice <= 0 || asking <= 0) return null;

    const clearsAtAsking = asking <= maxPrice;
    const offer = roundOffer(clearsAtAsking ? asking * (1 - OPENING_DISCOUNT) : maxPrice);

    if (offer <= 0) return null;

    return {
        offer,
        walkAway: Math.floor(maxPrice),
        clearsAtAsking,
        longShot: offer < asking * (1 - LONG_SHOT_DISCOUNT),
    };
}

// One plain sentence for the page.
export function describeOffer(plan: OfferPlan, asking: number): string {
    const under = percent(1 - plan.offer / asking);

    if (plan.clearsAtAsking) {
        return `It's already a deal at ${dollars(asking)}. Open at ${dollars(plan.offer)} (${under} under) to keep more; paying the full price still clears your targets.`;
    }

    const base = `Offer ${dollars(plan.offer)}, ${under} under asking: the most that still clears your targets.`;

    return plan.longShot ? `${base} Sellers rarely take that much off, so it's a long shot.` : base;
}

// The plan for a listing, when it's a Buy It Now that takes offers and its
// max price is known.
export function offerFor(
    listing: { buyingOption: string; bestOffer?: boolean; currentPrice: number | null },
    maxPrice: number | null | undefined
): OfferPlan | null {
    if (listing.buyingOption !== "FIXED_PRICE" || !listing.bestOffer || listing.currentPrice === null || !maxPrice) {
        return null;
    }

    return offerPlan(listing.currentPrice, maxPrice);
}

// A listing that doesn't clear at its asking price, but would at a
// realistic offer.
export function offerWorthMaking(plan: OfferPlan | null): plan is OfferPlan {
    return plan !== null && !plan.clearsAtAsking && !plan.longShot;
}
