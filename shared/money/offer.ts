import { dollars, percent } from "../format.ts";
import { pathNumbers } from "./underwriting.ts";
import { MONEY_CONFIG } from "./config.ts";
import { MAX_OFFER_DISCOUNT_PERCENT, minimumOfferPrice } from "./cents.ts";
import type { PricedPath } from "../types.ts";

// What to offer on a Buy It Now that accepts Best Offer. The max price
// (the most that still clears your targets) is where you walk away.

// Opening offer on a listing that's already a deal at its asking price.
const OPENING_DISCOUNT = 0.1;

export interface OfferPlan {
    // What to offer, rounded to a number that reads as deliberate.
    offer: number;
    // The most worth paying: above this, it no longer clears your targets.
    walkAway: number;
    // Paying the full asking price would still clear your targets.
    clearsAtAsking: boolean;
    // The purchase limit falls outside the offer discovery range.
    requiresPriceDrop: boolean;
}

// $125, not $127.50: whole steps that grow with the price.
export function roundOffer(amount: number): number {
    const step = amount < 200 ? 5 : amount < 1000 ? 10 : 25;

    return Math.floor(amount / step) * step;
}

export function offerPlan(asking: number, maxPrice: number): OfferPlan | null {
    if (!Number.isFinite(asking) || !Number.isFinite(maxPrice) || maxPrice <= 0 || asking <= 0) return null;

    const walkAway = Math.floor((maxPrice + 1e-9) * 100) / 100;
    const minimumOffer = minimumOfferPrice(asking);
    if (!Number.isFinite(minimumOffer) || walkAway <= 0) return null;
    const clearsAtAsking = asking <= walkAway;
    const requiresPriceDrop = walkAway < minimumOffer;
    // A whole-dollar opening is easy to submit. Use the cent-level floor
    // when rounding up would exceed the purchase limit or lose the discount.
    const roundedOpening = Math.ceil(minimumOffer);
    const offer = clearsAtAsking ? Math.max(minimumOffer, roundOffer(asking * (1 - OPENING_DISCOUNT)))
        : requiresPriceDrop ? walkAway
        : roundedOpening <= walkAway && roundedOpening < asking ? roundedOpening : minimumOffer;

    return offer < asking ? { offer, walkAway, clearsAtAsking, requiresPriceDrop } : null;
}

// One plain sentence for the page.
export function describeOffer(plan: OfferPlan, asking: number): string {
    const under = percent(1 - plan.offer / asking);

    if (plan.clearsAtAsking) {
        return `It's already a deal at ${dollars(asking)}. Open at ${dollars(plan.offer)} (${under} under) to keep more; paying the full price still clears your targets.`;
    }

    const base = `Offer ${dollars(plan.offer)}, ${under} under asking, within your price limit.`;

    return plan.requiresPriceDrop
        ? `Your limit is ${dollars(plan.walkAway)}, ${under} below asking. That is outside the ${MAX_OFFER_DISCOUNT_PERCENT}% offer range. Wait for a price drop.`
        : `${base} The seller would need to accept it.`;
}

export function numbersAtOffer(path: PricedPath, plan: OfferPlan) {
    const { profit, roi } = pathNumbers({
        expectedNet: path.expectedNet,
        downsideNet: path.downside === null ? null : path.downside + path.cost,
        fixedCosts: path.fixedCosts,
        shipping: path.shipping,
        price: plan.offer,
    }, MONEY_CONFIG);
    return { profit, roi };
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
    return plan !== null && !plan.clearsAtAsking && !plan.requiresPriceDrop;
}
