import { searchListings, CCG_INDIVIDUAL_CARDS } from "../ebay/listings.ts";
import { mapLimit } from "../lib/concurrency.ts";
import { readSearch } from "../search/intent.ts";
import { cardMismatch, gradingMatches } from "../search/relevance.ts";
import { digQueries, type DigQuery } from "../search/dig.ts";
import { findCardInPhoto, describeWanted, type PhotoFind } from "../ai/photo-find.ts";
import { screeningSteps, screenListing, type ScreenSteps } from "./find-deals.ts";
import { sellerMistakes } from "./seller-mistakes.ts";
import { analysisConcurrency } from "../../shared/analysis.ts";
import type { FoundHow, ListingSummary, SearchIntent, Targets } from "../../shared/types.ts";

// Dig deeper: single cards a plain search misses, where the hidden deals
// are: misspelled or vague titles, number-only titles, and the wrong eBay
// category. The photo decides whether the card is there, then the usual
// free check (and, for candidates, the AI analysis) takes over. Lots are
// never shown.

// Photo checks per dig, so a broad search can't run up the AI bill.
const MAX_PHOTO_CHECKS = 120;

export interface DigSummary {
    // Listings the extra searches turned up, and the searches run.
    total: number;
    queries: string[];
}

interface DigSteps {
    search: typeof searchListings;
    plan: typeof digQueries;
    readIntent: typeof readSearch;
    findPhoto: typeof findCardInPhoto;
    screening: typeof screeningSteps;
}

// The free check's steps, with the card's name from the search (the photo
// confirmed it) and its set and number from the photo where the title
// doesn't give them.
function photoSteps(seen: PhotoFind, intent: SearchIntent, steps: ScreenSteps): ScreenSteps {
    return {
        ...steps,
        readTitle: async (listing) => {
            const read = await steps.readTitle(listing);
            const aspects = { ...read.aspects };

            if (seen.inspection?.card.name ?? intent.cardName) aspects["Card Name"] = (seen.inspection?.card.name ?? intent.cardName)!;
            if (seen.set) aspects.Set = seen.set;
            if (seen.cardNumber) aspects["Card Number"] = seen.cardNumber;

            return { ...read, aspects };
        },
        check: (input) => steps.check({ ...input,
            title: [seen.inspection?.card.name ?? intent.cardName, seen.set, seen.cardNumber].filter(Boolean).join(" "),
            photoMarks: seen.inspection?.printingMarks ?? input.photoMarks,
        }),
    };
}

async function digListing(
    listing: ListingSummary,
    how: FoundHow,
    intent: SearchIntent,
    photoBudget: { left: number },
    steps: ScreenSteps,
    signal: AbortSignal | undefined,
    findPhoto: typeof findCardInPhoto
): Promise<ListingSummary | null> {
    signal?.throwIfAborted();
    const recheck = listing.match || listing.screen;

    // A title that doesn't name the card: the photo has to show it.
    if (!listing.images[0] || photoBudget.left <= 0) return null;

    photoBudget.left -= 1;
    const seen = await findPhoto(listing.images[0], intent, signal);
    signal?.throwIfAborted();

    // Only a single card, plainly the one searched for. Several cards is a lot.
    if (seen?.found !== "YES" || seen.cardCount > 1) return null;
    const claimed = await steps.readTitle({ title: listing.title, aspects: {} });
    signal?.throwIfAborted();
    const mistakes = seen.inspection ? sellerMistakes(listing, seen.inspection, claimed.aspects) : [];
    if (recheck && mistakes.length === 0) return null;
    const screened = await screenListing({ ...listing, match: undefined }, photoSteps(seen, intent, steps), intent, signal);
    const foundHow: FoundHow = how === "MISSPELLED" || how === "NUMBER_ONLY" ? how
        : listing.categoryId !== CCG_INDIVIDUAL_CARDS ? "WRONG_CATEGORY" : "PHOTO_SHOWS_IT";

    const supported = mistakes.filter((mistake) => mistake.kind !== "HOLO" || !screened.screen?.card?.availableFinishes?.length || screened.screen.card.availableFinishes.includes("HOLO"));
    if (recheck && supported.length === 0) return null;
    return { ...screened, mistakes: supported, found: { how: foundHow, note: seen.shows } };
}

