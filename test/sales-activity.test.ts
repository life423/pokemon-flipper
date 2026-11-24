import assert from "node:assert/strict";
import { test } from "node:test";
import { observedSalesActivity } from "../shared/sales-activity.ts";
import type { CompSale } from "../shared/types.ts";

const now = Date.parse("2026-11-24T12:00:00Z"), day = 86_400_000;
const sale = (id: number, days: number, extra: Partial<CompSale> = {}): CompSale => ({ title: "Exact matched card", price: 21,
    soldAt: new Date(now - days * day).toISOString(), saleType: "fixed_price", url: `https://www.ebay.com/itm/${123450000000 + id}`, ...extra });

test("rolling sixty-day activity counts only observed distinct confirmed transactions", () => {
    const rows = [sale(1, 7), sale(2, 31), sale(3, 60), sale(4, 60 + 1 / day), sale(5, 90), sale(6, -1),
        sale(1, 7, { url: sale(1, 7).url + "?tracking=yes" }), sale(7, 1, { saleType: undefined }),
        sale(8, 1, { price: 0 }), sale(9, 1, { url: null }), { ...sale(10, 1), currency: "EUR" }];
    const activity = observedSalesActivity(rows, now);
    assert.deepEqual([activity.sales7, activity.sales30, activity.sales60, activity.sales90], [1, 1, 3, 5]);
    assert.equal(activity.observations.length, 5, "no provider aggregate or price quote supplies volume");
});

test("conflicting amounts or dates for one transaction cannot inflate activity", () => {
    const result = observedSalesActivity([sale(1, 1), sale(1, 1, { price: 999 }), sale(2, 1), sale(2, 2), sale(3, 2)], now);
    assert.equal(result.sales60, 1);
    assert.equal(result.observations[0].id, "123450000003");
});
