import type { RawCondition } from "../../shared/conditions.ts";

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
