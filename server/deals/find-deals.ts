import { getListingDetails, searchListings, type ListingDetails } from "../ebay/listings.ts";
import { lookupCards, fetchComps } from "../pricing/pkmnprices.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { mapLimit } from "../lib/concurrency.ts";
import { readSearch } from "../search/intent.ts";
import { cardMismatch, gradingMatches, isEnglish, titleMatches } from "../search/relevance.ts";
import { fillFromTitle, readTitle } from "../ai/title-reader.ts";
import { checkComps } from "../ai/comp-checker.ts";
import { prescreen, type ScreenInput } from "./prescreen.ts";
import type { ListingSummary, Screen, SearchIntent } from "../../shared/types.ts";

// A search, the way eBay matches it, narrowed to the card searched for,
// with every listing screened for free. eBay limits listing-detail
// requests per day, so the first check runs on the search result alone,
// with its title read by the AI. Only listings that pass, or whose title
// left something out, get their full eBay details and a second check.
// Only candidates are worth the paid AI analysis.

// eBay returns 200 a page; past this many, results are mostly loose matches.
const MAX_RESULTS = 1000;
const PARALLEL_LISTINGS = 6;

// Item details hardly change, so they're saved for a day. Prices come
// from the search, which is fresh.
const DETAILS_MAX_AGE_HOURS = 24;

export interface SearchSummary {
    // eBay's count for the search, and how many were fetched and kept.
    total: number;
    found: number;
    // The ones whose title names the card searched for.
    count: number;
    intent: SearchIntent;
}

// The steps a listing goes through, passed in so tests can supply their own.
export interface ScreenSteps {
    readTitle: typeof fillFromTitle;
    loadDetails: (itemId: string) => Promise<ListingDetails>;
    check: (input: ScreenInput) => Promise<Screen>;
}

// How many detail requests this server has sent to eBay, for the log.
let detailRequests = 0;

async function cachedDetails(itemId: string): Promise<ListingDetails> {
    const key = `ebay:item:${itemId}`;
    const saved = await readCache<ListingDetails>(key, DETAILS_MAX_AGE_HOURS);

    if (saved) return saved;

    detailRequests += 1;
    const details = await getListingDetails(itemId);
    await writeCache(key, details);

    return details;
}

const REAL_STEPS: ScreenSteps = {
    readTitle: fillFromTitle,
    loadDetails: cachedDetails,
    check: (input) =>
        prescreen(input, { lookupCards, fetchComps, checkComps }).catch((error: Error) =>
            unscreened(`The free check failed: ${error.message}`)
        ),
};

function unscreened(reason: string): Screen {
    return { status: "UNSCREENED", reason, card: null, bestCase: null, assumed: null };
}

function withFilled(screen: Screen, filled: string[]): Screen {
    return filled.length > 0 ? { ...screen, filledFromTitle: filled } : screen;
}

export async function screenListing(listing: ListingSummary, steps: ScreenSteps = REAL_STEPS): Promise<ListingSummary> {
    const base = {
        price: listing.currentPrice,
        shipping: listing.shipping,
        isGraded: listing.isGraded,
        buyingOption: listing.buyingOption,
    };

    // First from the search result alone: the title, read by the AI. The
    // condition is the one the title claims; with none, it's assumed best.
    const fromTitle = await steps.readTitle({ title: listing.title, aspects: {} });

    if (!isEnglish(fromTitle.aspects.Language)) {
        return { ...listing, match: "OTHER_LANGUAGE" };
    }

    const first = withFilled(
        await steps.check({ ...base, title: listing.title, aspects: fromTitle.aspects, cardCondition: fromTitle.condition ?? null }),
        fromTitle.filled
    );

    // Dropped on its title alone: no eBay detail request.
    if (first.status !== "CANDIDATE" && !first.incomplete) {
        return { ...listing, screen: first };
    }

    let details: ListingDetails;

    try {
        details = await steps.loadDetails(listing.id);
    } catch {
        // Out of eBay requests, or the listing is gone: the title's check stands.
        return { ...listing, screen: first };
    }

    // Then with the listing's own details; the title only fills gaps.
    const { aspects, filled } = await steps.readTitle(details);

    if (!isEnglish(aspects.Language)) {
        return { ...listing, match: "OTHER_LANGUAGE" };
    }

    const screen = withFilled(
        await steps.check({
            ...base,
            title: details.title,
            aspects,
            shipping: listing.shipping ?? details.shipping,
            cardCondition: details.cardCondition,
        }),
        filled
    );

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
// progress. A listing that turns out to be another set, card, printing,
// or language is still sent, marked with why it doesn't match.
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
    const requestsBefore = detailRequests;

    const live = listings.filter((listing) => !listing.endTime || Date.parse(listing.endTime) > now);
    const matching = live.filter(
        (listing) => titleMatches(listing.title, intent) && gradingMatches(listing.isGraded, intent)
    );

    onStart({ total, found: live.length, count: matching.length, intent });

    // Every title read up front, so the AI gets full batches of 25 instead
    // of the few that happen to be in flight. Each reading is saved.
    await Promise.all(matching.map((listing) => readTitle(listing.title)));

    const results = await mapLimit(matching, PARALLEL_LISTINGS, async (listing) => {
        const screened = await screenListing(listing);
        const mismatch = screened.match ?? cardMismatch(screened.screen, intent);
        const result = mismatch ? { ...screened, match: mismatch } : screened;

        onListing(result);

        return result;
    });

    console.log(
        `Search ${JSON.stringify(search)}: ${matching.length} listings checked with ${detailRequests - requestsBefore} eBay detail requests`
    );

    return results;
}
