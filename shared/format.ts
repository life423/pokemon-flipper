// Number formatting used on both the server and the page.

import type { BuyingOption, GradeRange } from "./types.ts";

const DASH = "\u2014";

const amount = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

// $1,234.56 or -$12.00; a dash when there's no number.
export function dollars(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return DASH;

    const text = amount.format(Math.abs(value));

    return value < 0 ? `-$${text}` : `$${text}`;
}

// 0.324 as 32%; a dash when there's no number.
export function percent(value: number | null | undefined): string {
    return value === null || value === undefined ? DASH : `${Math.round(value * 100)}%`;
}

// "6 to 8, likely 7", or "6 to 8" when no grade is likely.
export function describeRange({ low, likely, high }: GradeRange): string {
    return likely === null ? `${low} to ${high}` : `${low} to ${high}, likely ${likely}`;
}

// The most worth paying: a bid ceiling for an auction, a price ceiling
// for Buy It Now, where there's nothing to bid on.
export function ceilingLabel(buyingOption: BuyingOption): "Max bid" | "Max price" {
    return buyingOption === "AUCTION" ? "Max bid" : "Max price";
}

export function round2(value: number): number {
    return Math.round(value * 100) / 100;
}
