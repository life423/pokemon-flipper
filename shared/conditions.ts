// Raw card conditions, best to worst, as TCGplayer prices them.
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
    DAMAGED: "Creases, dents, tears, peeling, water damage, severe bends or other structural damage; visible structural damage takes precedence over cleaner-looking areas.",
};
export const CONDITION_RULES_VERSION = 1;

export function isRawCondition(value: unknown): value is RawCondition {
    return RAW_CONDITIONS.includes(value as RawCondition);
}

// The four areas a grader judges.
export const CONDITION_AREAS = ["centering", "corners", "edges", "surface"] as const;

export type ConditionArea = (typeof CONDITION_AREAS)[number];

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
