import { runStructured, MODEL } from "./openai.ts";
import { fullSizePhoto } from "./photo-match.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createLimiter } from "../lib/concurrency.ts";
import type { SearchIntent } from "../../shared/types.ts";

// Is the card you're searching for in this photo? Asked of listings whose
// titles can't be trusted: misspelled, vague, or wrong. The photo decides,
// not the title.

const FIND_VERSION = 4;
const YEAR_HOURS = 24 * 365;
const limit = createLimiter(4);

export interface PhotoFind {
    found: "YES" | "NO" | "CANT_TELL";
    // What the photo shows, briefly.
    shows: string;
    // How many cards the photo shows: more than one is a lot, never shown.
    cardCount: number;
    // The wanted card's set and number as the photo shows them, if readable.
    set: string | null;
    cardNumber: string | null;
}

const NULLABLE = { type: ["string", "null"] };

const SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["found", "shows", "cardCount", "set", "cardNumber"],
    properties: {
        found: { type: "string", enum: ["YES", "NO", "CANT_TELL"] },
        shows: { type: "string" },
        cardCount: { type: "integer" },
        set: NULLABLE,
        cardNumber: NULLABLE,
    },
};

export function describeWanted(intent: SearchIntent): string {
    const sets = intent.sets.length > 0 ? ` from ${intent.sets.join(" or ")}` : "";
    const number = intent.cardNumber ? ` (#${intent.cardNumber})` : "";

    return `${intent.cardName}${sets}${number}`;
}

function prompt(intent: SearchIntent): string {
    return `A buyer is looking for this English Pokemon card: ${describeWanted(intent)}.

This is the main photo from an eBay listing whose title may be misspelled, vague, or wrong, so ignore the title entirely. Is that card in the photo?

- found: YES only if you can see that card itself (its name, its artwork, and its set symbol or number fit). NO if it isn't there. CANT_TELL if the photo is too small, blurry, or shows only the back or packaging.
- shows: what the photo shows, in a few words, like "one card: Charizard 4/102, Base Set".
- cardCount: how many cards the photo shows.
- set and cardNumber: the wanted card's set and collector number as the photo shows them, or null if you can't read them.`;
}

export async function findCardInPhoto(imageUrl: string, intent: SearchIntent): Promise<PhotoFind | null> {
    const key = `photo-find:v${FIND_VERSION}:${MODEL}:${imageUrl}:${describeWanted(intent).toLowerCase()}`;
    const saved = await readCache<PhotoFind>(key, YEAR_HOURS);

    if (saved) return saved;

    try {
        const { result } = await limit(() =>
            runStructured<PhotoFind>({
                step: "Photo find",
                prompt: prompt(intent),
                photos: [{ url: fullSizePhoto(imageUrl), label: "Main listing photo" }],
                schemaName: "photo_find",
                schema: SCHEMA,
            })
        );

        await writeCache(key, result);

        return result;
    } catch (error) {
        console.error(`Photo find failed: ${(error as Error).message}`);
        return null;
    }
}
