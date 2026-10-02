import { detailRequestCount, getListingDetails, searchListings, type ListingDetails } from "../ebay/listings.ts";
import { lookupCards, fetchComps } from "../pricing/pkmnprices.ts";
import { mapLimit } from "../lib/concurrency.ts";
import { readSearch } from "../search/intent.ts";
import { cardMismatch, gradingMatches, isEnglish, setMatches, titleMatches } from "../search/relevance.ts";
import { fillFromTitle, readTitle } from "../ai/title-reader.ts";
import { checkComps } from "../ai/comp-checker.ts";
import { matchMainPhoto, type ClaimedCard, type PhotoMatch } from "../ai/photo-match.ts";
import { prescreen, type ScreenInput } from "./prescreen.ts";
import type { ListingSummary, Screen, SearchIntent } from "../../shared/types.ts";

// A search, the way eBay matches it, narrowed to the card searched for,
// with every listing screened for free. eBay limits listing-detail
// requests per day, so the first check runs on the search result alone,
// with its title read by the AI. Only listings that pass, or whose title
// left something out, get their full eBay details and a second check.
// Only candidates are worth the paid AI analysis.

// eBay returns 200 a page in best-match order; later pages are mostly loose
// matches, so 400 by default, and up to 1,000 when asked.
const DEFAULT_RESULTS = 400;
const MOST_RESULTS = 1000;
const PARALLEL_LISTINGS = 6;

export interface SearchSummary {
    // eBay's count for the search, and how many were fetched and kept.
    total: number;
    found: number;
    // The ones whose title names the card searched for.
    count: number;
    // Junk the free rules dropped before anything was spent.
    skipped: number;
    intent: SearchIntent;
}

// The steps a listing goes through, passed in so tests can supply their own.
export interface ScreenSteps {
    readTitle: typeof fillFromTitle;
    loadDetails: (itemId: string) => Promise<ListingDetails>;
    check: (input: ScreenInput) => Promise<Screen>;
    matchPhoto: (imageUrl: string, card: ClaimedCard) => Promise<PhotoMatch | null>;
}

export const REAL_STEPS: ScreenSteps = {
    readTitle: fillFromTitle,
    // Past the day's reserve, eBay refuses and the title's check stands.
    loadDetails: (itemId) => getListingDetails(itemId, { keepReserve: true }),
    check: (input) =>
        prescreen(input, { lookupCards, fetchComps, checkComps }).catch((error: Error) =>
            unscreened(`The free check failed: ${error.message}`)
        ),
    matchPhoto: matchMainPhoto,
};

function unscreened(reason: string): Screen {
    return { status: "UNSCREENED", reason, card: null, bestCase: null, assumed: null };
}

function withFilled(screen: Screen, filled: string[]): Screen {
    return filled.length > 0 ? { ...screen, filledFromTitle: filled } : screen;
}

export async function screenListing(
    listing: ListingSummary,
    steps: ScreenSteps = REAL_STEPS,
    intent: SearchIntent | null = null
): Promise<ListingSummary> {
    const base = {
        price: listing.currentPrice,
        shipping: listing.shipping,
        isGraded: listing.isGraded,
        buyingOption: listing.buyingOption,
    };

    // First from the search result alone: the title, read by the AI. The
    // condition is the one the title claims; with none, it's assumed best.
    const fromTitle = await steps.readTitle({ title: listing.title, aspects: {} });

    // Not a single card: a lot, sealed product, merch, a mystery pack, a
    // fake. Skipped before any price lookup or eBay request.
    if (fromTitle.kind && fromTitle.kind !== "SINGLE_CARD") {
        return { ...listing, match: "JUNK" };
    }

    if (!isEnglish(fromTitle.aspects.Language)) {
        return { ...listing, match: "OTHER_LANGUAGE" };
    }

    // The title names another set than the one searched: set aside before
    // any price lookup.
    if (intent && !setMatches(fromTitle.aspects.Set, intent)) {
        return { ...listing, match: "OTHER_SET" };
    }

    const first = withFilled(
        await steps.check({ ...base, title: listing.title, aspects: fromTitle.aspects, cardCondition: fromTitle.condition ?? null }),
        fromTitle.filled
    );

    // Priced too low to be the real card: junk, before any eBay request.
    if (first.junk) return { ...listing, match: "JUNK", screen: first };

    // A candidate's main photo, checked against the card it claims before any
    // eBay request or full analysis. Long-shot auctions aren't worth it.
    let seen: PhotoMatch | null = null;

    if (first.status === "CANDIDATE" && !first.longShot && first.card && listing.images[0]) {
        seen = await steps.matchPhoto(listing.images[0], first.card);

        if (seen?.verdict === "MISMATCH") {
            const reason = `The main photo doesn't match: ${seen.problems.join("; ") || "another card"}.`;
            return { ...listing, match: "OTHER_CARD", screen: { ...first, reason } };
        }
    }

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
            // The main photo's printing marks settle claims it clearly contradicts.
            photoMarks: seen ? { firstEditionStamp: seen.firstEditionStamp, artBoxShadow: seen.artBoxShadow } : undefined,
        }),
        filled
    );

    if (screen.junk) return { ...listing, match: "JUNK", screen };

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
        maxResults = DEFAULT_RESULTS,
        minPrice = 0,
        signal,
    }: {
        onStart?: (summary: SearchSummary) => void;
        onListing?: (listing: ListingSummary) => void;
        maxResults?: number;
        // Buy It Now listings under this are skipped; auctions aren't affected.
        minPrice?: number;
        // A stopped search: the listings not yet checked are skipped, so no
        // more eBay requests or AI calls go out.
        signal?: AbortSignal;
    } = {}
): Promise<ListingSummary[]> {
    const intent = await readSearch(search);
    const limit = Math.min(MOST_RESULTS, Math.max(200, Math.round(maxResults / 200) * 200));
    const { listings, total, skipped } = await searchListings(search, { maxResults: limit });
    const now = Date.now();
    const requestsBefore = detailRequestCount();

    const live = listings.filter((listing) => !listing.endTime || Date.parse(listing.endTime) > now);
    const matching = live.filter(
        (listing) =>
            titleMatches(listing.title, intent) &&
            gradingMatches(listing.isGraded, intent) &&
            !(listing.buyingOption === "FIXED_PRICE" && (listing.currentPrice ?? 0) < minPrice)
    );

    onStart({ total, found: live.length, count: matching.length, skipped, intent });

    // Every title queued for reading at once, so the AI gets full batches
    // of 25, but not waited on: each listing is checked as soon as its own
    // title comes back, so results start arriving within seconds.
    for (const listing of matching) void readTitle(listing.title);

    const results = await mapLimit(matching, PARALLEL_LISTINGS, async (listing) => {
        if (signal?.aborted) return null;

        const screened = await screenListing(listing, REAL_STEPS, intent);
        const mismatch = screened.match ?? cardMismatch(screened.screen, intent);
        const result = mismatch ? { ...screened, match: mismatch } : screened;

        onListing(result);

        return result;
    });

    console.log(
        `Search ${JSON.stringify(search)}: ${matching.length} listings checked with ${detailRequestCount() - requestsBefore} eBay detail requests`
    );

    return results.filter((result): result is ListingSummary => result !== null);
}
