import { dollars } from "../../shared/format.ts";
import { SALES_ACTIVITY_DAYS } from "../../shared/sales-activity.ts";

export function resaleActivity(sales: readonly { at: number; price: number }[]) {
    if (!sales.length) return undefined;
    const prices = sales.map(s => s.price).sort((a, b) => a - b);
    const activeDays = new Set(sales.map(s => Math.floor(s.at / 86_400_000))).size;
    // Interpolated quartiles resist an isolated high sale. A single price has no measurable spread.
    const quantile = (q: number) => {
        const pos = (prices.length - 1) * q;
        return prices[Math.floor(pos)] + (prices[Math.ceil(pos)] - prices[Math.floor(pos)]) * (pos % 1);
    };
    const low = quantile(0.25), high = quantile(0.75);
    const relativeSpread = (high - low) / quantile(0.5);
    // Research ordering only. Repeated selling days and tighter matched prices improve priority.
    const priority = sales.length * activeDays / SALES_ACTIVITY_DAYS / (1 + relativeSpread);
    return { count: sales.length, activeDays, perDay: sales.length / SALES_ACTIVITY_DAYS,
        low, high, priority };
}

export type ResaleActivity = NonNullable<ReturnType<typeof resaleActivity>>;

export function activityDescription(activity: ResaleActivity) {
    const range = activity.count > 1 ? `The middle half sold for ${dollars(activity.low)}–${dollars(activity.high)}.`
        : "One observed price is too little to measure stability.";
    return `The sample averaged ${activity.perDay.toFixed(2)} sales per day over ${SALES_ACTIVITY_DAYS} days, with sales on ${activity.activeDays} distinct UTC ${activity.activeDays === 1 ? "day" : "days"}. ${range}`;
}
