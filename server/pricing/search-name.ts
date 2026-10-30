import { normalizeWords } from "../identity/card-identity.ts";

// Provider names such as Unown [A] do not contain the phrase "unown a".
// Search the species, then retain the required exact card-number check.
export function pricingSearchName(name: string): string {
    const words = normalizeWords(name).replace(/\bholo\b/g, "").trim();
    return /^unown\s+[a-z]$/.test(words) ? "unown" : words;
}
