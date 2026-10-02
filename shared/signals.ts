import type { Evaluation, FoundHow, ListingSummary } from "./types.ts";

// Bargain signals: signs a listing is overlooked or mispriced because of how
// it was listed, not because of the card. None of them means buy. Each is a
// reason to look closer; the photos and the money math still decide.

export interface BargainSignal {
    id: string;
    label: string;
    detail: string;
    weight: number;
}

// How Dig deeper turned a listing up: the reason it's hidden from others.
const FOUND_LABELS: Record<FoundHow, string> = {
    MISSPELLED: "Misspelled title",
    NUMBER_ONLY: "Title gives only the number",
    WRONG_CATEGORY: "Listed in the wrong category",
    PHOTO_SHOWS_IT: "Title hides it; the photo shows it",
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

export function bargainSignals(
    listing: ListingSummary,
    evaluation: Evaluation | null | undefined,
    now = Date.now()
): BargainSignal[] {
    const signals: BargainSignal[] = [];
    const title = words(listing.title);
    const identity = evaluation?.identity ?? null;
    const evidence = identity?.evidence ?? null;
    const name = identity?.name ?? listing.screen?.card?.name ?? null;
    const set = identity?.set ?? listing.screen?.card?.set ?? null;

    // Found by digging: a listing most buyers' searches never show.
    if (listing.found) {
        signals.push({
            id: "FOUND",
            label: FOUND_LABELS[listing.found.how],
            detail: `Found by Dig deeper: ${listing.found.note}`,
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
    if (name && !listing.found && !words(name).split(" ").every((word) => title.includes(word))) {
        signals.push({
            id: "NAME_OFF",
            label: "Name misspelled or missing",
            detail: `The title doesn't spell out "${name}", so searches for it miss this listing.`,
            weight: 25,
        });
    }

    if (identity?.status === "IDENTIFIED" && /HOLO/.test(identity.finish) && !/REVERSE/.test(identity.finish) && !/\bholo/.test(title)) {
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
            label: "Weak photos, card still clear",
            detail: "Thin or blurry photos put buyers off, but the card was still identified.",
            weight: 10,
        });
    }

    if (listing.buyingOption === "AUCTION" && listing.endTime) {
        const hoursLeft = (Date.parse(listing.endTime) - now) / 3_600_000;

        if (hoursLeft > 0 && hoursLeft < 24 && listing.bids <= 1) {
            signals.push({
                id: "FEW_BIDS",
                label: listing.bids === 0 ? "No bids, ending soon" : "One bid, ending soon",
                detail: "Less than a day left and almost no bidding.",
                weight: 15,
            });
        }

        const hour = quietHour(listing.endTime);

        if (hour !== null) {
            signals.push({
                id: "QUIET_HOUR",
                label: `Ends ${hourName(hour)} Eastern`,
                detail: "Few bidders are awake to bid at the end.",
                weight: 10,
            });
        }
    }

    const feedback = listing.seller?.feedbackScore;

    if (typeof feedback === "number" && feedback < 25) {
        signals.push({
            id: "NEW_SELLER",
            label: "New seller",
            detail: `${feedback} feedback: newer sellers misprice more often, and carry more risk.`,
            weight: 6,
        });
    }

    return signals.sort((a, b) => b.weight - a.weight);
}

// 0 to 100: how strongly a listing looks overlooked. Not a buy signal.
export function bargainScore(signals: BargainSignal[]): number {
    return Math.min(100, signals.reduce((total, signal) => total + signal.weight, 0));
}
