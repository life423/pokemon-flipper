import { setKey } from "./sets.ts";

// Literal release names are cheap negative evidence for a vintage-only search.
// This does not verify the photograph or identify an exact anniversary market.
// A 2 followed by a collector-number denominator belongs to the card number.
// A slash before another full number can instead separate title fields.
export const BASE_SET_2_TITLE = /\b(?:game[\s-]+)?base[\s-]+(?:set[\s-]+(?:2(?!\s*\/\s*\d+[a-z]?\b(?!\s*\/))|ii)|ii)\b/i;
export const PRISMATIC_EVOLUTIONS_TITLE = /\b(?:(?:sv|scarlet(?:\s*(?:&|and)\s*|\s+)violet)[\s:\p{Dash_Punctuation}]+)?prismatic[\s\p{Dash_Punctuation}]+evolutions\b/iu;
export const XY_EVOLUTIONS_TITLE = /\b(?:xy[\s:\p{Dash_Punctuation}]+)?(?<!\bprismatic[\s\p{Dash_Punctuation}]+)evolutions\b/iu;

const RELEASES: readonly [RegExp, string][] = [
    [/\b30th[\s-]+(?:anniversary[\s-]+)?celebrations?\b/i, "30th Celebration"],
    [/\bcelebrations?\b/i, "Celebrations"],
    [/\bclassic[\s-]+collection\b/i, "Classic Collection"],
    [/\b(?:25th|30th)[\s-]+anniversary\b/i, "Anniversary reprint"],
    [BASE_SET_2_TITLE, "Base Set 2"],
    [XY_EVOLUTIONS_TITLE, "Evolutions"],
    [/\blegendary[\s-]+collection\b/i, "Legendary Collection"],
];

export function explicitReprintSet(title: string): string | null {
    return RELEASES.find(([pattern]) => pattern.test(title))?.[1] ?? null;
}

export function withoutReprintRelease(title: string): string {
    return RELEASES.reduce((text, [pattern]) => text.replace(pattern, " "), title);
}

// The 1999–2000 Base Set run is a separate market from ordinary Unlimited.
export function hasBaseSetFourthPrint(set: string | null | undefined, ...claims: (string | null | undefined)[]): boolean {
    if (!set || setKey(set) !== "base set") return false;
    const fourthPrint = /\b((?:no|not|without)[\s-]+(?:(?:a|the)\s+)?)?(?:(?:4th|fourth|u\.?k\.?)[\s-]+print(?:ing)?|1999\s*[\p{Dash_Punctuation}/−]\s*(?:2000|00))\b/giu;
    return claims.some(claim => claim && [...claim.matchAll(fourthPrint)].some(([, negation]) => !negation));
}
