export interface DailyPrice { day: string; price: number }
export interface MarketHistory {
    source: string; scope: string; points: DailyPrice[]; outlook: string; reason: string;
}
