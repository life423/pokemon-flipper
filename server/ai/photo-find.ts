import { cleanPhotoCard } from "./photo-card-schema.ts";
import { MODEL } from "./openai.ts";
import { readCache } from "../lib/cache.ts";
import { normalizeWords, sameCardNumber, sameSetFamily, photoPrinting } from "../identity/card-identity.ts";
import type { PhotoCardReading, PrintingMarks, SearchIntent } from "../../shared/types.ts";

const FIND_VERSION = 5;
const YEAR_HOURS = 24 * 365;

export interface PhotoInspection {
    cardCount: number;
    isStockImage: boolean;
    card: PhotoCardReading;
    printingMarks: PrintingMarks;
    shows: string;
}

// Keep accepted discovery readings and their original URL-based cache keys
// readable after retiring the unused paid discovery writer.
function fullSizePhoto(url: string): string {
    return url.replace(/\/s-l\d+\./, "/s-l1600.");
}

const cacheKey = (url: string) => `photo-find:v${FIND_VERSION}:${MODEL}:${fullSizePhoto(url)}`;
export async function savedPhotoInspection(url: string): Promise<PhotoInspection | null> {
    const saved = await readCache<PhotoInspection>(cacheKey(url), YEAR_HOURS);
    return saved ? { ...saved, card: cleanPhotoCard(saved.card) } : null;
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
