import type { SellingConfig } from "./config.ts";

// Money inputs and tax rates are decimal values. Convert their decimal spelling
// to a ratio before rounding, so e.g. $62 at 8.25% costs $67.12, not $67.11
// because a binary intermediate landed just below the half-cent boundary.
type Decimal = { numerator: bigint; denominator: bigint };

function decimal(value: number): Decimal | null {
    if (!Number.isFinite(value)) return null;
    const [coefficient, exponent = "0"] = String(value).split("e");
    const places = (coefficient.split(".")[1]?.length ?? 0) - Number(exponent);
    const numerator = BigInt(coefficient.replace(".", ""));
    return places >= 0
        ? { numerator, denominator: 10n ** BigInt(places) }
        : { numerator: numerator * 10n ** BigInt(-places), denominator: 1n };
}

function roundedRatio(numerator: bigint, denominator: bigint): bigint {
    const sign = numerator < 0n ? -1n : 1n;
    const magnitude = numerator < 0n ? -numerator : numerator;
    return sign * ((magnitude + denominator / 2n) / denominator);
}

function safeCents(value: bigint): number {
    const result = Number(value);
    return Number.isSafeInteger(result) ? result : NaN;
}

export function cents(value: number): number {
    const ratio = decimal(value);
    return ratio ? safeCents(roundedRatio(ratio.numerator * 100n, ratio.denominator)) : NaN;
}

export function money(value: number): number {
    return cents(value) / 100;
}

export function taxedCents(taxable: number, rate: number): number {
    const ratio = decimal(rate);
    if (!Number.isSafeInteger(taxable) || taxable < 0 || !ratio || rate < 0) return NaN;
    const amount = BigInt(taxable);
    return safeCents(amount + roundedRatio(amount * ratio.numerator, ratio.denominator));
}

export function meetsMoneyTargets(net: number, cost: number, minProfit: number, minRoi: number): boolean {
    const profitTarget = decimal(minProfit);
    const roiTarget = decimal(minRoi);
    if (!Number.isSafeInteger(net) || !Number.isSafeInteger(cost) || cost < 0 ||
        !profitTarget || !roiTarget || minProfit < 0 || minRoi < 0) return false;
    const profit = BigInt(net) - BigInt(cost);
    return profit * profitTarget.denominator >= profitTarget.numerator * 100n &&
        profit * roiTarget.denominator >= BigInt(cost) * roiTarget.numerator;
}

// Keep the tax-inclusive fee base and each tier/ad component exact until the
// configured aggregate fee is rounded once. Rounding a binary product only at
// the end is insufficient: $157.50 x 1.10 x 10% + $0.40 is exactly $17.725.
export function sellingFeeCents(salePrice: number, selling: SellingConfig): number {
    const values = [salePrice, selling.typicalBuyerTaxRate, selling.finalValueTierLimit,
        selling.finalValueRate, selling.finalValueRateAboveLimit, selling.perOrderFee,
        selling.perOrderFeeSmall, selling.smallOrderLimit, selling.promotedRate];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) return NaN;
    const [price, tax, cap, rate, aboveRate, order, smallOrder, smallLimit, promoted] = values.map((value) => decimal(value)!);
    const base = { numerator: price.numerator * (tax.denominator + tax.numerator), denominator: price.denominator * tax.denominator };
    const belowCap = base.numerator * cap.denominator <= cap.numerator * base.denominator;
    const lower = belowCap ? base : cap;
    const higher = belowCap ? { numerator: 0n, denominator: 1n } : {
        numerator: base.numerator * cap.denominator - cap.numerator * base.denominator,
        denominator: base.denominator * cap.denominator,
    };
    const perOrder = base.numerator * smallLimit.denominator <= smallLimit.numerator * base.denominator ? smallOrder : order;
    const fees = [
        { numerator: lower.numerator * rate.numerator, denominator: lower.denominator * rate.denominator },
        { numerator: higher.numerator * aboveRate.numerator, denominator: higher.denominator * aboveRate.denominator },
        perOrder,
        { numerator: base.numerator * promoted.numerator, denominator: base.denominator * promoted.denominator },
    ];
    let total: Decimal = { numerator: 0n, denominator: 1n };
    for (const fee of fees) total = {
        numerator: total.numerator * fee.denominator + fee.numerator * total.denominator,
        denominator: total.denominator * fee.denominator,
    };
    return safeCents(roundedRatio(total.numerator * 100n, total.denominator));
}
