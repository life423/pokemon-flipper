import { getListings, getListingDetails } from "../ebay/listings.js";
import { lookupCards, fetchComps } from "../pricing/pkmnprices.js";
import { mapLimit } from "../lib/concurrency.ts";
import { prescreen } from "./prescreen.ts";
import type { ListingSummary, Screen } from "../../shared/types.ts";

// A search, with every listing screened for free: its item details
// from eBay, its card from the price database, and what it's worth at
// its best. Only candidates are worth the paid AI analysis.

const DETAILS_TTL_MS = 10 * 60 * 1000;
const PARALLEL_LISTINGS = 6;

type Details = Awaited<ReturnType<typeof getListingDetails>>;

const detailsCache = new Map<string, { details: Details; at: number }>();

async function cachedDetails(itemId: string): Promise<Details> {
    const hit = detailsCache.get(itemId);

    if (hit && Date.now() - hit.at < DETAILS_TTL_MS) return hit.details;

    const details = await getListingDetails(itemId);
    detailsCache.set(itemId, { details, at: Date.now() });

    return details;
}

function unscreened(reason: string): Screen {
    return { status: "UNSCREENED", reason, card: null, bestCase: null, assumed: null };
}

async function screenListing(listing: ListingSummary): Promise<ListingSummary> {
    let details: Details;

    try {
        details = await cachedDetails(listing.id);
    } catch (error) {
        return { ...listing, screen: unscreened(`The listing's details didn't load: ${(error as Error).message}`) };
    }

    const screen = await prescreen(
        {
            title: details.title,
            aspects: details.aspects,
            // The search's price is the freshest.
            price: listing.currentPrice,
            shipping: listing.shipping ?? details.shipping,
            isGraded: listing.isGraded,
            cardCondition: details.cardCondition,
        },
        { lookupCards, fetchComps }
    ).catch((error: Error) => unscreened(`The free check failed: ${error.message}`));

    return {
        ...listing,
        seller: details.seller ?? listing.seller,
        cardCondition: details.cardCondition,
        conditionNotes: details.conditionNotes,
        screen,
    };
}

// onStart(count) runs once the search is in, and onListing(listing) as
// each listing is screened, so a slow first search can show progress.
export async function findDeals(
    search: string,
    {
        onStart = () => {},
        onListing = () => {},
    }: { onStart?: (count: number) => void; onListing?: (listing: ListingSummary) => void } = {}
): Promise<ListingSummary[]> {
    const now = Date.now();
    const listings = ((await getListings(search)) as ListingSummary[]).filter(
        (listing) => !listing.endTime || Date.parse(listing.endTime) > now
    );

    onStart(listings.length);

    return mapLimit(listings, PARALLEL_LISTINGS, async (listing) => {
        const screened = await screenListing(listing);
        onListing(screened);

        return screened;
    });
}