export async function digDeeper(
    search: string,
    {
        onStart = () => {},
        onListing = () => {},
        minPrice = 0,
        targets,
        includeOffers = false,
        signal,
        intent: knownIntent,
        excludeIds = [],
        primaryListings = [],
        onProgress = () => {},
    }: { onStart?: (summary: DigSummary) => void; onListing?: (listing: ListingSummary) => void; minPrice?: number; targets?: Targets; includeOffers?: boolean; signal?: AbortSignal; intent?: SearchIntent; excludeIds?: string[]; primaryListings?: ListingSummary[]; onProgress?: (checked: number, total: number) => void } = {},
    dependencies: DigSteps = { search: searchListings, plan: digQueries, readIntent: readSearch, findPhoto: findCardInPhoto, screening: screeningSteps }
): Promise<void> {
    signal?.throwIfAborted();
    const intent = knownIntent ?? await dependencies.readIntent(search);
    signal?.throwIfAborted();

    const plan: DigQuery[] = await dependencies.plan(search, intent);
    const found = new Map<string, { listing: ListingSummary; how: FoundHow; lane: number }>();
    const excluded = new Set(excludeIds);
    // Seller claims can hide the value, so also inspect a bounded sample of
    // initially rejected listings. Existing candidates already get full AI.
    for (const listing of primaryListings) {
        if (!listing.isGraded && listing.match !== "JUNK" && listing.screen?.status !== "CANDIDATE" && listing.images[0]) {
            found.set(listing.id, { listing, how: "PHOTO_SHOWS_IT", lane: 0 });
        }
    }

    for (const [index, query] of plan.entries()) {
        signal?.throwIfAborted();
        const { listings } = await dependencies.search(query.query, { maxResults: 200, anyCategory: query.anyCategory, keepReserve: true, signal });

        for (const listing of listings) {
            if (!excluded.has(listing.id) && !found.has(listing.id)) found.set(listing.id, { listing, how: query.how, lane: index + 1 });
        }
    }

    const now = Date.now();
    const eligible = [...found.values()].filter(
        ({ listing }) =>
            gradingMatches(listing.isGraded, intent) &&
            (!listing.endTime || Date.parse(listing.endTime) > now) &&
            !(listing.buyingOption === "FIXED_PRICE" && (listing.currentPrice ?? 0) < minPrice)
    );
    // Share the photo budget across query families, so the initial results
    // cannot consume every check before generic/misspelled titles get a turn.
    const maximum = Math.min(MAX_PHOTO_CHECKS, Math.ceil(Math.sqrt(eligible.length)) * 4);
    const lanes = new Map<number, typeof eligible>();
    for (const item of eligible) {
        if (!lanes.has(item.lane)) lanes.set(item.lane, []);
        lanes.get(item.lane)!.push(item);
    }
    const live: typeof eligible = [];
    while (live.length < maximum) {
        let added = false;
        for (const lane of lanes.values()) {
            const item = lane.shift();
            if (item) { live.push(item); added = true; }
            if (live.length >= maximum) break;
        }
        if (!added) break;
    }

    onStart({ total: live.length, queries: plan.map((query) => query.query) });
    console.log(`Discovery for ${intent.cardName ? describeWanted(intent) : search}: ${live.length} extra listings from ${plan.length} searches`);

    const photoBudget = { left: maximum };
    const steps = dependencies.screening(targets, includeOffers, signal);
    let checked = 0;

    let emptyChecks = 0;
    for (let offset = 0; offset < live.length;) {
        const concurrency = analysisConcurrency(live.length - offset);
        const batch = live.slice(offset, offset + concurrency * 2);
        let useful = 0;
        await mapLimit(batch, concurrency, async ({ listing, how }) => {
            if (signal?.aborted) return;
            const result = await digListing(listing, how, intent, photoBudget, steps, signal, dependencies.findPhoto).catch((error: Error) => {
                if (signal?.aborted) return null;
                console.error(`Dig failed for ${listing.id}: ${error.message}`);
                return null;
            });

            if (signal?.aborted) return;
            if (result) {
                const mismatch = result.match ?? cardMismatch(result.screen, intent);
                onListing(mismatch ? { ...result, match: mismatch } : result);
                if (!mismatch && (result.mistakes?.length || result.screen?.status === "CANDIDATE")) useful += 1;
            }
            checked += 1;
            onProgress(checked, live.length);
        });
        offset += batch.length;
        emptyChecks = useful ? 0 : emptyChecks + batch.length;
        if (signal?.aborted || emptyChecks >= 24) break;
    }
    if (!signal?.aborted) onProgress(checked, checked);
}
