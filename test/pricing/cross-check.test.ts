import { test } from "node:test";
import assert from "node:assert/strict";
import { crossCheckRawPrices } from "../../server/pricing/cross-check.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import type { CardRecord } from "../../server/pricing/types.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";

test("the secondary API only cross-checks exact condition, number, printing and finish; it never replaces a sold median", async () => {
    const e = cardEvaluation(); e.rawPricing!.variant = "Holofoil"; e.rawPricing!.prices![0].basis = "TCGPLAYER";
    const record: CardRecord = { source: "pokemonPriceTracker", id: 1, tcgPlayerId: 1, name: e.identity!.name!, setName: "Base Set", cardNumber: "15/102", variants: [{ name: "Holofoil", printing: "UNLIMITED", finish: "HOLO", prices: [{ condition: "LIGHTLY_PLAYED", price: 40, updatedAt: new Date().toISOString() }] }] };
    let calls = 0; const lookup = async () => { calls++; return [record]; };
    const result = await crossCheckRawPrices(e.rawPricing!, e.identity!, lookup);
    assert.equal(result.prices![0].price, 85); assert.equal(result.prices![0].crossCheck!.price, 40);
    const adjusted = retargetEvaluation({ ...e, rawPricing: result }, { minProfit: 0, minRoi: 0 });
    const raw = adjusted.underwriting!.paths.find(path => path.path === "RAW")!;
    assert.equal(raw.status, "PRICED"); if (raw.status === "PRICED") assert.equal(raw.salePrice, 40);
    record.cardNumber = "4/102";
    assert.equal((await crossCheckRawPrices(e.rawPricing!, e.identity!, lookup)).prices![0].crossCheck, undefined);
    e.rawPricing!.prices![0].basis = "EBAY_SOLD";
    const before = calls; assert.equal(await crossCheckRawPrices(e.rawPricing!, e.identity!, lookup), e.rawPricing); assert.equal(calls, before);
});
test("secondary provider failure retains the primary evidence and cannot break evaluation", async () => {
    const e = cardEvaluation(); e.rawPricing!.prices![0].basis = "TCGPLAYER";
    const result = await crossCheckRawPrices(e.rawPricing!, e.identity!, async () => { throw new Error("offline"); });
    assert.equal(result.prices![0].price, 85); assert.match(result.crossCheckNote!, /unavailable/);
});
