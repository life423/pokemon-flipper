import { searchListings } from "../ebay/listings.ts";
import { isLot } from "../ebay/filters.ts";
import { mapLimit } from "../lib/concurrency.ts";
import { readSearch } from "../search/intent.ts";
import { titleMatches } from "../search/relevance.ts";
import { digQueries, type DigQuery } from "../search/dig.ts";
import { findCardInPhoto, describeWanted, type PhotoFind } from "../ai/photo-find.ts";
import { REAL_STEPS, screenListing, type ScreenSteps } from "./find-deals.ts";
import { CCG_INDIVIDUAL_CARDS } from "../ebay/listings.ts";
import type { FoundHow, ListingSummary, Screen, SearchIntent } from "../../shared/types.ts";

// Dig deeper: the listings a plain search misses, where the hidden deals
// are. Misspelled or vague titles, number-only titles, the wrong eBay
// category, and lots. The photo decides whether the card is there, then
// the usual free check (and, for candidates, the AI analysis) takes over.

// Photo checks per dig, so a broad search can't run up the AI bill.
const MAX_PHOTO_CHECKS = 120;
const PARALLEL_LISTINGS = 6;

export interface DigSummary {
    // Listings the extra searches turned up, and the searches run.
    total: number;
    queries: string[];
}

function unscreened(reason: string): Screen {
    return { status: "UNSCREENED", reason, card: null, bestCase: null, assumed: null };
}

// The free check's steps, with the card's name, set, and number taken from
// the photo where the title doesn't give them.
function photoSteps(seen: PhotoFind, intent: SearchIntent): ScreenSteps {
    return {
        ...REAL_STEPS,
        readTitle: async (listing) => {
            const read = await REAL_STEPS.readTitle(listing);
            const aspects = { ...read.aspects };

            // The photo confirmed it's the card searched for, whatever the title spells.
            if (intent.cardName) aspects["Card Name"] = intent.cardName;
            if (seen.set) aspects.Set ??= seen.set;
            if (seen.cardNumber) aspects["Card Number"] ??= seen.cardNumber;

            return { ...read, aspects };
        },
    };
}

async function digListing(
    listing: ListingSummary,
    how: FoundHow,
    intent: SearchIntent,
    photoBudget: { left: number }
): Promise<ListingSummary | null> {
    const lot = isLot(listing.title);
    const named = titleMatches(listing.title, intent);

    // Named and in the card category: the plain search already has it.
    if (!lot && named && listing.categoryId === CCG_INDIVIDUAL_CARDS) return null;

    // Named but listed in the wrong category: the usual free check.
    if (!lot && named) {
        const screened = await screenListing(listing, REAL_STEPS, intent);
        return { ...screened, found: { how: "WRONG_CATEGORY", note: "Listed outside eBay's trading card category." } };
    }

    // Everything else needs the photo to say whether the card is there.
    if (!listing.images[0] || photoBudget.left <= 0) return null;

    photoBudget.left -= 1;
    const seen = await findCardInPhoto(listing.images[0], intent, listing.title);

    if (seen?.found !== "YES") return null;

    // Several cards in the photo makes it a lot, whatever the title says.
    if (lot || seen.cardCount > 1) {
        // A random pick from a pictured pool isn't a lot you can buy.
        if (seen.sellsAll === "NO") return null;

        const check = seen.sellsAll === "YES" ? "" : " Make sure it sells every card pictured, not a random pick.";

        return {
            ...listing,
            found: { how: "LOT", note: seen.shows },
            screen: unscreened(
                `A lot that includes ${intent.cardName} (${seen.shows}).${check} Check the photos, and value the rest of the lot yourself.`
            ),
        };
    }

    const screened = await screenListing(listing, photoSteps(seen, intent), intent);
    const foundHow: FoundHow = how === "MISSPELLED" || how === "NUMBER_ONLY" ? how : "PHOTO_SHOWS_IT";

    return { ...screened, found: { how: foundHow, note: seen.shows } };
}

export async function digDeeper(
    search: string,
    {
        onStart = () => {},
        onListing = () => {},
        minPrice = 0,
    }: { onStart?: (summary: DigSummary) => void; onListing?: (listing: ListingSummary) => void; minPrice?: number } = {}
): Promise<void> {
    const intent = await readSearch(search);

    if (!intent.cardName) {
        throw new Error("Dig deeper needs a search for one card.");
    }

    const plan: DigQuery[] = await digQueries(search, intent);
    const found = new Map<string, { listing: ListingSummary; how: FoundHow }>();

    for (const query of plan) {
        const { listings } = await searchListings(query.query, {
            maxResults: 200,
            anyCategory: query.anyCategory,
            keepLots: query.keepLots,
        });

        for (const listing of listings) {
            if (!found.has(listing.id)) found.set(listing.id, { listing, how: query.how });
        }
    }

    const now = Date.now();
    const live = [...found.values()].filter(
        ({ listing }) =>
            (!listing.endTime || Date.parse(listing.endTime) > now) &&
            !(listing.buyingOption === "FIXED_PRICE" && (listing.currentPrice ?? 0) < minPrice)
    );

    onStart({ total: live.length, queries: plan.map((query) => query.query) });
    console.log(`Dig for ${describeWanted(intent)}: ${live.length} listings from ${plan.length} searches`);

    const photoBudget = { left: MAX_PHOTO_CHECKS };

    await mapLimit(live, PARALLEL_LISTINGS, async ({ listing, how }) => {
        const result = await digListing(listing, how, intent, photoBudget).catch((error: Error) => {
            console.error(`Dig failed for ${listing.id}: ${error.message}`);
            return null;
        });

        if (result) onListing(result);
    });
}
