import type { RawCondition } from "./conditions.ts";
import type { Printing } from "./types.ts";

export interface TrackerRawReference {
    source: "TCGPLAYER_MARKET";
    tcgPlayerId: number;
    recordId: string;
    printing: Printing;
    finish: string;
    condition: RawCondition;
    priceUsd: number;
    updatedAt: string;
}

// A provider summary may be specific to one printing and grade. Individual
// transaction prices and formats still need separate evidence.
export interface TrackerPriceReference {
    source: "POKEMON_PRICE_TRACKER";
    tcgPlayerId: number;
    printingLabel?: string;
    gradedMarket: {
        grader: string;
        grade: string;
        priceUsd: number;
        statistic: "7_DAY_MEDIAN" | "HISTORICAL_MEDIAN";
        reportedSales: number;
        lastSaleAt: string;
        marketplaces: string[];
        filteredEstimate?: { priceUsd: number; days: number; confidence: string };
    };
    caveat: string;
}
