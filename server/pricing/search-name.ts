import { normalizeWords } from "../identity/card-identity.ts";

// Provider names such as Unown [A] do not contain the phrase "unown a".
// Search the species, then retain the required exact card-number check.
export function pricingSearchName(name: string): string {
    // PSA seller names often append the label's finish (PRIMEAPE-REVERSE
    // FOIL). That is a variant, not part of the species name. Exact set and
    // card-number selection still happens after this provider search.
    const words = normalizeWords(name)
        .replace(/\b(?:(?:reverse|rev|non)\s*)?(?:holo(?:graphic|foil)?|foil)\b/g, " ")
        .replace(/\s+/g, " ").trim();
    return /^unown\s+[a-z]$/.test(words) ? "unown" : words;
}
