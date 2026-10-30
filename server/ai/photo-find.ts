import { cleanPhotoCard, PHOTO_CARD_SCHEMA } from "./photo-card-schema.ts";
import { runStructured, MODEL } from "./openai.ts";
import { fullSizePhoto } from "./photo-match.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createSingleFlight } from "../lib/single-flight.ts";
import { normalizeWords, sameCardNumber, sameSetFamily, photoPrinting } from "../identity/card-identity.ts";
import type { PhotoCardReading, PrintingMarks, SearchIntent } from "../../shared/types.ts";

const FIND_VERSION = 5;
const YEAR_HOURS = 24 * 365;
const share = createSingleFlight();

export interface PhotoInspection {
    cardCount: number;
    isStockImage: boolean;
    card: PhotoCardReading;
    printingMarks: PrintingMarks;
    shows: string;
}

export interface PhotoFind {
    found: "YES" | "NO" | "CANT_TELL";
    shows: string;
    cardCount: number;
    set: string | null;
    cardNumber: string | null;
    inspection?: PhotoInspection;
}


const SCHEMA = {
    type: "object", additionalProperties: false,
    required: ["cardCount", "isStockImage", "card", "printingMarks", "shows"],
    properties: {
        cardCount: { type: "integer" }, isStockImage: { type: "boolean" },
        card: PHOTO_CARD_SCHEMA, shows: { type: "string" },
        printingMarks: {
            type: "object", additionalProperties: false,
            required: ["firstEditionStamp", "artBoxShadow"],
            properties: {
                firstEditionStamp: { type: "string", enum: ["VISIBLE", "NOT_PRESENT", "CANT_TELL"] },
                artBoxShadow: { type: "string", enum: ["PRESENT", "ABSENT", "CANT_TELL"] },
            },
        },
    },
};

const cacheKey = (url: string) => `photo-find:v${FIND_VERSION}:${MODEL}:${fullSizePhoto(url)}`;
export async function savedPhotoInspection(url: string): Promise<PhotoInspection | null> {
    const saved = await readCache<PhotoInspection>(cacheKey(url), YEAR_HOURS);
    return saved ? { ...saved, card: cleanPhotoCard(saved.card) } : null;
}

export function describeWanted(intent: SearchIntent): string {
    return [intent.cardName, ...intent.sets, intent.cardNumber].filter(Boolean).join(" ");
}

// Read the photograph without seller claims or a desired answer. One saved
// reading is reused across searches; it is never a final grading assessment.
export async function inspectCardPhoto(url: string, signal?: AbortSignal): Promise<PhotoInspection | null> {
    signal?.throwIfAborted();
    return share(cacheKey(url), async () => {
        const saved = await savedPhotoInspection(url);
        if (saved) return saved;
        try {
            const { result } = await runStructured<PhotoInspection>({
                step: "Seller mistake photo scan",
                signal,
                prompt: `Identify the actual Pokemon card visible in this listing photo, independently of any seller text. Report the printed name, exact set using its symbol, number and artwork, printed collector number, language, finish, and concrete visual evidence. Use null or UNKNOWN when unreadable; never infer a set or premium variant from a vague resemblance. Count cards and mark stock/catalog images.
HIGH confidence requires a legible name and collector number with set-symbol/artwork evidence agreeing. A back-only, blurry, cropped, stock, or ambiguous look-alike photo cannot be HIGH.
Finish: HOLO or REVERSE_HOLO only with visible foil evidence; a still photo without reflection does not prove NON_HOLO. Use UNKNOWN when uncertain. Do not confuse holo, reverse holo, anniversary reprints, or other parallel versions.
Printing marks: firstEditionStamp VISIBLE only when the printed 1st Edition stamp itself is legible; NOT_PRESENT only with its whole expected area visible and empty. artBoxShadow describes the right edge of the artwork box, not lighting or a cast shadow. Otherwise CANT_TELL. Report shows in plain language.`,
                photos: [{ url: fullSizePhoto(url), label: "Actual listing photo" }],
                schemaName: "photo_discovery", schema: SCHEMA,
            });
            const cleaned = { ...result, card: cleanPhotoCard(result.card) };
            await writeCache(cacheKey(url), cleaned);
            return cleaned;
        } catch (error) {
            console.error(`Photo discovery failed: ${(error as Error).message}`);
            return null;
        }
    });
}

export function photoFitsSearch(photo: PhotoInspection, intent: SearchIntent): boolean {
    const card = photo.card;
    if (photo.cardCount !== 1 || photo.isStockImage || card.confidence !== "HIGH" || !card.name || !card.set || !card.cardNumber || normalizeWords(card.language) !== "english") return false;
    if (intent.cardName && !(` ${normalizeWords(card.name)} `).includes(` ${normalizeWords(intent.cardName)} `)) return false;
    if (intent.sets.length && !intent.sets.some((set) => sameSetFamily(card.set, set))) return false;
    if (intent.cardNumber && !sameCardNumber(card.cardNumber, intent.cardNumber)) return false;
    if (intent.printing && photoPrinting(photo.printingMarks, { shadowMatters: sameSetFamily(card.set, "Base Set") }) !== intent.printing) return false;
    if (intent.finish && card.finish !== intent.finish) return false;
    return true;
}

export async function findCardInPhoto(url: string, intent: SearchIntent, signal?: AbortSignal): Promise<PhotoFind | null> {
    const photo = await inspectCardPhoto(url, signal);
    if (!photo) return null;
    return {
        found: photoFitsSearch(photo, intent) ? "YES" : photo.card.confidence === "HIGH" ? "NO" : "CANT_TELL",
        shows: photo.shows, cardCount: photo.cardCount,
        set: photo.card.set, cardNumber: photo.card.cardNumber, inspection: photo,
    };
}
