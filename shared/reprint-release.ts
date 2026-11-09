// Literal release names are cheap negative evidence for a vintage-only search.
// This does not verify the photograph or identify an exact anniversary market.
// A 2 followed by a collector-number denominator belongs to the card number.
// A slash before another full number can instead separate title fields.
export const BASE_SET_2_TITLE = /\bbase[\s-]+set[\s-]+(?:2(?!\s*\/\s*\d+[a-z]?\b(?!\s*\/))|ii)\b/i;

const RELEASES: readonly [RegExp, string][] = [
    [/\b30th[\s-]+(?:anniversary[\s-]+)?celebrations?\b/i, "30th Celebration"],
    [/\bcelebrations?\b/i, "Celebrations"],
    [/\bclassic[\s-]+collection\b/i, "Classic Collection"],
    [/\b(?:25th|30th)[\s-]+anniversary\b/i, "Anniversary reprint"],
    [BASE_SET_2_TITLE, "Base Set 2"],
    [/\bevolutions\b/i, "Evolutions"],
    [/\blegendary[\s-]+collection\b/i, "Legendary Collection"],
];

export function explicitReprintSet(title: string): string | null {
    return RELEASES.find(([pattern]) => pattern.test(title))?.[1] ?? null;
}

export function withoutReprintRelease(title: string): string {
    return RELEASES.reduce((text, [pattern]) => text.replace(pattern, " "), title);
}
