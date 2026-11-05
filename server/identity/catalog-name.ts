import { normalizeText } from "../ebay/filters.ts";

// Catalog artwork/finish labels describe a numbered card rather than changing
// its printed name. Keep this suffix list explicit: unknown residual words,
// owners and forms must still fail an exact comparison.
const DESCRIPTIVE_SUFFIX = /(?:^|\s)(?:(?:(?:reverse|rev|non)\s*)?(?:holo(?:graphic|foil)?|foil)|(?:alternate|alt)(?:\s+full)?\s+art|full\s+art)$/;
// PKMNPrices appends these rarity/artwork labels to numbered modern cards.
// Require the parenthetical catalog suffix: an unbracketed Secret or other
// unknown wording may belong to the printed name and must stay distinct.
const CATALOG_RARITY_SUFFIX = /\s+\((?:(?:(?:alternate|alt)(?:\s+full)?\s+art\s+)?secret|secret\s+shining)\)\s*$/i;

export function canonicalCatalogName(value: unknown): string {
    let name = normalizeText(String(value ?? "").replace(CATALOG_RARITY_SUFFIX, "").replace(/[‘’]/g, "'")
        .replace(/♀/g, " female ").replace(/♂/g, " male ")
        .replace(/[★☆]/g, " star ").replace(/δ/gi, " delta "))
        // Apostrophes are part of printed owners and names, including
        // Blaine's Arcanine and Farfetch'd. Other punctuation is spacing.
        .replace(/[^a-z0-9']+/g, " ").trim();
    for (;;) {
        const shorter = name.replace(DESCRIPTIVE_SUFFIX, "").trim();
        if (shorter === name) return name;
        name = shorter;
    }
}

export function sameCatalogName(left: unknown, right: unknown): boolean {
    const name = canonicalCatalogName(left);
    return Boolean(name) && name === canonicalCatalogName(right);
}
