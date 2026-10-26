import type { Evaluation, FoundHow, ListingSummary } from "./types.ts";
import { currentSellerMistakes } from "./seller-mistakes.ts";

// Explain observed listing clues separately from risks and auction context.
// These never establish profit or change the purchase verdict.

export interface ListingSignal {
    id: string;
    label: string;
    detail: string;
    weight: number;
    kind: "OPPORTUNITY" | "CAUTION" | "CONTEXT";
}

// How Dig deeper turned a listing up: the reason it's hidden from others.
const FOUND_LABELS: Record<FoundHow, string> = {
    MISSPELLED: "Found via alternate-name search",
    NUMBER_ONLY: "Found via collector-number search",
    WRONG_CATEGORY: "Listed in the wrong category",
    PHOTO_SHOWS_IT: "Found through photo verification",
};

const PRINTING_NAMES: Record<string, string> = { FIRST_EDITION: "1st Edition", SHADOWLESS: "Shadowless" };
const PRICIER = (printing: string | null | undefined) => printing === "FIRST_EDITION" || printing === "SHADOWLESS";

// Lowercase words, no accents or punctuation, so titles compare plainly.
function words(text: unknown): string {
    return String(text ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9/]+/g, " ")
        .trim();
}

// Whether a title names the set by any of its distinctive words.
function mentionsSet(title: string, set: string): boolean {
    return words(set)
        .split(" ")
        .filter((word) => word.length >= 3 && !["set", "the", "and", "pokemon"].includes(word))
        .some((word) => title.includes(word));
}

// The hour (US Eastern) an auction ends, if it's when few buyers are awake.
function quietHour(endTime: string): number | null {
    if (!Number.isFinite(Date.parse(endTime))) return null;
    const hour =
        Number(
            new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(
                new Date(endTime)
            )
        ) % 24;

    return hour < 6 ? hour : null;
}

function hourName(hour: number): string {
    return hour === 0 ? "midnight" : `${hour} AM`;
}

