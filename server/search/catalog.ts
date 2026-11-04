import type { SearchIntent } from "../../shared/types.ts";
import { isPrinting, normalizeCardNumber, sameSetFamily } from "../identity/card-identity.ts";
import { sameCatalogName } from "../identity/catalog-name.ts";
import type { LookupQueryCards } from "../pricing/types.ts";
import { storageFailure } from "../lib/storage-failure.ts";
import { PriceResearchBudgetError } from "../pricing/research-budget.ts";

// Catalog metadata narrows the requested identity; it never verifies a live
// listing or assigns an edition, grade, condition or purchase recommendation.
export async function resolveQueryCatalog(intent: SearchIntent, lookup?: LookupQueryCards, signal?: AbortSignal): Promise<SearchIntent> {
    signal?.throwIfAborted();
    if (!lookup || intent.cardNumber || !intent.cardName || intent.sets.length !== 1 || !intent.finish) return intent;
    try {
        const result = await lookup({ set: intent.sets[0]!, name: intent.cardName });
        signal?.throwIfAborted();
        if (!result.complete || !result.cards.length || result.cards.length > 4) return intent;
        const matching: string[] = [];
        for (const card of result.cards) {
            if (card.source !== "pkmnprices" || !sameCatalogName(card.name, intent.cardName) || !sameSetFamily(card.setName, intent.sets[0]) ||
                !/^[a-z]{0,5}\d{1,4}[a-z]?\s*\/\s*[a-z]{0,5}\d{1,4}[a-z]?$/i.test(card.cardNumber) || !card.variants.length ||
                card.variants.some(variant => !isPrinting(variant.printing) || !["HOLO", "NON_HOLO", "REVERSE_HOLO"].includes(variant.finish))) return intent;
            if (card.variants.some(variant => variant.finish === intent.finish && (!intent.printing || variant.printing === intent.printing))) matching.push(card.cardNumber);
        }
        const numbers = new Set(matching.map(number => JSON.stringify(normalizeCardNumber(number))));
        // Preserve the original keywords: a derived number is a local filter,
        // so eBay can still return matching titles that omit their fraction.
        return numbers.size === 1 ? { ...intent, cardNumber: matching[0]! } : intent;
    } catch (error) {
        signal?.throwIfAborted();
        const storage = storageFailure(error);
        if (storage) throw storage;
        if (error instanceof PriceResearchBudgetError && error.reason !== "LIMIT") throw error;
        return intent;
    }
}
