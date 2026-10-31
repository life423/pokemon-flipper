export type FinishClaim = "HOLO" | "REVERSE_HOLO" | "NON_HOLO" | "NOT_STATED" | "CONFLICTING";

// One vocabulary for search, item specifics, slab labels and valuation.
// Consume "reverse holo" as one token, not two conflicting finishes.
export function finishClaim(text: unknown): FinishClaim {
    const value = String(text ?? "").normalize("NFKC").toLowerCase().replace(/[_.–—]/g, " ");
    if (/^\s*(regular|normal)\s*$/.test(value)) return "NON_HOLO";
    const foil = "(?:holo(?:graphic|foil)?s?|foils?)";
    const tokens = value.match(new RegExp(`\\b(?:non[\\s-]*${foil}|(?:reverse|rev)[\\s-]*(?:${foil})?|rh|${foil})\\b`, "g")) ?? [];
    const finishes = new Set(tokens.map(token => /^non/.test(token) ? "NON_HOLO" as const : /^(reverse|rev|rh)/.test(token) ? "REVERSE_HOLO" as const : "HOLO" as const));
    return finishes.size > 1 ? "CONFLICTING" : [...finishes][0] ?? "NOT_STATED";
}
