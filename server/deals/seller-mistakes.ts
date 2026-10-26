import type { ListingSummary, SellerMistake } from "../../shared/types.ts";
import type { PhotoInspection } from "../ai/photo-find.ts";
import { normalizeWords, sameSetFamily, photoPrinting, printingClaimFromText } from "../identity/card-identity.ts";

function editDistance(a: string, b: string): number {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]));
        row = next;
    }
    return row[b.length];
}

// Signals describe observable listing mistakes, never an assumed discount or
// profit. Discovery already requires a clear, single, non-stock card reading.
export function sellerMistakes(listing: ListingSummary, photo: PhotoInspection, claims: Record<string, string> = {}): SellerMistake[] {
    if (photo.card.confidence !== "HIGH" || photo.cardCount !== 1 || photo.isStockImage) return [];
    const mistakes: SellerMistake[] = [];
    const title = normalizeWords(listing.title);
    const name = normalizeWords(photo.card.name);
    const tokens = title.split(" ");
    if (name && !name.split(" ").every((word) => tokens.includes(word))) {
        const misspelled = name.split(" ").some((word) => word.length >= 5 && tokens.some((token) => token.length >= 4 && editDistance(word, token) <= 2));
        mistakes.push({ kind: misspelled ? "NAME" : "GENERIC_TITLE", detail: misspelled
            ? `Photo reads ${photo.card.name}; the title appears to misspell the name.`
            : `Photo shows ${photo.card.name} ${photo.card.cardNumber}; the title omits the card's name.` });
    }
    const claim = printingClaimFromText([listing.title, ...Object.values(claims)].join(" "));
    const stated = [printingClaimFromText(listing.title), ...Object.values(claims).map(printingClaimFromText)];
    const printing = photoPrinting(photo.printingMarks, { shadowMatters: sameSetFamily(photo.card.set, "Base Set") });
    if (printing === "FIRST_EDITION" && claim !== "FIRST_EDITION" && !stated.includes("FIRST_EDITION")) mistakes.push({ kind: "FIRST_EDITION", detail: "Photo appears to show a 1st Edition stamp that the seller doesn't identify. Full analysis must confirm it before premium pricing." });
    if (printing === "SHADOWLESS" && !/\bshadowless\b/i.test([listing.title, ...Object.values(claims)].join(" "))) mistakes.push({ kind: "SHADOWLESS", detail: "Photo may show Shadowless Base Set despite the seller's wording. Full analysis must confirm the artwork border and other printing clues." });
    if (photo.card.finish === "HOLO" && (/\bnon\s*holo/.test(title) || !/\bholo/.test(title))) mistakes.push({ kind: "HOLO", detail: /\bnon\s*holo/.test(title)
        ? "Photo shows foil artwork, but the title calls the card non-holo. Confirm the finish before using holo prices."
        : "Photo shows foil artwork; the title omits holo." });
    const claimedSet = claims.Set ?? listing.screen?.card?.set;
    if (claimedSet && photo.card.set && !sameSetFamily(claimedSet, photo.card.set)) mistakes.push({ kind: "SET", detail: `Seller says ${claimedSet}; the photo's symbol, artwork and number identify ${photo.card.set}.` });
    return mistakes;
}
