import { dollars } from "../../shared/format.ts";
import { SALES_ACTIVITY_DAYS } from "../../shared/sales-activity.ts";

export function resaleActivity(sales: readonly { at: number; price: number }[], now = Date.now()) {
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
    const week = sales.filter(sale => now - sale.at >= 0 && now - sale.at < 7 * 86_400_000);
    const weekDays = new Set(week.map(sale => Math.floor(sale.at / 86_400_000))).size;
    return { weekSales: week.length, weekDays, relativeSpread, count: sales.length, activeDays, perDay: sales.length / SALES_ACTIVITY_DAYS,
        low, high, priority };
}

export type ResaleActivity = NonNullable<ReturnType<typeof resaleActivity>>;

// A recent daily pace can establish demand even when a provider only returned part of the 60-day history.
export function liquidityIssue(activity: ResaleActivity | undefined): string | null {
    if (!activity || activity.weekDays < 2 || Math.max(activity.perDay, activity.weekSales / 7) < 1)
        return "The observed sales do not establish daily demand across multiple recent selling days.";
    if (activity.relativeSpread > 0.30)
        return "The middle half of matched sale prices spans more than 30% of the median.";
    return null;
}

export function activityDescription(activity: ResaleActivity) {
    const range = activity.count > 1 ? `The middle half sold for ${dollars(activity.low)}–${dollars(activity.high)}.`
        : "One observed price is too little to measure stability.";
    const week = `In the last 7 days, ${activity.weekSales} observed ${activity.weekSales === 1 ? "sale" : "sales"} on ${activity.weekDays} selling ${activity.weekDays === 1 ? "day" : "days"}.`;
    return `The sample averaged ${activity.perDay.toFixed(2)} sales per day over ${SALES_ACTIVITY_DAYS} days, with sales on ${activity.activeDays} distinct UTC ${activity.activeDays === 1 ? "day" : "days"}. ${week} ${range}`;
}
