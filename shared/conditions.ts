// Raw card conditions, best to worst.
export const RAW_CONDITIONS = [
    "MINT",
    "NEAR_MINT",
    "LIGHTLY_PLAYED",
    "MODERATELY_PLAYED",
    "HEAVILY_PLAYED",
    "DAMAGED",
] as const;

export type RawCondition = (typeof RAW_CONDITIONS)[number];

export const CONDITION_NAMES: Record<RawCondition, string> = {
    MINT: "Mint",
    NEAR_MINT: "Near Mint",
    LIGHTLY_PLAYED: "Lightly Played",
    MODERATELY_PLAYED: "Moderately Played",
    HEAVILY_PLAYED: "Heavily Played",
    DAMAGED: "Damaged",
};
export const CONDITION_DEFINITIONS: Record<RawCondition, string> = {
    MINT: "PSA 9 terminology. Virtually unworn with sharp corners and strong surface quality, allowing a very slight imperfection. Clear front, back, edge, corner and surface close-ups are required.",
    NEAR_MINT: "Very slight visible imperfections, with clean surfaces and largely sharp edges and corners; no creases, dents or structural damage.",
    LIGHTLY_PLAYED: "Minor edge or corner wear and light surface scratches, with no major defects or structural damage.",
    MODERATELY_PLAYED: "Noticeable wear across edges, corners or surface, beyond light play; no severe structural damage.",
    HEAVILY_PLAYED: "Extensive edge/corner wear, substantial scratching or scuffing, and major visible wear, without a defect that requires Damaged.",
    DAMAGED: "Creases, dents, tears, peeling, water damage, severe bends, permanent ink/marker marks, substantial staining or other material damage; visible material damage takes precedence over cleaner-looking areas.",
};
export const CONDITION_RULES_VERSION = 1;

export function isRawCondition(value: unknown): value is RawCondition {
    return RAW_CONDITIONS.includes(value as RawCondition);
}

// The four areas a grader judges.
export const CONDITION_AREAS = ["centering", "corners", "edges", "surface"] as const;

// Steps from one condition to another: positive when the second is worse.
export function conditionGap(from: RawCondition, to: RawCondition): number {
    return RAW_CONDITIONS.indexOf(to) - RAW_CONDITIONS.indexOf(from);
}

// eBay's card condition for a raw card ("Near mint or better",
// "Lightly played (Excellent)", ...), as a price condition.
const SELLER_CONDITIONS: [RegExp, RawCondition][] = [
    [/damaged/, "DAMAGED"],
    [/heavily played|\bpoor\b/, "HEAVILY_PLAYED"],
    [/moderately played|very good/, "MODERATELY_PLAYED"],
    [/lightly played|excellent/, "LIGHTLY_PLAYED"],
    [/near mint|\bnm\b/, "NEAR_MINT"],
    [/\bmint\b/, "MINT"],
];
export function claimedCondition(text: string | null | undefined): RawCondition | null {
    return SELLER_CONDITIONS.find(([pattern]) => pattern.test(String(text ?? "").toLowerCase()))?.[1] ?? null;
}

// With no condition given, assume the best.
export function sellerCondition(text: string | null | undefined): RawCondition {
    return claimedCondition(text) ?? "NEAR_MINT";
}

// Separate actual card disclosures from denials, hypotheticals and damage
// to the holder. The seller can describe both in the same sentence.
export function sellerDisclosedCreasing(notes: readonly string[] | undefined): boolean {
    return notes?.some(note => {
        if (/^(?:minor|moderate|major) creasing$/i.test(note.trim())) return true;
        if (!note.startsWith("Seller description: ")) return false;
        const clauses = note.slice("Seller description: ".length).split(/\b(?:but|however|whereas)\b|[,;]?\s+and\s+(?=(?:the|this)\s+(?:card|copy|sleeve|holder|case))/i);
        return clauses.some(clause => {
            const match = /\bcreas(?:e|es|ed|ing)\b/i.exec(clause);
            if (!match) return false;
            const before = clause.slice(0, match.index), after = clause.slice(match.index + match[0].length);
            if (/\b(?:no|not|without|none|never|nor|neither|free of|if|may|might|could|possibly|possible|check for|look for|inspect for)\b/i.test(before) ||
                /^[- ]free\b|^\s+(?:(?:is|are|was|were)\s+)?(?:absent|not (?:present|visible|seen|on the card))\b/i.test(after)) return false;
            if (/\b(?:sleeve|holder|case|top[ -]?loader|packaging)\s+(?:(?:has|had|is|was|shows?|with|a|the|visible|slight|minor|major)\s+)*$/i.test(before)) return false;
            return !/^\s+(?:on|in|of)\s+(?:the |a |its )?(?:sleeve|holder|case|top[ -]?loader|packaging)\b/i.test(after);
        });
    }) ?? false;
}

export function sellerCreaseOverridesCondition(photoCondition: RawCondition | "UNKNOWN", notes: readonly string[] | undefined): boolean {
    return photoCondition !== "DAMAGED" && sellerDisclosedCreasing(notes);
}
