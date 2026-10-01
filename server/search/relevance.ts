import { normalizeWords, sameCardNumber, sameSetFamily, isPrinting } from "../identity/card-identity.ts";
import type { ListingSummary, Screen, SearchIntent } from "../../shared/types.ts";

// Which of eBay's results are the card searched for. Before any lookups,
// the title has to name the card. After the free check identifies a
// listing, its set, printing, and number have to fit the search too.

export type Match = NonNullable<ListingSummary["match"]>;

export function titleMatches(title: string, intent: SearchIntent): boolean {
    const text = normalizeWords(title);

    return intent.titleWords.every((word) => text.includes(normalizeWords(word)));
}

export function gradingMatches(isGraded: boolean, intent: SearchIntent): boolean {
    return intent.graded === null || intent.graded === isGraded;
}

// Why an identified listing isn't the card searched for, or null when it
// is (or when it isn't identified well enough to tell).
export function cardMismatch(screen: Screen | undefined, intent: SearchIntent): Match | null {
    const card = screen?.card;

    if (!card) return null;

    if (card.set && intent.sets.length > 0 && !intent.sets.some((wanted) => sameSetFamily(card.set, wanted))) {
        return "OTHER_SET";
    }

    if (intent.cardNumber && card.cardNumber && !sameCardNumber(card.cardNumber, intent.cardNumber)) {
        return "OTHER_CARD";
    }

    if (intent.printing && isPrinting(card.printing) && card.printing !== intent.printing) {
        return "OTHER_PRINTING";
    }

    return null;
}
