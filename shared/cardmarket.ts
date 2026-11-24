import type { Evaluation } from "./types.ts";

// An assessment can be revised in another tab while the buyer is viewing it.
export function cardmarketComparisonKey(value: Evaluation): string {
    const identity = value.identity, slab = value.slab;
    return JSON.stringify([value.listing.id, identity?.recordId, identity?.name, identity?.set, identity?.cardNumber,
        identity?.language, identity?.printing, identity?.finish, value.condition?.rawCondition, slab?.grader, slab?.grade,
        slab?.gradeQualifier, value.photoReviewKey]);
}

export interface CardmarketOffer {
    articleId: string;
    priceEur: number;
    updatedAt: string;
    condition: string | null;
    variant: string;
    grader: string | null;
    grade: string | null;
    sellerCountry: string | null;
}

export interface CardmarketComparison {
    status: "AVAILABLE" | "UNAVAILABLE";
    reason: string | null;
    checkedAt: string;
    currency: "EUR";
    basis: "ACTIVE_ASK";
    offers: CardmarketOffer[];
    fx?: { usdPerEur: number; date: string } | null;
}
