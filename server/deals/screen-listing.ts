import { getListingDetails, type ListingDetails } from "../ebay/listings.ts";
import { lookupCards, fetchComps, fetchRawComps } from "../pricing/pkmnprices.ts";
import { isEnglish, setMatches } from "../search/relevance.ts";
import { fillFromTitle, readTitle } from "../ai/title-reader.ts";
import { checkComps } from "../ai/comp-checker.ts";
import { matchMainPhoto, type ClaimedCard, type PhotoMatch } from "../ai/photo-match.ts";
import { prescreen, type ScreenInput } from "./prescreen.ts";
import { withTargets, retargetScreen } from "../../shared/money/targets.ts";
import { availablePhotoCount } from "../../shared/analysis-priority.ts";
import type { ListingSummary, Screen, SearchIntent, Targets } from "../../shared/types.ts";
import { criteriaMismatch, searchAttributes } from "../../shared/search-criteria.ts";
import { pricingRetries } from "./pricing-retries.ts";
import type { PricingRetry } from "../../shared/pricing-retries.ts";
import { MONEY_CONFIG, type MoneyConfig } from "../../shared/money/config.ts";

// Zero shipping is an optimistic bound for deciding whether to request a
// quote, never a replacement for an unknown quote in the actual valuation.
export function shippingCouldChange(screen: Screen, price: number | null, config: MoneyConfig = MONEY_CONFIG, includeOffers = false): boolean {
    if (screen.status !== "DROPPED" || !screen.money) return false;
    return retargetScreen({ ...screen, money: { ...screen.money, shipping: 0 } }, price, config.targets, config, includeOffers).status === "CANDIDATE";
}

// The steps a listing goes through, passed in so tests can supply their own.
export interface ScreenSteps {
    deferPricing?: (listing: ListingSummary, input: ScreenInput, intent: SearchIntent | null) => PricingRetry | undefined;
    readTitle: typeof fillFromTitle;
    loadDetails: (itemId: string, listing?: Pick<ListingSummary, "images" | "title">, freshShipping?: boolean) => Promise<ListingDetails>;
    shippingCouldChange?: (screen: Screen, price: number | null) => boolean;
    check: (input: ScreenInput) => Promise<Screen>;
    matchPhoto: (imageUrl: string, card: ClaimedCard) => Promise<PhotoMatch | null>;
}

export function screeningSteps(targets?: Targets, includeOffers = false, signal?: AbortSignal,
    pricing = { lookupCards, fetchComps, fetchRawComps, checkComps }): ScreenSteps {
    const whileNeeded = async <T>(run: () => Promise<T>): Promise<T> => {
        signal?.throwIfAborted();
        const result = await run();
        signal?.throwIfAborted();
        return result;
    };
    return {
        deferPricing: pricingRetries.register,
        shippingCouldChange: (screen, price) => shippingCouldChange(screen, price, targets ? withTargets(targets) : MONEY_CONFIG, includeOffers),
        readTitle: signal ? (listing) => fillFromTitle(listing, (title) => readTitle(title, signal)) : fillFromTitle,
        // Past the day's reserve, eBay refuses and the title's check stands.
        loadDetails: (itemId, listing, freshShipping) => getListingDetails(itemId, {
            keepReserve: true, expectedPhotos: listing?.images, expectedTitle: listing?.title,
            ...(freshShipping ? { maxAgeHours: 0 } : {}),
        }),
        check: (input) =>
            whileNeeded(() => prescreen(input, {
                lookupCards: (...args) => whileNeeded(() => pricing.lookupCards(...args)),
                fetchComps: (...args) => whileNeeded(() => pricing.fetchComps(...args)),
                fetchRawComps: (...args) => whileNeeded(() => pricing.fetchRawComps(...args)),
                checkComps: (comps, target) => whileNeeded(() => pricing.checkComps(comps, target, signal)),
                config: targets ? withTargets(targets) : undefined, includeOffers,
            })).catch((error: Error) => {
                signal?.throwIfAborted();
                return unscreened(`Screening failed: ${error.message}`);
            }),
        matchPhoto: (imageUrl, card) => matchMainPhoto(imageUrl, card, signal),
    };
}

export const REAL_STEPS = screeningSteps();

function unscreened(reason: string): Screen {
    return { status: "UNSCREENED", reason, card: null, bestCase: null, assumed: null };
}

function withFilled(screen: Screen, filled: string[]): Screen {
    return filled.length > 0 ? { ...screen, filledFromTitle: filled } : screen;
}

