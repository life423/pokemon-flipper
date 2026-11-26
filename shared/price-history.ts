export interface DailyPrice { day: string; price: number }
export interface MarketHistory {
    source: string; scope: string; points: DailyPrice[]; outlook: string; reason: string;
}

export function observedPriceChange(points: readonly DailyPrice[]) {
    if (points.length < 2) return null;
    const first = points[0], last = points[points.length - 1];
    if (!(first.price > 0 && last.price > 0 && first.day < last.day)) return null;
    const delta = (Math.round(last.price * 100) - Math.round(first.price * 100)) / 100;
    return { delta, percent: 100 * delta / first.price };
}
