import { MODEL } from "./openai.ts";
import { readCache, readCacheMany } from "../lib/cache.ts";
import { exclusionReason, normalizeText, withoutAccompanyingCustomHolder } from "../ebay/filters.ts";
import { searchAttributes } from "../../shared/search-criteria.ts";
import { cardLanguageStatus } from "../../shared/card-language.ts";
import { StorageUnavailableError } from "../storage/index.ts";
import { explicitReprintSet, PRISMATIC_EVOLUTIONS_TITLE, withoutReprintRelease } from "../../shared/reprint-release.ts";
import { rawConditionClaim } from "../../shared/raw-condition-claim.ts";
import { CONDITION_NAMES } from "../../shared/conditions.ts";
import { GALLERY_TITLE, hasGalleryNumber, stripListingNameBoilerplate } from "../identity/screening-name.ts";
import { setKey } from "../../shared/sets.ts";
import { cardNumberIn, sameSetFamily } from "../identity/card-identity.ts";
import { cachedSetNames } from "../search/set-catalog.ts";

// Many sellers leave the set, number, or name out of the item details
// but put them in the title ("CHARIZARD 1999 POKEMON BASE SET 4/102").
// Literal parsing and saved readings describe the seller's claims.
// Identity rules and photos check the actual card.

const READER_VERSION = 6;
const MONTH_HOURS = 24 * 30;

const LISTING_KINDS = ["SINGLE_CARD", "LOT", "SEALED", "MERCH", "MYSTERY", "FAKE", "NOT_A_CARD"] as const;

export interface TitleReading {
    // What the listing sells: one card, or something else (junk here).
    kind: (typeof LISTING_KINDS)[number] | null;
    cardName: string | null;
    set: string | null;
    cardNumber: string | null;
    language: string | null;
    grader: string | null;
    grade: string | null;
    // The condition a raw card's title claims, like "Lightly Played".
    condition: string | null;
}

const cacheKey = (title: string) => `title-reading:v${READER_VERSION}:${MODEL}:${normalizeText(title).trim()}`;

