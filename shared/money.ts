// Existing purchase-tax assumption, preserved for the sniper estimate.
export interface BuyingConfig { salesTaxRate: number }
export const MONEY_CONFIG = { buying: { salesTaxRate: 0.0825 } };


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

export function acquisitionCost(price: number, shipping: number, buying: BuyingConfig): number {
    if (price < 0 || shipping < 0) return NaN;
    return taxedCents(cents(price) + cents(shipping), buying.salesTaxRate) / 100;
}
