// Number formatting used on both the server and the page.


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
