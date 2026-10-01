import { getListings, getListingDetails } from "./ebay.js";
import { lookupCards, fetchComps } from "./pkmnprices.js";
import { prescreen } from "./prescreen.js";

// A search, with every listing screened for free: its item details
// from eBay, its card from the price database, and what it's worth at
// its best. Only candidates are worth the paid AI analysis.

const DETAILS_TTL_MS = 10 * 60 * 1000;
const PARALLEL_LISTINGS = 6;

const detailsCache = new Map();

async function cachedDetails(itemId) {
    const hit = detailsCache.get(itemId);

    if (hit && Date.now() - hit.at < DETAILS_TTL_MS) {
        return hit.details;
    }

    const details = await getListingDetails(itemId);
    detailsCache.set(itemId, { details, at: Date.now() });

    return details;
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;

    async function worker() {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

    return results;
}

function unscreened(reason) {
    return { status: "UNSCREENED", reason, card: null, bestCase: null, assumed: null };
}

// onStart(count) runs once the search is in, and onListing(listing) as
// each listing is screened, so a slow first search can show progress.
export async function findDeals(search, { onStart = () => {}, onListing = () => {} } = {}) {
    const now = Date.now();
    const listings = (await getListings(search)).filter(
        (listing) => !listing.endTime || Date.parse(listing.endTime) > now
    );

    onStart(listings.length);

    return mapLimit(listings, PARALLEL_LISTINGS, async (listing) => {
        const screened = await screenListing(listing);
        onListing(screened);

        return screened;
    });
}

async function screenListing(listing) {
    let details;

    try {
        details = await cachedDetails(listing.id);
    } catch (error) {
        return { ...listing, screen: unscreened(`The listing's details didn't load: ${error.message}`) };
    }

    const result = await prescreen(
        {
            ...details,
            // The search's price is the freshest.
            price: listing.currentPrice,
            shipping: listing.shipping ?? details.shipping,
            isGraded: listing.isGraded,
        },
        { lookupCards, fetchComps }
    ).catch((error) => unscreened(`The free check failed: ${error.message}`));

    return {
        ...listing,
        seller: details.seller ?? listing.seller,
        cardCondition: details.cardCondition,
        conditionNotes: details.conditionNotes,
        screen: result,
    };
}
