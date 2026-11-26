import test from "node:test";
import assert from "node:assert/strict";
import { competitiveResalePath } from "../../shared/money/competitive-resale.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { cardEvaluation, matchedRawPrice } from "../fixtures/card-evaluation.ts";

test("an independently checked competing copy can raise or cap resale while one exceptional sale cannot lift the ceiling", () => {
    const now = Date.now(), stamp = new Date(now).toISOString(), targets = { minProfit:0, minRoi:0 };
    const value = cardEvaluation(targets);
    Object.assign(value.listing,{ id:"123111115500", title:"Light Arcanine 12/105", buyingOption:"FIXED_PRICE", shipping:0, price:25 });
    Object.assign(value.identity!,{ name:"Light Arcanine",set:"Neo Destiny",cardNumber:"12/105" });
    const raw = matchedRawPrice(85,stamp,5);
    raw.comps.sales.forEach((sale,i) => sale.price = [76,80,85,92,999][i]);
    value.rawPricing!.prices = [raw];
    value.gradedPricing = null;
    const base = underwrite(value,{...MONEY_CONFIG,targets}).paths.find(p => p.path === "RAW");
    assert.ok(base?.status === "PRICED");
    const ask = { listingId:"123111115501",delivered:120,checkedAt:stamp };
    const raised = competitiveResalePath(value,base,ask,now,targets)!;
    assert.equal(raised.salePrice,92); assert.ok(raised.profit > base.profit); assert.ok(raised.maxBid > base.maxBid);
    const capped = competitiveResalePath(value,base,{...ask,delivered:60},now,targets)!;
    assert.equal(capped.salePrice,60); assert.ok(capped.profit < base.profit);
    raw.comps.sales.splice(0,3);
    assert.equal(competitiveResalePath(value,base,ask,now,targets)?.salePrice,85);
    assert.equal(competitiveResalePath(value,base,{...ask,listingId:value.listing.id},now,targets),null);
    assert.equal(competitiveResalePath(value,base,ask,now+3*60_000,targets),null);
});
