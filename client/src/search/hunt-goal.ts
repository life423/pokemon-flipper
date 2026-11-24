import type { HuntMarketPreferences } from "../../../shared/deal-hunt.ts";

export interface HuntGoalPrompt {
    marketPreferences: HuntMarketPreferences;
    minProfit?: number;
    goal?: "collect_slab" | "grade_raw";
    maxDelivered?: number;
    listingFormat?: "FIXED_PRICE" | "AUCTION";
}
