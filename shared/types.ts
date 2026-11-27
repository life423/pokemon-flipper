export type BuyingOption = "AUCTION" | "FIXED_PRICE";
export interface Seller {
    username: string | null;
    feedbackPercentage: number | null;
    feedbackScore: number | null;
}

export type EbaySearchAllowance = { searchId: string; used: number } & (
    { limit: number; remaining: number; policy?: never; historicalLimit?: never } |
    { limit: null; remaining: null; policy: "daily-reserve"; historicalLimit: number | null }
);
// Today's eBay Browse allowance, from eBay's own count and local reservations.
export interface EbayUsage {
    searchBudget?: EbaySearchAllowance;
    used: number;
    limit: number;
    remaining: number;
    resetsAt: string | null;
    // In the last of the day's allowance: listings are checked from titles only.
    braking: boolean;
}
