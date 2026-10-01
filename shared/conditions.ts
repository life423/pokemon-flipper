// Raw card conditions, best to worst, as TCGplayer prices them.
export const RAW_CONDITIONS = [
    "NEAR_MINT",
    "LIGHTLY_PLAYED",
    "MODERATELY_PLAYED",
    "HEAVILY_PLAYED",
    "DAMAGED",
] as const;

export type RawCondition = (typeof RAW_CONDITIONS)[number];

export const CONDITION_NAMES: Record<RawCondition, string> = {
    NEAR_MINT: "Near Mint",
    LIGHTLY_PLAYED: "Lightly Played",
    MODERATELY_PLAYED: "Moderately Played",
    HEAVILY_PLAYED: "Heavily Played",
    DAMAGED: "Damaged",
};

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
    [/near mint|\bmint\b/, "NEAR_MINT"],
];

// With no condition given, assume the best.
export function sellerCondition(text: string | null | undefined): RawCondition {
    const value = String(text ?? "").toLowerCase();
    const found = SELLER_CONDITIONS.find(([pattern]) => pattern.test(value));

    return found ? found[1] : "NEAR_MINT";
}
