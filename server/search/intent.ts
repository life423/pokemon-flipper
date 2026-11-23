import { MODEL } from "../ai/openai.ts";
import { readCache } from "../lib/cache.ts";
import { normalizeText } from "../ebay/filters.ts";
import { isPrinting, normalizeWords, printingClaimFromText, sameCardNumber, sameSetFamily } from "../identity/card-identity.ts";
import type { SearchIntent } from "../../shared/types.ts";
import { explicitCriteria, fallbackKeywords } from "../../shared/search-criteria.ts";
import { finishClaim } from "../../shared/finish.ts";
import { PRISMATIC_EVOLUTIONS_TITLE, XY_EVOLUTIONS_TITLE } from "../../shared/reprint-release.ts";
import { readTitleByRules } from "../ai/title-reader.ts";
import { StorageUnavailableError } from "../storage/index.ts";
import { cachedSetNames } from "./set-catalog.ts";

// What a search means. eBay does the matching; this says which of
// eBay's results are the card the search is for, so other cards and
// other sets can be set aside by identity instead of by exact words.

// Keep the legacy cache version so existing interpretations can still be reused.
const INTENT_VERSION = 2;
const MONTH_HOURS = 24 * 30;

type Reading = Omit<SearchIntent, "source">;

// Without the AI: printing and grading words, a card number, and no
// narrowing by name or set. Every eBay result for the search stays.
export function readSearchByRules(search: string): SearchIntent {
    const text = normalizeText(search);
    const claim = printingClaimFromText(search);

    const criteria = explicitCriteria(search);
    return {
        cardName: null,
        sets: [],
        cardNumber: text.match(/\b(\d{1,3}\/\d{1,3})\b/)?.[1] ?? null,
        printing: isPrinting(claim) ? claim : null,
        graded: criteria.grader || criteria.minGrade != null ? true : /\b(raw|ungraded)\b/.test(text) ? false : /\bgraded\b/.test(text) ? true : null,
        titleWords: [],
        source: "rules",
        ...criteria,
        keywords: [fallbackKeywords(search), criteria.grader].filter(Boolean).join(" "),
    };
}

// A literal local interpretation is only a search constraint, never evidence
// about a physical card's identity, printing, finish or condition.
export function readSearchLocally(search: string, knownSetNames: readonly string[] = []): SearchIntent {
    const intent = readSearchByRules(search);
    const local = readTitleByRules(fallbackKeywords(search), knownSetNames);
    return { ...intent, cardName: local.cardName, sets: local.set ? [local.set] : [],
        cardNumber: intent.cardNumber ?? local.cardNumber,
        titleWords: local.cardName ? normalizeWords(local.cardName).split(" ").filter(Boolean).slice(0, 2) : [] };
}

export async function readSearchWithoutAi(search: string, signal?: AbortSignal): Promise<SearchIntent> {
    signal?.throwIfAborted();
    const saved = await readCache<SearchIntent>(`search-intent:v${INTENT_VERSION}:${MODEL}:${normalizeText(search).trim()}`, MONTH_HOURS);
    signal?.throwIfAborted();
    if (!saved) {
        const knownSetNames = await cachedSetNames();
        signal?.throwIfAborted();
        return readSearchLocally(search, knownSetNames);
    }
    if (typeof saved !== "object" || !Array.isArray(saved.sets) || saved.sets.some(set => typeof set !== "string") ||
        !Array.isArray(saved.titleWords) || saved.titleWords.some(word => typeof word !== "string")) {
        throw new StorageUnavailableError("The saved search interpretation is invalid. No replacement AI request was authorized.");
    }
    // Older readings may have treated the second word as the XY release.
    if (PRISMATIC_EVOLUTIONS_TITLE.test(search) && !XY_EVOLUTIONS_TITLE.test(search) &&
        saved.sets.some(set => sameSetFamily("Evolutions", set))) return readSearchLocally(search);
    return cleanReading(saved, search);
}

// The AI's reading, checked and cleaned. Anything off falls back to "any".
export function cleanReading(reading: Reading, search: string): SearchIntent {
    const literal = readTitleByRules(search);
    // Older readers sometimes read the collector fraction 2/102 as a
    // reprint set name. Reuse the literal result and its marketplace words.
    if (literal.set === "Base Set" && literal.cardNumber?.includes("/") && sameCardNumber(literal.cardNumber, "2/102") &&
        reading.sets.some(set => sameSetFamily(set, "Base Set 2"))) return readSearchLocally(search);
    const typed = ` ${normalizeWords(search)} `;
    const explicitlyTyped = (value: string) => typed.includes(` ${normalizeWords(value)} `);
    // A model's guess about a number-only search must not reject every real
    // result. Only require card-name words the user actually typed.
    const cardName = reading.cardName?.trim() || null;
    const titleWords = (reading.titleWords ?? []).map((word) => normalizeText(word).trim())
        .filter((word) => word && explicitlyTyped(word) && !/^(cards?|holo|graded|better|psa|cgc|bgs|sgc|tag)$/.test(word)).slice(0, 2);
    const explicit = explicitCriteria(search);
    const printing = printingClaimFromText(search);
    const keywords = typeof reading.keywords === "string" && reading.keywords.trim() ? reading.keywords.trim().slice(0, 300) : fallbackKeywords(search);
    const keywordPrinting = printingClaimFromText(keywords);
    const keywordFinish = finishClaim(keywords);
    const grader = explicit.grader ?? (reading.grader && explicitlyTyped(reading.grader) ? reading.grader : null);
    const validGrade = (value: unknown): value is number => typeof value === "number" && value >= 1 && value <= 10 && Number.isInteger(value * 2);
    const withoutCardNumbers = search.replace(/\b\d{1,3}\s*\/\s*\d{1,3}\b/g, "");
    const hasGradeValue = /\b(?:10|[1-9](?:\.5)?|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(withoutCardNumbers);
    const gradeContext = hasGradeValue && /\b(?:psa|cgc|bgs|sgc|tag|grades?|graded)\b|\b(?:10|[1-9](?:\.5)?)\s*(?:\+|or (?:better|higher|above)|and up)/i.test(search);
    const minGrade = explicit.minGrade ?? (gradeContext && validGrade(reading.minGrade) ? reading.minGrade : null);
    const maxGrade = explicit.maxGrade ?? (gradeContext && validGrade(reading.maxGrade) ? reading.maxGrade : null);
    const graded = grader || minGrade !== null || maxGrade !== null ? true : /\b(raw|ungraded)\b/i.test(search) ? false : typeof reading.graded === "boolean" ? reading.graded : null;
    return {
        cardName: cardName && explicitlyTyped(cardName) ? cardName : null,
        sets: (reading.sets ?? []).map((set) => set.trim()).filter(Boolean),
        // A saved model interpretation is not a catalog authority. Retain
        // only the number actually typed, including partial/promo numbers.
        cardNumber: literal.cardNumber?.toUpperCase() ?? null,
        // Cached model guesses must not add or replace a printing constraint.
        printing: isPrinting(printing) ? printing : null,
        graded,
        grader,
        minGrade,
        maxGrade,
        finish: explicit.finish ?? null,
        // Saved discovery words cannot add a different printing or finish.
        keywords: (keywordPrinting === "NOT_STATED" || keywordPrinting === printing) &&
            (keywordFinish === "NOT_STATED" || keywordFinish === explicit.finish) ? keywords : fallbackKeywords(search),
        titleWords,
        source: "ai",
    };
}
