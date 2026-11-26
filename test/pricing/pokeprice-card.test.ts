import assert from "node:assert/strict";
import test from "node:test";
import { pokePriceSales } from "../../server/pricing/pokeprice-card.ts";

test("PokéPrice sales honor source, edition ambiguity, time, duplicates and card ID", () => {
    const date = "2026-11-25T00:00:00Z", now = Date.parse(date);
    const sale = { source: "ebay", grade: "Lp", price: 82, soldAt: date, grader: null, url: "https://www.ebay.com/itm/123111111111" };
    const payload = { cardId: "base4-4", fetchedAt: date, gradedHidden: true, sales: [
        sale, sale, { ...sale, source: "fanatics" }, { ...sale, price: -1 }, { ...sale, grade: "PSA 10", grader: "PSA" },
        { ...sale, soldAt: "2026-11-30T00:00:00Z" }, { ...sale, currency: "EUR", url: null },
    ] };
    assert.equal(pokePriceSales(payload, "base4-4", now)?.sales.length, 1);
    assert.equal(pokePriceSales(payload, "base1-4", now), null);
    assert.equal(pokePriceSales(payload, "base4-4", now + 8 * 86400000), null);
    assert.equal(pokePriceSales({ ...payload, fetchedAt: new Date(now + 1000).toISOString() }, "base4-4", now)?.sales.length, 1);
    assert.equal(pokePriceSales({ ...payload, fetchedAt: new Date(now + 60000).toISOString() }, "base4-4", now), null);
    const longer = Array.from({ length: 32 }, (_, i) => ({ ...sale, url: "https://www.ebay.com/itm/" + (123111111112 + i) }));
    assert.equal(pokePriceSales({ ...payload, sales: longer }, "base4-4", now)?.sales.length, 32);
});
