import { test } from "node:test";
import assert from "node:assert/strict";
import { underwrite, netFromSale } from "../../shared/money/underwriting.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";

function example() {
    const e = cardEvaluation(); e.pricesCheckedAt = new Date().toISOString();
    e.listing.price = 699.99; e.listing.shipping = 14.99; e.listing.buyingOption = "FIXED_PRICE";
    e.identity!.printing = "SHADOWLESS"; e.identity!.finish = "HOLO";
    e.condition!.rawCondition = "DAMAGED"; e.condition!.gradeRange = { low: 1, likely: 1, high: 2 };
    e.rawPricing = { status: "PRICED", printing: "SHADOWLESS", variant: "Unlimited Holofoil", prices: [{ condition: "DAMAGED", price: 1049.62, basis: "TCGPLAYER", updatedAt: e.pricesCheckedAt }] };
    e.gradedPricing = { PSA: { status: "PRICED", printing: "SHADOWLESS", variant: "Unlimited Holofoil", byGrade: [salesSummary("PSA", 1, [710, 720, 730])] } };
    e.gradedPricing.PSA!.byGrade![0].count = 2;
    e.gradedPricing.PSA!.byGrade![0].newestSale = e.pricesCheckedAt!;
    return e;
}
test("an unsupported raw premium over matched slab sales cannot recommend the damaged Charizard at asking", () => {
    const e = example(); const result = retargetEvaluation(e, { minProfit: 0, minRoi: 0 });
    const raw = result.underwriting!.paths.find(path => path.path === "RAW")!;
    assert.equal(raw.status, "PRICED"); if (raw.status !== "PRICED") return;
    assert.equal(raw.label, "Sell raw"); assert.equal(raw.salePrice, 720);
    assert.ok(raw.maxBid < 699.99); assert.ok(raw.profit < 0);
    assert.equal(result.underwriting!.verdict, "PASS");
    assert.match(raw.pricingNotes!.join(" "), /unsupported raw fallback.*matched PSA 1 sold evidence/);
    assert.equal(raw.expectedNet, netFromSale(720, "raw", MONEY_CONFIG.selling));
    assert.equal(e.rawPricing!.prices![0].price, 1049.62, "the original provider quote remains available for inspection");
});
test("actual raw sold medians and unsupported slab comparisons are not replaced by the heuristic", () => {
    const e = example(); e.rawPricing!.prices![0].basis = "EBAY_SOLD";
    const price = () => { const path = underwrite(e).paths.find(path => path.path === "RAW"); return path?.status === "PRICED" ? path.salePrice : null; };
    assert.equal(price(), 1049.62);
    e.rawPricing!.prices![0].basis = "TCGPLAYER"; e.gradedPricing!.PSA!.variant = "1st Edition Holofoil";
    assert.equal(price(), 1049.62);
    e.gradedPricing!.PSA!.variant = "Unlimited Holofoil"; e.gradedPricing!.PSA!.byGrade![0].count = 1;
    assert.equal(price(), 1049.62);
    e.gradedPricing!.PSA!.byGrade![0].count = 2; e.gradedPricing!.PSA!.byGrade![0].grade = 9;
    assert.equal(price(), 1049.62);
});
test("a damaged market fallback cannot exceed a cheaper better-condition quote", () => {
    const e = example(); e.gradedPricing = {};
    e.rawPricing!.prices!.push({ condition: "HEAVILY_PLAYED", price: 1014.66, basis: "TCGPLAYER", updatedAt: null });
    const raw = underwrite(e).paths.find(path => path.path === "RAW")!;
    assert.equal(raw.status, "PRICED"); if (raw.status === "PRICED") assert.equal(raw.salePrice, 1014.66);
});
