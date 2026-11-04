import { normalizeWords } from "./card-identity.ts";
import { canonicalCatalogName, sameCatalogName } from "./catalog-name.ts";

// These are listing metadata, never an invitation to match a shorter species
// name. In particular, printed prefixes/suffixes and owners are not stop words.
const BOILERPLATE = /\b(?:wizards(?:\s+of\s+(?:the\s+)?coast)?|(?:the\s+)?pok[eé]mon\s+company|light[ -]play|(?:partial\s+)?swirl|mitsuhiro\s+arita|arita)\b(?!['’])/gi;
const GRADER = "(?:psa|cgc|bgs|sgc|tag)";
const GRADE = "(?:10|[1-9](?:\\.5)?)(?![\\d./])";
const DESCRIPTION = "(?:near[ -]+mint(?:[ -]+to[ -]+mint)?|gem[ -]+(?:mint|mt)|nm[ -]+(?:mint|mt)|ex[ -]+mt|vg[ -]+ex|very[ -]+good|excellent|pristine|mint|good|poor|fair|nm|ex|mt|vg)";
const GRADE_SPAN = new RegExp(`\\b${GRADER}\\s*(?:[-–—]\\s*)?(?:${DESCRIPTION}[ -]+)*${GRADE}(?:[ -]+(${DESCRIPTION}))?`, "gi");
const BEFORE_GRADE_GEM = new RegExp(`\\bgem[ -]+(?:mint|mt)(?=\\s+${GRADER}\\s*(?:[-–—]\\s*)?${GRADE})`, "gi");
const INCLUDED_HOLDER_SUFFIX = /\s+(?:with|w\s*\/|includes?|including)\s+(?:(?:a|an|the)\s+)?(?:(?:protective|protection|magnetic|acrylic|hard|fitted|display|slab)\s+)*(?:guards?|cases?|holders?|sleeves?|top[ -]?loaders?)\s*[.!]?\s*$/i;
const GRADED_ARTIST_SUFFIX = /\s+(?:kagemaru\s+)?himeno\s*$/i;
const ART_DESCRIPTION = /\b(?:(?:alternate|alt)(?:[\s/-]+full)?[\s-]+art|full(?:[\s/-]+(?:alternate|alt))?[\s-]+art|(?:special[\s-]+)?illustration[\s-]+rare)\b(?!['’])(?:\s*\/\s*)?/gi;
// These release codes are publisher metadata only beside the corresponding
// written release and an explicit collector fraction, never a promo number.
const SWORD_SHIELD_RELEASES: [RegExp, RegExp][] = [
    [/\bevolving\s+skies\b/i, /\bswsh07\b(?![\w.'’])/gi],
    [/\bfusion\s+strike\b/i, /\bswsh08\b(?![\w.'’])/gi],
    [/\bbrilliant\s+stars\b/i, /\bswsh09\b(?![\w.'’])/gi],
    [/\blost\s+origin\b/i, /\bswsh11\b(?![\w.'’])/gi],
    [/\bcrown\s+zenith(?:\s+galarian\s+gallery)?\b/i, /\bswsh12\.5\b(?![\w.'’])/gi],
];

// normalizeWords normally discards symbols. Gender and these printed forms
// distinguish cards, so preserve them even when a catalog uses Unicode glyphs.
export function screeningNameKey(value: string): string {
    return normalizeWords(value.replace(/♀/g, " female ").replace(/♂/g, " male ")
        .replace(/[★☆]/g, " star ").replace(/δ/gi, " delta "));
}

function removeLastWord(value: string, word: string): string {
    const pattern = new RegExp(`\\b${word}\\b(?!['’])`, "gi");
    const last = [...value.matchAll(pattern)].at(-1);
    return last?.index === undefined ? value : value.slice(0, last.index) + " " + value.slice(last.index + last[0].length);
}

function removeObservedWords(value: string, match: RegExpMatchArray, title: string): string {
    const outside = title.slice(0, match.index) + title.slice((match.index ?? 0) + match[0].length);
    for (const word of screeningNameKey(match[0]).split(" ").filter(Boolean).reverse()) {
        const occurrences = (text: string) => [...text.matchAll(new RegExp(`\\b${word}\\b(?!['’])`, "gi"))].length;
        if (occurrences(value) > occurrences(outside)) value = removeLastWord(value, word);
    }
    return value;
}

// Clean only the input used to extract/reconcile a name. All exclusion and
// printing/finish/grade readers still inspect the untouched seller title.
// A holder is metadata only when explicitly accompanying a numerically graded
// slab; an unanchored Guard/name fragment must never disappear.
export function stripListingNameBoilerplate(value: string, title = value): string {
    let cleaned = value.replace(/[‘’]/g, "'").replace(BOILERPLATE, " ").replace(ART_DESCRIPTION, " ");
    // Earlier saved readings may retain only "full" from "Full Alt Art".
    // Remove only excess words witnessed in the original metadata span.
    for (const match of title.matchAll(ART_DESCRIPTION)) cleaned = removeObservedWords(cleaned, match, title);
    // A complete grade descriptor may precede the grader. Remove only its
    // observed excess words, including residual "gem" in older name readings.
    for (const match of title.matchAll(BEFORE_GRADE_GEM)) cleaned = removeObservedWords(cleaned, match, title);
    const graded = new RegExp(GRADE_SPAN.source, "i").test(title);
    if (/\b[a-z]{0,5}\d{1,4}[a-z]?\s*\/\s*[a-z]{0,5}\d{1,4}[a-z]?\b/i.test(title)) {
        const release = SWORD_SHIELD_RELEASES.find(([set]) => set.test(title));
        if (release) cleaned = cleaned.replace(/\b(?:sword\s*(?:&|and)\s*shield|swsh)\b(?!['’])/gi, " ").replace(release[1], " ");
        // Abbreviations require a written release and a numeric slab label.
        // They never erase an unanchored name or a promo/partial number.
        const scarletViolet = /\bscarlet\s*(?:&|and)?\s*violet\b/i.test(title);
        const descriptions = graded ? [
            ...(release || scarletViolet ? [/\bFA\b(?!['’])(?:\s*\/\s*)?/gi] : []),
            ...(scarletViolet ? [/\bSIR\b(?!['’])(?:\s*\/\s*)?/gi, /\bSV\b(?!['’])(?=\s*:?\s*Scarlet\s*(?:&|and)?\s*Violet\b)/gi] : []),
        ] : [];
        for (const description of descriptions) {
            const observed = [...title.matchAll(description)];
            if (observed.length) cleaned = cleaned.replace(description, " ");
            for (const match of observed) cleaned = removeObservedWords(cleaned, match, title);
        }
    }
    const artist = graded ? title.match(GRADED_ARTIST_SUFFIX) : null;
    if (artist) cleaned = removeObservedWords(cleaned, artist, title);
    const suffix = title.match(INCLUDED_HOLDER_SUFFIX);
    if (!suffix || !graded) return cleaned;
    if (INCLUDED_HOLDER_SUFFIX.test(cleaned)) return cleaned.replace(INCLUDED_HOLDER_SUFFIX, " ");
    // Earlier literal readings may have removed "with" already. Remove only
    // excess source-observed suffix words, keeping any occurrences belonging
    // to the printed name (e.g. a name containing Guard).
    return removeObservedWords(cleaned, suffix, title);
}

function cleanedClaim(claim: string, title: string): string {
    let value = stripListingNameBoilerplate(claim, title);
    const outsideGrades = title.replace(GRADE_SPAN, " ");
    // The literal reader already removes the grader/number, but post-grade
    // descriptors can survive as "ex-mt" or "-mt". Remove just those observed
    // descriptor occurrences, from the right: Charizard ex PSA 5 EX must keep
    // the card's first "ex". An unanchored EX is always part of the name.
    for (const match of title.matchAll(GRADE_SPAN)) {
        for (const word of screeningNameKey(match[1] ?? "").split(" ").filter(Boolean).reverse()) {
            const occurrences = (text: string) => [...text.matchAll(new RegExp(`\\b${word}\\b(?!['’])`, "gi"))].length;
            if (occurrences(value) > occurrences(outsideGrades)) value = removeLastWord(value, word);
        }
    }
    if (new RegExp(`\\b${GRADER}\\b`, "i").test(title)) {
        for (const match of title.matchAll(new RegExp(`\\b(centering|corners|edges|surface)\\s*${GRADE}`, "gi"))) {
            value = removeLastWord(value, match[1]);
        }
    }
    // These words have specific publisher/set context in the full title;
    // they are not globally removed from arbitrary printed card names.
    if (/\bpok[eé]mon\s+game\b/i.test(title)) value = value.replace(/\bgame\b(?!['’])/gi, " ");
    if (/\bunlimited\s+set\b/i.test(title)) value = value.replace(/\bset\b(?!['’])/gi, " ");
    // A residual "edition" or rarity "R" is metadata only when its source
    // title supplies the matching phrase. Keep unanchored letters (Unown R)
    // and any separate occurrence belonging to the printed name.
    const descriptors = /\b(?:(?:unlimited|first|1st|shadowless)\s+(edition)|(?:holo(?:graphic|foil)?|foil|rare)\s+(r)|(partial)\s+swirl|(?:the\s+)?pok[eé]mon\s+(company))\b(?!['’])/gi;
    const outsideDescriptors = title.replace(descriptors, " ");
    for (const match of title.matchAll(descriptors)) {
        const word = match[1] ?? match[2] ?? match[3] ?? match[4];
        const occurrences = (text: string) => [...text.matchAll(new RegExp(`\\b${word}\\b(?!['’])`, "gi"))].length;
        if (occurrences(value) > occurrences(outsideDescriptors)) value = removeLastWord(value, word);
    }
    return value.replace(/(^|\s)[–—-]+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
}

// A pure research-target resolver. It does not establish photo identity,
// infer a card number/set, or coerce Dark/EX/etc. into the searched species.
// Unknown residual words remain in the name and still require an exact catalog
// match. Conflicting claims stay unresolved rather than borrowing the intent.
export function resolveScreeningName({ title, claims, candidate }: {
    title: string;
    claims: readonly (string | null | undefined)[];
    candidate?: string | null;
}): string | null {
    const names = claims.filter((value): value is string => Boolean(value?.trim())).map(value => cleanedClaim(value, title));
    if (!names.length || names.some(name => !canonicalCatalogName(name))) return null;
    if (names.some(name => !sameCatalogName(name, names[0]))) return null;
    return candidate?.trim() && sameCatalogName(candidate, names[0]) ? candidate.trim() : names[0];
}
