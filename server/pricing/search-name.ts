import { canonicalCatalogName } from "../identity/catalog-name.ts";

export { canonicalCatalogName, sameCatalogName } from "../identity/catalog-name.ts";

// Provider names such as Unown [A] do not contain the phrase "unown a".
// Search the species, then retain the required exact card-number check.
export function pricingSearchName(name: string): string {
    const words = canonicalCatalogName(name);
    return /^unown\s+[a-z]$/.test(words) ? "unown" : words;
}
