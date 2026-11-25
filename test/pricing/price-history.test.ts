import test from "node:test";
import assert from "node:assert/strict";
import { marketHistory, weeklyOutlook } from "../../server/pricing/price-history.ts";
import type { Evaluation } from "../../shared/types.ts";

const day = 86400000;
const now = Date.UTC(2026, 10, 25, 12);
const series = (getPrice: (index: number) => number) => Array.from({ length: 84 }, (_, i) => ({
    day: new Date(now - (83 - i) * day).toISOString().slice(0, 10), price: getPrice(i),
}));

test("a one-week outlook needs recent coverage and must beat the flat forecast in previous weeks", () => {
    assert.equal(weeklyOutlook(series(i => 100 + i), now).outlook, "Upward bias");
    assert.equal(weeklyOutlook(series(i => 200 - i), now).outlook, "Downward bias");
    assert.equal(weeklyOutlook(series(() => 22), now).outlook, "Insufficient evidence");
    assert.equal(weeklyOutlook(series(i => Math.floor(i / 7) % 2 ? 10 : 20), now).outlook, "Insufficient evidence");
    assert.equal(weeklyOutlook(series(i => 100 + i).slice(-14), now).outlook, "Insufficient evidence");
    assert.equal(weeklyOutlook(series(i => 100 + i), now + 4 * day).outlook, "Insufficient evidence");
});

test("history retains only the photographed market, dates and currency and omits conflicted observations", async () => {
    const card = { name: "Slowking", set: "Neo Genesis", cardNumber: "14/111", language: "English", finish: "HOLO" };
    const value = { identity: { ...card, status: "IDENTIFIED", recordId: 123, printing: "UNLIMITED", evidence: { photo: "UNLIMITED" } },
        listing: { title: "Slowking 14/111 holo", aspects: {} },
        photoCheck: { cardCount: "ONE", holder: "NONE", images: [{number:1, view:"FRONT", usable:true, isStockImage:false}],
            cardIdentity: { ...card, confidence:"HIGH", evidence:["Name, set and number are visible."] } },
        condition: { rawCondition: "LIGHTLY_PLAYED" },
        rawPricing: { source: "pkmnprices", printing: "UNLIMITED", finish: "HOLO", variant: "Unlimited Holofoil" } } as unknown as Evaluation;
    const row = { date: "2026-11-24", source:"tcgplayer", currency:"USD", condition:"Lightly Played", variant:"Unlimited Holofoil", avg:32 };
    const result = await marketHistory(value, now, async (id, variant, condition) => {
        assert.deepEqual([id, variant, condition], ["123", row.variant, row.condition]);
        return {data: [row, row, { ...row, date:"2026-11-22", avg:22 }, { ...row, date:"2026-11-22", avg:44 },
            { ...row, condition:"Near Mint", avg:80 }, { ...row, currency:"EUR", avg:20 }, { ...row, date:"2026-02-31" },
            { ...row, date:"2026-11-26" }, { ...row, variant:"1st Edition Holofoil", avg:99 }] };
    });
    assert.deepEqual(result.points, [{day:row.date,price:32}]);
    assert.equal(result.outlook, "Insufficient evidence");
    const wrong = await marketHistory({ ...value, photoCheck: null }, now, async () => assert.fail("An unverified copy must use no credits"));
    assert.deepEqual(wrong.points, []);
});
