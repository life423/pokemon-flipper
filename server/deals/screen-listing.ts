import { setMatches } from "../search/relevance.ts";
import { cardLanguageStatus } from "../../shared/card-language.ts";
import { readTitleWithoutAi } from "../ai/title-reader.ts";
import { availablePhotoCount } from "../../shared/analysis-priority.ts";
import type { ListingSummary, SearchIntent } from "../../shared/types.ts";
import { criteriaMismatch, searchAttributes } from "../../shared/search-criteria.ts";
import { printingClaimFromText, isPrinting, sameCardNumber } from "../identity/card-identity.ts";

// Search admission needs no new title/photo/price AI. Seller claims only help
// remove obvious mismatches; the bounded evaluator verifies actual evidence.
export async function screenListingWithoutAi(listing: ListingSummary, intent: SearchIntent | null = null, signal?: AbortSignal,
    read = readTitleWithoutAi): Promise<ListingSummary> {
    signal?.throwIfAborted();
    const reading = await read(listing.title, signal);
    signal?.throwIfAborted();
    if (cardLanguageStatus(listing.title, [reading.language]) === "OTHER") return { ...listing, match: "OTHER_LANGUAGE" };
    if (reading.kind && reading.kind !== "SINGLE_CARD") return { ...listing, match: "JUNK" };
    if (intent && !setMatches(reading.set, intent)) return { ...listing, match: "OTHER_SET" };
    if (intent?.cardNumber && reading.cardNumber && !sameCardNumber(intent.cardNumber, reading.cardNumber)) return { ...listing, match: "OTHER_CARD" };
    const attributes = searchAttributes(listing.title, { ...(reading.grader ? { "Professional Grader": reading.grader } : {}), ...(reading.grade ? { Grade: reading.grade } : {}) });
    const mismatch = intent && criteriaMismatch(attributes, intent, false);
    if (mismatch) return { ...listing, match: mismatch };
    const claim = printingClaimFromText(listing.title);
    if (intent?.printing && isPrinting(claim) && intent.printing !== claim) return { ...listing, match: "OTHER_PRINTING" };
    const card = reading.cardName || reading.set || reading.cardNumber ? {
        name: reading.cardName, set: reading.set, cardNumber: reading.cardNumber,
        printing: isPrinting(claim) ? claim : "UNKNOWN" as const, printingLabel: null,
    } : null;
    return { ...listing, listedAttributes: attributes,
        ...(!listing.cardCondition?.trim() && reading.condition ? { cardCondition: reading.condition } : {}),
        screen: { status: "UNSCREENED", needsAnalysis: listing.isGraded ? "SLAB_LABEL" : "IDENTITY",
            reason: "Photos and resale evidence have not been assessed.", card, bestCase: null, assumed: null,
            evidence: { photos: availablePhotoCount(listing.images), mainPhoto: "UNKNOWN" } } };
}
