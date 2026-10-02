import { runStructured, MODEL } from "./openai.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createLimiter } from "../lib/concurrency.ts";
import type { Screen } from "../../shared/types.ts";

// A quick look at a candidate's main photo before any eBay detail request
// or full analysis: is the card in it the card the listing claims? Reprints,
// other cards, and fakes often hide behind a clean title.

const MATCH_VERSION = 2;
const YEAR_HOURS = 24 * 365;

// Main photos are checked alongside a whole search's free checks.
const limit = createLimiter(4);

export type ClaimedCard = NonNullable<Screen["card"]>;

export interface PhotoMatch {
    verdict: "MATCH" | "MISMATCH" | "CANT_TELL";
    problems: string[];
    // The printing marks, as the photo shows them.
    firstEditionStamp: "VISIBLE" | "NOT_PRESENT" | "CANT_TELL";
    artBoxShadow: "PRESENT" | "ABSENT" | "CANT_TELL";
}

const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "problems", "firstEditionStamp", "artBoxShadow"],
    properties: {
        verdict: { type: "string", enum: ["MATCH", "MISMATCH", "CANT_TELL"] },
        problems: { type: "array", items: { type: "string" } },
        firstEditionStamp: { type: "string", enum: ["VISIBLE", "NOT_PRESENT", "CANT_TELL"] },
        artBoxShadow: { type: "string", enum: ["PRESENT", "ABSENT", "CANT_TELL"] },
    },
};

// eBay serves one photo at any size: s-l225 in search results, s-l1600 full size.
export function fullSizePhoto(url: string): string {
    return url.replace(/\/s-l\d+\./, "/s-l1600.");
}

export function describeClaim(card: ClaimedCard): string {
    return [card.name, card.set, card.cardNumber ? `#${card.cardNumber}` : null].filter(Boolean).join(", ");
}

function prompt(card: ClaimedCard): string {
    return `This is the main photo from an eBay listing for one Pokemon card. The listing says the card is: ${describeClaim(card)} (English).

Is the card in the photo that card? Look at the whole card: the name, the number and set total, the set symbol, the copyright line and year, the artwork, the borders, the layout and fonts, the language, the holo pattern, and any logo or stamp on the artwork (an anniversary logo such as a Pikachu with 25 or 30, another set's symbol, a prerelease or staff stamp).

- MISMATCH only for something you can actually see that shows another card, a reprint, another language, a fake or proxy, or not a card at all.
- MATCH when everything you can see fits that card.
- CANT_TELL when the photo is too small or blurry, or shows only the back, a slab label, or packaging.

Don't count the printing (a 1st Edition stamp or the artwork's shadow) or the condition as a mismatch. problems lists each difference you can see, plainly; it's empty for MATCH.

Separately, report the printing marks as the photo shows them, never from the listing's words:
- firstEditionStamp: VISIBLE if the "1st Edition" stamp is printed on the card; NOT_PRESENT only if the area just below the artwork, where it would be, is clearly visible and empty; otherwise CANT_TELL.
- artBoxShadow: PRESENT if the artwork frame has a dark drop shadow along its right edge, ABSENT if it has none, otherwise CANT_TELL.`;
}

export async function matchMainPhoto(imageUrl: string, card: ClaimedCard): Promise<PhotoMatch | null> {
    const key = `photo-match:v${MATCH_VERSION}:${MODEL}:${imageUrl}:${[card.set, card.cardNumber, card.name].join("|").toLowerCase()}`;
    const saved = await readCache<PhotoMatch>(key, YEAR_HOURS);

    if (saved) return saved;

    try {
        const { result } = await limit(() =>
            runStructured<PhotoMatch>({
                step: "Main photo check",
                prompt: prompt(card),
                photos: [{ url: fullSizePhoto(imageUrl), label: "Main listing photo" }],
                schemaName: "photo_match",
                schema: SCHEMA,
            })
        );

        await writeCache(key, result);

        return result;
    } catch (error) {
        // Without the check, the listing goes on as before.
        console.error(`Main photo check failed: ${(error as Error).message}`);
        return null;
    }
}
