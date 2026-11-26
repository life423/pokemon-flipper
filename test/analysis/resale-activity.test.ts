import test from "node:test";
import assert from "node:assert/strict";
import { activityDescription, liquidityIssue, resaleActivity } from "../../server/analysis/resale-activity.ts";
import { rankCatalogMarkets } from "../../server/pricing/liquid-markets.ts";

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

test("catalog ranking retains every measured card and prioritizes daily sales over a one-day burst", async () => {
    const cards = ["Burst", "Daily", "Third", "Fourth"].map((name, i) => ({ id: i + 1, name, set: { name: "Fossil" }, number: "1", total_set_number: "62" }));
    const bucket = (date: string, sales: number) => ({ date, sales, currency: "USD", graded: false });
    const ranked = await rankCatalogMarkets(cards, "raw", Date.parse("2026-11-25T12:00:00Z"), new AbortController().signal,
        async id => ({ data: id === 2 ? [bucket("2026-11-23", 3), bucket("2026-11-24", 3), bucket("2026-11-25", 3), bucket("2026-11-25", 3)]
            : [bucket("2026-11-25", id === 1 ? 12 : 1)] }));
    assert.deepEqual(ranked.map(m => m.name), ["Daily", "Burst", "Fourth", "Third"]);
    assert.deepEqual([ranked[0].activeDays, ranked[0].sales], [3, 9]);
});

test("verified flips need recent trading across days and stable typical prices", () => {
    const now = Date.UTC(2026, 10, 25, 12), day = 86_400_000;
    const measure = (prices: number[], ages: number[]) => resaleActivity(prices.map((price, i) => ({ price, at: now - ages[i] * day })), now);
    const prices = [98, 99, 100, 100, 101, 102, 320], ages = [0, 0, 1, 1, 2, 3, 4];
    const daily = measure(prices, ages);
    assert.equal(liquidityIssue(daily), null);
    assert.match(activityDescription(daily!), /7 observed sales on 5 selling days/);
    assert.match(liquidityIssue(measure(prices, ages.map(() => 0)))!, /daily demand/);
    assert.match(liquidityIssue(measure(prices, ages.map(a => a + 10)))!, /daily demand/);
    assert.match(liquidityIssue(measure([20, 20, 22, 60, 90, 100, 101], ages))!, /30%/);
    assert.match(liquidityIssue(measure([100], [1]))!, /daily demand/);
    assert.match(liquidityIssue(undefined)!, /daily demand/);
});
