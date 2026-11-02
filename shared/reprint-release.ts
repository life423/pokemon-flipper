// Literal release names are cheap negative evidence for a vintage-only search.
// This does not verify the photograph or identify an exact anniversary market.
const RELEASES: readonly [RegExp, string][] = [
    [/\b30th[\s-]+(?:anniversary[\s-]+)?celebrations?\b/i, "30th Celebration"],
    [/\bcelebrations?\b/i, "Celebrations"],
    [/\bclassic[\s-]+collection\b/i, "Classic Collection"],
    [/\b(?:25th|30th)[\s-]+anniversary\b/i, "Anniversary reprint"],
    [/\bbase[\s-]+set[\s-]+2\b/i, "Base Set 2"],
    [/\bevolutions\b/i, "Evolutions"],
    [/\blegendary[\s-]+collection\b/i, "Legendary Collection"],
];

export function explicitReprintSet(title: string): string | null {
    return RELEASES.find(([pattern]) => pattern.test(title))?.[1] ?? null;
}

export function withoutReprintRelease(title: string): string {
    return RELEASES.reduce((text, [pattern]) => text.replace(pattern, " "), title);
}
