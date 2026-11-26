import test from "node:test";
import assert from "node:assert/strict";
import { activityDescription, resaleActivity } from "../../server/analysis/resale-activity.ts";
import { liquidMarkets, rankCatalogMarkets } from "../../server/pricing/liquid-markets.ts";

test("steady selling days and typical prices distinguish markets of equal volume", () => {
    const prices = [49, 50, 50, 50, 51, 4900];
    const sales = prices.map((price, day) => ({ price, at: day * 86400000 }));
    const steady = resaleActivity(sales)!;
    assert.deepEqual([steady.activeDays, steady.perDay, steady.low, steady.high], [6, 0.1, 50, 50.75]);
    assert.ok(steady.priority > resaleActivity(sales.map(s => ({ ...s, at: 0 })))!.priority);
    assert.ok(steady.priority > resaleActivity(sales.map((s, i) => ({ ...s, price: i < 3 ? 10 : 80 })))!.priority);
    assert.match(activityDescription(steady), /0.10 sales per day.*6 distinct UTC days/);
    assert.match(activityDescription(resaleActivity(sales.slice(-1))!), /too little to measure stability/);
    assert.equal(resaleActivity([]), undefined);
});

test("catalog ranking retains every measured card and prioritizes monthly completed volume", async () => {
    const cards = ["Burst", "Daily", "Third", "Fourth"].map((name, i) => ({ id: i + 1, name, set: { name: "Fossil" }, number: "1", total_set_number: "62" }));
    const bucket = (date: string, sales: number) => ({ date, sales, currency: "USD", graded: false });
    const ranked = await rankCatalogMarkets(cards, "raw", Date.parse("2026-11-25T12:00:00Z"), new AbortController().signal,
        async id => ({ data: id === 2 ? [bucket("2026-11-23", 3), bucket("2026-11-24", 3), bucket("2026-11-25", 3), bucket("2026-11-25", 3)]
            : [bucket("2026-11-25", id === 1 ? 12 : 1)] }));
    assert.deepEqual(ranked.map(m => m.name), ["Burst", "Daily", "Fourth", "Third"]);
    assert.deepEqual([ranked[1].activeDays, ranked[1].sales], [3, 9]);
});

test("a discovery lead with fifteen monthly sales can enter research without daily sales", async () => {
    const card = { id: 7, name: "Ampharos", set: { name: "Aquapolis" }, number: "1", total_set_number: "147" };
    const now = Date.parse("2026-11-25T12:00:00Z");
    const markets = await liquidMarkets("raw", now, new AbortController().signal,
        async () => ({ data: [card] }), async () => ({ data: Array.from({ length: 15 }, (_, i) => ({
            date: new Date(now - i * 2 * 86_400_000).toISOString().slice(0, 10), currency: "USD", sales: 1, graded: false,
        })) }), async () => [{ name: card.name, set: card.set.name, number: card.number }]);
    assert.deepEqual(markets.map(({ id, sales, activeDays }) => [id, sales, activeDays]), [[7, 15, 15]]);
});
