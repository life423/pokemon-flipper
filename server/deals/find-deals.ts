import { getListingDetails, searchListings, type ListingDetails } from "../ebay/listings.ts";
import { lookupCards, fetchComps } from "../pricing/pkmnprices.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { mapLimit } from "../lib/concurrency.ts";
import { readSearch } from "../search/intent.ts";
import { cardMismatch, gradingMatches, isEnglish, titleMatches } from "../search/relevance.ts";
import { prescreen } from "./prescreen.ts";
import { fillFromTitle } from "../ai/title-reader.ts";
import { checkComps } from "../ai/comp-checker.ts";
import type { ListingSummary, Screen, SearchIntent } from "../../shared/types.ts";

// A search, the way eBay matches it, narrowed to the card searched for,
// with every listing screened for free: its item details from eBay, its
// card from the price database, and what it's worth at its best. Only
// candidates are worth the paid AI analysis.

// eBay returns 200 a page; past this many, results are mostly loose matches.
const MAX_RESULTS = 1000;
const PARALLEL_LISTINGS = 6;

// Item details hardly change, and eBay limits detail requests per day,
// so they're saved for a day. Prices come from the search, which is fresh.
const DETAILS_MAX_AGE_HOURS = 24;

export interface SearchSummary {
    // eBay's count for the search, and how many were fetched and kept.
    total: number;
    found: number;
    // The ones whose title names the card searched for.
    count: number;
    intent: SearchIntent;
}

async function cachedDetails(itemId: string): Promise<ListingDetails> {
    const key = `ebay:item:${itemId}`;
    const saved = await readCache<ListingDetails>(key, DETAILS_MAX_AGE_HOURS);

    if (saved) return saved;

    const details = await getListingDetails(itemId);
    await writeCache(key, details);

    return details;
}

function unscreened(reason: string): Screen {
    return { status: "UNSCREENED", reason, card: null, bestCase: null, assumed: null };
}

async function screenListing(listing: ListingSummary): Promise<ListingSummary> {
    let details: ListingDetails;

    try {
        details = await cachedDetails(listing.id);
    } catch (error) {
        return { ...listing, screen: unscreened(`The listing's details didn't load: ${(error as Error).message}`) };
    }

    const { aspects, filled } = await fillFromTitle(details);

    // Only English cards are priced; others are set aside, not checked.
    if (!isEnglish(aspects.Language)) {
        return { ...listing, match: "OTHER_LANGUAGE" };
    }

    const checked = await prescreen(
        {
            title: details.title,
            aspects,
            // The search's price is the freshest.
            price: listing.currentPrice,
            shipping: listing.shipping ?? details.shipping,
            isGraded: listing.isGraded,
            cardCondition: details.cardCondition,
        },
        { lookupCards, fetchComps, checkComps }
    ).catch((error: Error) => unscreened(`The free check failed: ${error.message}`));
    const screen = filled.length > 0 ? { ...checked, filledFromTitle: filled } : checked;

    return {
        ...listing,
        seller: details.seller ?? listing.seller,
        cardCondition: details.cardCondition,
        conditionNotes: details.conditionNotes,
        screen,
    };
}

// onStart runs once the search is read and eBay has answered, and
// onListing as each listing is screened, so a slow first search can show
// progress. A listing that turns out to be another set, card, or
// printing is still sent, marked with why it doesn't match.
export async function findDeals(
    search: string,
    {
        onStart = () => {},
        onListing = () => {},
    }: { onStart?: (summary: SearchSummary) => void; onListing?: (listing: ListingSummary) => void } = {}
): Promise<ListingSummary[]> {
    const intent = await readSearch(search);
    const { listings, total } = await searchListings(search, { maxResults: MAX_RESULTS });
    const now = Date.now();

    const live = listings.filter((listing) => !listing.endTime || Date.parse(listing.endTime) > now);
    const matching = live.filter(
        (listing) => titleMatches(listing.title, intent) && gradingMatches(listing.isGraded, intent)
    );

    onStart({ total, found: live.length, count: matching.length, intent });

    return mapLimit(matching, PARALLEL_LISTINGS, async (listing) => {
        const screened = await screenListing(listing);
        const mismatch = screened.match ?? cardMismatch(screened.screen, intent);
        const result = mismatch ? { ...screened, match: mismatch } : screened;

        onListing(result);

        return result;
    });
}
