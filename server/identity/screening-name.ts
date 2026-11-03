import { normalizeWords } from "./card-identity.ts";

// These are listing metadata, never an invitation to match a shorter species
// name. In particular, printed prefixes/suffixes and owners are not stop words.
const BOILERPLATE = /\b(?:wizards(?:\s+of\s+the\s+coast)?|light[ -]play|swirl|mitsuhiro\s+arita|arita)\b(?!['’])/gi;
const GRADER = "(?:psa|cgc|bgs|sgc|tag)";
const GRADE = "(?:10|[1-9](?:\\.5)?)(?![\\d./])";
const DESCRIPTION = "(?:near[ -]+mint(?:[ -]+to[ -]+mint)?|gem[ -]+(?:mint|mt)|nm[ -]+(?:mint|mt)|ex[ -]+mt|vg[ -]+ex|very[ -]+good|excellent|pristine|mint|good|poor|fair|nm|ex|mt|vg)";
const GRADE_SPAN = new RegExp(`\\b${GRADER}\\s*(?:${DESCRIPTION}[ -]+)*${GRADE}(?:[ -]+(${DESCRIPTION}))?`, "gi");

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

function cleanedClaim(claim: string, title: string): string {
    let value = claim.replace(BOILERPLATE, " ");
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
    if (!names.length || names.some(name => !screeningNameKey(name))) return null;
    const key = screeningNameKey(names[0]);
    if (names.some(name => screeningNameKey(name) !== key)) return null;
    return candidate?.trim() && screeningNameKey(candidate) === key ? candidate.trim() : names[0];
}