export async function screenListing(
    listing: ListingSummary,
    steps: ScreenSteps = REAL_STEPS,
    intent: SearchIntent | null = null,
    signal?: AbortSignal
): Promise<ListingSummary> {
    signal?.throwIfAborted();
    const expired = () => listing.buyingOption === "AUCTION" && Boolean(listing.endTime) && Date.parse(listing.endTime!) <= Date.now();
    const unavailable = () => ({ ...listing, availability: "UNAVAILABLE" as const });
    if (expired()) return unavailable();
    let pricingInput: ScreenInput | undefined;
    const check = (input: ScreenInput) => { pricingInput = input; return steps.check(input); };
    const finish = (value: ListingSummary): ListingSummary => {
        if ((!value.match || value.match === "UNCONFIRMED_CRITERIA") && value.screen && pricingInput && steps.deferPricing) {
            const retry = steps.deferPricing(value, pricingInput, intent);
            if (retry) return { ...value, screen: { ...value.screen, pricingRetry: retry } };
        }
        return value;
    };
    const base = {
        price: listing.currentPrice,
        shipping: listing.shipping,
        isGraded: listing.isGraded,
        buyingOption: listing.buyingOption,
        bestOffer: listing.bestOffer,
    };

    // First from the search result alone: the title, read by the AI. The
    // condition is the one the title claims; with none, it's assumed best.
    const fromTitle = await steps.readTitle({ title: listing.title, aspects: {} });
    signal?.throwIfAborted();
    if (expired()) return unavailable();

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

    const titleCriteria = searchAttributes(listing.title, fromTitle.aspects);
    listing = { ...listing, listedAttributes: titleCriteria };
    const explicitMismatch = intent && criteriaMismatch(titleCriteria, intent, false);
    if (explicitMismatch) return { ...listing, match: explicitMismatch };
    const titleResult = (value: ListingSummary): ListingSummary => {
        const mismatch = intent && criteriaMismatch(titleCriteria, intent);
        if (mismatch === "UNCONFIRMED_CRITERIA" && value.screen && !value.screen.pricingIssue) value = { ...value, screen: { ...value.screen, status: "UNSCREENED", needsAnalysis: intent?.finish && !titleCriteria.finish ? "FINISH" : "SLAB_LABEL" } };
        return finish(mismatch ? { ...value, match: mismatch } : value);
    };

    const first = withFilled(
        await check({ ...base, title: listing.title, aspects: fromTitle.aspects, cardCondition: fromTitle.condition ?? null }),
        fromTitle.filled
    );
    signal?.throwIfAborted();

    if (expired()) return unavailable();
    // Explicit junk stays excluded; unusually low prices can enter full AI verification.
    if (first.junk) return { ...listing, match: "JUNK", screen: first };
    if (first.priceAnomaly && !first.priceAnomaly.photoChecked) return titleResult({ ...listing, screen: first });

    // A candidate's main photo, checked against the card it claims before any
    // eBay request or full analysis.
    let seen: PhotoMatch | null = null;

    if (first.status === "CANDIDATE" && first.card && listing.images[0]) {
        seen = await steps.matchPhoto(listing.images[0], first.card);
        signal?.throwIfAborted();
        if (expired()) return unavailable();

        if (seen?.verdict === "MISMATCH") {
            const reason = `The main photo doesn't match: ${seen.problems.join("; ") || "another card"}.`;
            return { ...listing, match: "OTHER_CARD", screen: { ...first, reason } };
        }
        if (first.priceAnomaly && seen?.verdict !== "MATCH") {
            return { ...listing, screen: { ...first, status: "UNSCREENED", priceAnomaly: { ...first.priceAnomaly, photoChecked: false }, reason: "The unusually low price needs a clear matching photo before automatic analysis." } };
        }
    }

    // Dropped on its title alone: no eBay detail request.
    const needsShippingQuote = listing.shipping === null && steps.shippingCouldChange?.(first, listing.currentPrice) === true;
    if (first.status !== "CANDIDATE" && !first.incomplete && !needsShippingQuote) {
        return titleResult({ ...listing, screen: { ...first, evidence: { photos: availablePhotoCount(listing.images), mainPhoto: seen?.verdict === "MATCH" ? "MATCH" : seen?.verdict === "CANT_TELL" ? "CANT_TELL" : "UNKNOWN" } } });
    }

    let details: ListingDetails;

    try {
        details = await steps.loadDetails(listing.id, listing, needsShippingQuote);
    } catch {
        signal?.throwIfAborted();
        if (expired()) return unavailable();
        // Out of eBay requests, or the listing is gone: the title's check stands.
        return titleResult({ ...listing, screen: { ...first, evidence: { photos: availablePhotoCount(listing.images), mainPhoto: seen?.verdict === "MATCH" ? "MATCH" : seen?.verdict === "CANT_TELL" ? "CANT_TELL" : "UNKNOWN" } } });
    }
    signal?.throwIfAborted();

    // Then with the listing's own details; the title only fills gaps.
    if (expired()) return unavailable();
    const { aspects, filled } = await steps.readTitle(details);
    signal?.throwIfAborted();
    if (expired()) return unavailable();

    if (!isEnglish(aspects.Language)) {
        return { ...listing, match: "OTHER_LANGUAGE" };
    }
    if (intent && !setMatches(aspects.Set, intent)) return { ...listing, match: "OTHER_SET" };
    const detailAttributes = searchAttributes(details.title, aspects);
    const detailsMismatch = intent && criteriaMismatch(detailAttributes, intent);
    if (detailsMismatch && detailsMismatch !== "UNCONFIRMED_CRITERIA") return { ...listing, match: detailsMismatch };

    const screen = withFilled(
        await check({
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

    return finish({
        ...listing,
        ...(detailsMismatch ? { match: detailsMismatch } : {}),
        shipping: listing.shipping ?? details.shipping,
        listedAt: details.listedAt ?? listing.listedAt, createdAt: details.createdAt ?? listing.createdAt,
        listedAttributes: searchAttributes(details.title, aspects),
        seller: details.seller ?? listing.seller,
        cardCondition: details.cardCondition,
        conditionNotes: details.conditionNotes,
        screen: { ...screen, ...(detailsMismatch && !screen.pricingIssue ? { status: "UNSCREENED" as const, needsAnalysis: intent?.finish && !detailAttributes.finish ? "FINISH" as const : "SLAB_LABEL" as const } : {}), evidence: { photos: availablePhotoCount(details.images ?? listing.images), mainPhoto: seen?.verdict === "MATCH" ? "MATCH" : seen?.verdict === "CANT_TELL" ? "CANT_TELL" : "UNKNOWN" } },
    });
}