export function listingSignals(
    listing: ListingSummary,
    evaluation: Evaluation | null | undefined,
    now = Date.now()
): ListingSignal[] {
    const signals: Omit<ListingSignal, "kind">[] = [];
    const title = words(listing.title);
    const identity = evaluation?.identity ?? null;
    const evidence = identity?.evidence ?? null;
    const name = identity?.name ?? listing.screen?.card?.name ?? null;
    const set = identity?.set ?? listing.screen?.card?.set ?? null;
    const mistakes = currentSellerMistakes(listing, evaluation);
    for (const mistake of mistakes) signals.push({
        id: `SELLER_${mistake.kind}`, label: "Photo suggests a seller mistake", detail: mistake.detail, weight: 20,
    });

    // Found by digging: a listing most buyers' searches never show.
    const disprovedPhotoLead = listing.found?.how === "PHOTO_SHOWS_IT" && Boolean(listing.mistakes?.length) && mistakes.length === 0;
    if (listing.found && !disprovedPhotoLead) {
        signals.push({
            id: "FOUND",
            label: FOUND_LABELS[listing.found.how],
            detail: `Found by automatic discovery: ${listing.found.note}`,
            weight: 30,
        });
    }

    // The strongest: the photos show a pricier printing the seller never states.
    if (evidence && PRICIER(evidence.photo) && !PRICIER(evidence.title) && !PRICIER(evidence.itemSpecifics)) {
        signals.push({
            id: "SLEEPER",
            label: `Photos show ${PRINTING_NAMES[evidence.photo]}`,
            detail: "The photos show a pricier printing than the seller states. Check the stamp or shadow yourself.",
            weight: 40,
        });
    } else if (identity?.status === "IDENTIFIED" && PRICIER(identity.printing) && evidence && !PRICIER(evidence.title)) {
        signals.push({
            id: "TITLE_OMITS_PRINTING",
            label: `Title omits ${identity.printingLabel}`,
            detail: `It's verified ${identity.printingLabel}, but the title doesn't say so, so searches for it miss this listing.`,
            weight: 30,
        });
    }

    // A dig already says how the title hides it.
    if (name && !words(name).split(" ").every((word) => title.split(" ").includes(word))) {
        signals.push({
            id: "NAME_OFF",
            label: "Name misspelled or missing",
            detail: `The title doesn't spell out "${name}", so searches for it miss this listing.`,
            weight: 25,
        });
    }

    if (identity?.status === "IDENTIFIED" && identity.finish === "HOLO" && !/\bholo/.test(title)) {
        signals.push({
            id: "TITLE_OMITS_HOLO",
            label: "Title omits holo",
            detail: "It's a holo, but the title doesn't say so.",
            weight: 8,
        });
    }

    if (set && !mentionsSet(title, set) && !/\b\d{1,3}\/\d{1,3}\b/.test(title)) {
        signals.push({
            id: "NO_SET",
            label: "Title omits the set",
            detail: `Neither the set (${set}) nor the card number is in the title.`,
            weight: 10,
        });
    }

    if (listing.screen?.filledFromTitle?.some((field) => field === "Set" || field === "Card Number")) {
        signals.push({
            id: "THIN_DETAILS",
            label: "Item details left out",
            detail: "The seller skipped the set or number in the item details, which eBay's search filters rely on.",
            weight: 8,
        });
    }

    const sufficiency = evaluation?.photoCheck?.photoSufficiency;

    if (identity?.status === "IDENTIFIED" && sufficiency && sufficiency !== "SUFFICIENT") {
        signals.push({
            id: "WEAK_PHOTOS",
            label: "Limited photo evidence",
            detail: "The card was identified, but the available views limit the condition assessment.",
            weight: 0,
        });
    }

    if (listing.buyingOption === "AUCTION" && listing.endTime) {
        const hoursLeft = (Date.parse(listing.endTime) - now) / 3_600_000;

        if (hoursLeft > 0 && hoursLeft < 24 && listing.bids <= 1) {
            signals.push({
                id: "FEW_BIDS",
                label: listing.bids === 0 ? "No bids, ending soon" : "One bid, ending soon",
                detail: "Less than a day remains. The current bid count does not establish the final price.",
                weight: 0,
            });
        }

        const hour = quietHour(listing.endTime);

        if (hour !== null) {
            signals.push({
                id: "QUIET_HOUR",
                label: `Ends ${hourName(hour)} Eastern`,
                detail: "Scheduled closing time; bidder activity and the final price remain unknown.",
                weight: 0,
            });
        }
    }

    const feedback = listing.seller?.feedbackScore;

    if (typeof feedback === "number" && feedback < 25) {
        signals.push({
            id: "NEW_SELLER",
            label: "Limited seller history",
            detail: `${feedback} feedback ratings. Review the seller's history and return terms.`,
            weight: 0,
        });
    }

    const grouped = new Map<string, ListingSignal>();
    for (const signal of signals) {
        const kind = ["NEW_SELLER", "WEAK_PHOTOS"].includes(signal.id) ? "CAUTION"
            : ["FOUND", "QUIET_HOUR", "FEW_BIDS"].includes(signal.id) ? "CONTEXT" : "OPPORTUNITY";
        const group = /SLEEPER|PRINTING|FIRST_EDITION|SHADOWLESS/.test(signal.id) ? "PRINTING"
            : /NAME|GENERIC_TITLE/.test(signal.id) ? "NAME"
            : /HOLO/.test(signal.id) ? "FINISH"
            : ["SELLER_SET", "NO_SET"].includes(signal.id) ? "SET" : signal.id;
        const previous = grouped.get(group);
        if (!previous || signal.weight > previous.weight) grouped.set(group, { ...signal, kind });
    }
    return [...grouped.values()].sort((a, b) => b.weight - a.weight);
}

// Sort by the strongest actual listing clue, then distinct clue count.
// Risk, weak photos and retrieval method never increase opportunity priority.
export function compareListingEvidence(a: ListingSignal[], b: ListingSignal[]): number {
    const opportunities = (signals: ListingSignal[]) => signals.filter((signal) => signal.kind === "OPPORTUNITY");
    const left = opportunities(a);
    const right = opportunities(b);
    return Math.max(0, ...right.map((signal) => signal.weight)) - Math.max(0, ...left.map((signal) => signal.weight)) || right.length - left.length;
}
