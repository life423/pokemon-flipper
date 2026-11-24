import type { DealHuntGoal, HuntMarketPreferences } from "./deal-hunt.ts";
import type { ListingFilters } from "./listing-filters.ts";
import type { SearchIntent } from "./types.ts";

export interface SearchPlanInput {
    query: string;
    filters?: ListingFilters;
}

export interface SearchPlan {
    workflow: "named_search" | "market_hunt";
    query: string;
    intent: SearchIntent;
    goal: DealHuntGoal | null;
    format: "FIXED_PRICE" | "AUCTION";
    marketPreferences: HuntMarketPreferences;
    minProfit: number | null;
    maxDelivered: number | null;
    summary: string;
}