// These are literal phrases, not a complete catalog or a number-to-set lookup.
// Unrecognized sets and names remain unresolved for the actual photo assessment.
const LITERAL_SETS = ["Crown Zenith Galarian Gallery", "Scarlet & Violet 151", "Neo Revelation", "Neo Discovery", "Gym Challenge", "Evolving Skies", "Brilliant Stars", "Lost Origin", "Team Rocket", "Neo Genesis", "Neo Destiny", "Gym Heroes", "Crown Zenith", "Legendary Collection", "Celebrations", "Aquapolis", "Expedition", "Skyridge", "Fossil", "Jungle", "Base Set"];
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function literalSet(title: string, knownSetNames: readonly string[]) {
    const explicit = explicitReprintSet(title);
    if (!explicit && PRISMATIC_EVOLUTIONS_TITLE.test(title)) {
        return { set: "Prismatic Evolutions", pattern: new RegExp(PRISMATIC_EVOLUTIONS_TITLE, "igu") };
    }
    const gallery = !explicit && hasGalleryNumber(title) && new RegExp(GALLERY_TITLE, "i").test(title)
        ? { set: "Crown Zenith Galarian Gallery", pattern: new RegExp(GALLERY_TITLE, "ig") } : null;
    const names = explicit ? [explicit] : [...LITERAL_SETS, ...knownSetNames].sort((a, b) => setKey(b).length - setKey(a).length);
    for (const set of names) {
        const key = setKey(set);
        // Even a catalog name must use the explicit reprint check for this set.
        if (!key || !explicit && key === "base set 2") continue;
        const pattern = new RegExp(`\\b${key.split(" ").map(escapePattern).join("[^a-z0-9]+")}\\b`, "ig");
        if (explicit || pattern.test(normalizeText(title))) return { set, pattern };
    }
    return gallery;
}
export function readTitleByRules(title: string, knownSetNames: readonly string[] = []): TitleReading {
    const attributes = searchAttributes(title);
    const matchedSet = literalSet(title, knownSetNames);
    const set = matchedSet?.set ?? null;
    const withoutRelease = withoutReprintRelease(title);
    const number = cardNumberIn(withoutRelease);
    const language = cardLanguageStatus(title);
    const excluded = exclusionReason({ title, itemId: "local-title|0" });
    // Preserve this reader's Excellent->LP and Mint->NM vocabulary while
    // sharing the ambiguity/HP-stat rules with sold-title screening.
    const claim = rawConditionClaim(title.replace(/\bexcellent\b/gi, "Lightly Played"));
    const condition = claim ? CONDITION_NAMES[claim === "MINT" ? "NEAR_MINT" : claim] : null;
    // Only use a compact literal name after removing explicit metadata. This
    // does not claim that an unknown phrase is a canonical Pokemon identity.
    const name = withoutAccompanyingCustomHolder(stripListingNameBoilerplate(withoutRelease, title, set))
        .replace(matchedSet?.pattern ?? /$^/, " ")
        .replace(number ? new RegExp(number.split("/").map(escapePattern).join("\\s*/\\s*"), "ig") : /$^/, " ")
        .replace(/\b(?:psa|cgc|bgs|sgc|tag)\s*(?:[-–—]\s*)?(?:(?:gem|mint|mt|nm|near|ex|excellent|vg|very|good|poor|fair|pristine|black|label)[ -]+){0,5}(?:10|[1-9](?:\.5)?)?\b/ig, " ")
        .replace(/\b(?:pokemon|pok[eé]mon|tcg|cards?|english|eng|en|holo(?:graphic)?|non[ -]?holo|reverse|rare|ultra|secret|unlimited|shadowless|first edition|1st edition|wotc|vintage|raw|ungraded|graded|near mint|lightly played|moderately played|heavily played|damaged|mint|nm|lp|mp|hp|dmg|excellent|condition|collection|collectible|collectibles|promos?|with|from|the|for|please|show me|find me|looking for|i want|some|any|all)\b/ig, " ")
        .replace(/\b(?:19|20)\d{2}\b|\b\d+(?:\.\d+)?\b|[#|,;:()[\]]/g, " ")
        .replace(/(?:^|\s)[-–—/]+(?=\s|$)/g, " ")
        .replace(/\s+/g, " ").trim();
    const nameWords = name.split(" ");
    // Numbered printed names such as Origin Forme Dialga VSTAR need four
    // words. Keep unnumbered prose conservative; the catalog still decides
    // whether this complete literal name and number identify a market.
    const cardName = !excluded && name && (nameWords.length <= 3 || nameWords.length === 4 && number !== null) && /^[a-z][a-z '.-]*$/i.test(name) && !/\b(?:would|like|best|better|higher|above|below|under|over|between|holos|deals?|search|selling|sale|lot|lots)\b/i.test(name) ? name : null;
    return { kind: excluded ? "NOT_A_CARD" : null, cardName, set, cardNumber: number, language: language === "OTHER" ? "Other" : language === "ENGLISH" ? "English" : null,
        grader: attributes.grader, grade: attributes.grade === null ? null : String(attributes.grade), condition };
}

// Reuse legacy title evidence when available and otherwise read the literal title.
function retainedTitleReading(title: string, saved: TitleReading | null): TitleReading | null {
    if (saved) {
        if (typeof saved !== "object" || saved.kind !== null && !LISTING_KINDS.includes(saved.kind) ||
            ["cardName", "set", "cardNumber", "language", "grader", "grade", "condition"].some(field => saved[field as keyof TitleReading] !== null && typeof saved[field as keyof TitleReading] !== "string")) {
            throw new StorageUnavailableError("The saved title reading is invalid. No replacement AI title request was authorized.");
        }
        // A literal incompatible release must not disappear because an older
        // title reading copied the seller's incorrect Base Set specifics.
        const explicitSet = explicitReprintSet(title);
        if (explicitSet) return { ...saved, set: explicitSet };
        if (PRISMATIC_EVOLUTIONS_TITLE.test(title) && sameSetFamily("Evolutions", saved.set)) {
            const literal = readTitleByRules(title);
            return { ...saved, set: literal.set, cardName: literal.cardName };
        }
        if (saved.set && setKey(saved.set) === "base set 2" && cardNumberIn(title) === "2/102" && literalSet(title, [])?.set === "Base Set") {
            return { ...saved, set: "Base Set", cardNumber: "2/102" };
        }
        return saved;
    }
    return null;
}

export async function readTitleWithoutAi(title: string, signal?: AbortSignal): Promise<TitleReading> {
    signal?.throwIfAborted();
    const saved = retainedTitleReading(title, await readCache<TitleReading>(cacheKey(title), MONTH_HOURS));
    signal?.throwIfAborted();
    if (saved) return saved;
    const knownSetNames = await cachedSetNames();
    signal?.throwIfAborted();
    return readTitleByRules(title, knownSetNames);
}

// A source page can contain hundreds of distinct titles. Reuse their accepted
// readings in one storage operation before applying the same literal fallbacks.
export async function readTitlesWithoutAi(titles: string[], signal?: AbortSignal): Promise<Map<string, TitleReading>> {
    signal?.throwIfAborted();
    const distinct = [...new Set(titles)];
    const saved = await readCacheMany<TitleReading>(distinct.map(cacheKey), MONTH_HOURS);
    signal?.throwIfAborted();
    const retained = distinct.map((title, index) => retainedTitleReading(title, saved[index]));
    const knownSetNames = retained.some(reading => reading === null) ? await cachedSetNames() : [];
    signal?.throwIfAborted();
    return new Map(distinct.map((title, index) => [title, retained[index] ?? readTitleByRules(title, knownSetNames)]));
}
