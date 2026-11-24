import { cents } from "../../../shared/money/cents.ts";

// The asking price is a hypothetical exit. Costs are the seller's own terms.
export function cardmarketScenario(askEur: number, usdPerEur: number, purchaseUsd: number | null,
    feePercent: string, otherCostUsd: string) {
    if (purchaseUsd === null || !Number.isFinite(purchaseUsd) || purchaseUsd <= 0 ||
        !Number.isFinite(askEur) || askEur <= 0 || !Number.isFinite(usdPerEur) || usdPerEur <= 0 ||
        !feePercent.trim() || !otherCostUsd.trim()) return null;
    const percent = Number(feePercent), cost = Number(otherCostUsd);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100 ||
        !Number.isFinite(cost) || cost < 0 || cents(cost) / 100 !== cost) return null;
    const gross = cents(askEur * usdPerEur);
    const fee = cents((gross / 100) * (percent / 100));
    const net = gross - fee - cents(cost);
    const spread = net - cents(purchaseUsd);
    return Number.isSafeInteger(spread) ? { proceeds: net / 100, difference: spread / 100 } : null;
}
