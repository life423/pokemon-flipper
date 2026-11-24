export interface WebPriceResearch {
    checkedAt: string;
    market?: { cardName: string; setName: string; cardNumber: string; printingLabel: string; finish?: string; language: string; grader: string; grade: string };
    observations: {
        title: string;
        kind: "SOLD" | "ASK";
        priceUsd: number;
        date: string | null;
        url: string;
    }[];
}
