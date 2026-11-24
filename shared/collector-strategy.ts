import type { CompSale } from "./types.ts";

export type CollectorCheck = "check_listing" | "check_sales" | "check_label";
export type CollectorStep = {
    action: CollectorCheck | "finish";
    reason: string;
    chosenBy: "model" | "required";
};

export interface CollectorStrategyReport {
    searchId: string;
    query: string;
    asOf: string;
    decision: "BUY" | "WAIT";
    reason: string;
    listing?: { title: string; url: string; price: number; shipping: number; total: number };
    market?: { estimate: number; count: number; fixedPriceSales: Pick<CompSale, "price" | "soldAt" | "url">[] };
    resaleProfit?: number;
    steps: CollectorStep[];
}

export interface CollectorStrategyState {
    available: boolean;
    report: CollectorStrategyReport | null;
}

export interface LiveCollectorReport {
    runId: string;
    sourceSearchId: string;
    checkedAt: string;
    maxTotal: number;
    decision: "BUY" | "WAIT";
    reason: string;
    fetched: number;
    candidates: number;
    withinBudgetAtScreening?: number;
    titleExclusions?: { listings: { id: string; title: string }[]; reason: string }[];
    steps: { listingId: string; title: string; reason: string; outcome: string }[];
    listing?: CollectorStrategyReport["listing"];
}
