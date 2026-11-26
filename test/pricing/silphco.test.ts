import test from "node:test";
import assert from "node:assert/strict";
import { silphCohort, silphEvidence } from "../../server/pricing/silphco.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import type { CardRecord } from "../../server/pricing/types.ts";

const now = Date.parse("2026-11-26T12:00:00Z"), signal = new AbortController().signal;
const scope = { product: "88072", grade_key: "raw:near_mint", edition: "unlimited", finish: "normal" };
const market = { tcg_card_id: "neo1-70", grade_key: scope.grade_key, language: "en", edition: "unlimited", finish: "normal", stamp: null };
const head = { contract: "price.v2", request: { resolved_from: "88072" }, data: { cohort: { ...market, resolved_by: "explicit" },
    method: "median_30d", outliers: "exclude", status: "ok", served_stale: false, as_of: "2026-11-26", newest_sale_at: "2026-11-25",
    n_sales: 16, value_usd: 9.95, quality: { tier: "review" } } };
const link = (id: number) => "https://www.ebay.com/itm/" + (123000000000 + id);
const transaction = (id: number, date: string, price: number) => ({ ...market, marketplace: "ebay", url: link(id), sold_at: date,
    price_usd: price, include_in_oracle: true, excluded: false, is_outlier: false });
const ask = (id: number, price: number) => ({ ...market, url: link(id), title: "English Neo Genesis Pikachu", marketplace: "ebay", currency: "USD",
    listing_format: "fixed_price", listing_status: "live", id_confidence_tier: "high", last_verified_live_at: "2026-11-26", ask_price_usd: price });
const pins = Object.fromEntries(Object.entries({ grades: scope.grade_key, edition: scope.edition, finish: scope.finish })
    .map(([k,v]) => [k,{ resolved_by: "explicit", value: [v] }]));
test("Silph Co resolves the verified catalog product, exact raw condition and printing before requesting a price", () => {
    const e = cardEvaluation();
    Object.assign(e.photoCheck!, { cardCount: "ONE" });
    Object.assign(e.identity!, { recordId: "789", name: "Pikachu", set: "Neo Genesis", cardNumber: "70/111", finish: "NON_HOLO" });
    e.condition!.rawCondition = "NEAR_MINT";
    const card: CardRecord = { id: "789", source: "pkmnprices", tcgPlayerId: 88072, name: "Pikachu", setName: "Neo Genesis", cardNumber: "70/111",
        variants: [{ name: "Unlimited", finish: "NON_HOLO", printing: "UNLIMITED" }] };
    assert.deepEqual(silphCohort(e,card),scope);
    assert.equal(silphCohort(e,{ ...card, tcgPlayerId: undefined }),null);
    assert.equal(silphCohort(e,{ ...card, setName: "Base Set" }),null);
    assert.equal(silphCohort(e,{ ...card, variants: [{ ...card.variants[0], printing: "FIRST_EDITION" }] }),null);
    e.condition!.rawCondition = "MINT";
    assert.equal(silphCohort(e,card),null);
});
test("a Silph price, linked sales and competitor asks keep separate scope, shipping, freshness and duplicates", async () => {
    const a = transaction(1,"2026-11-21T13:13:00",10), b = transaction(2,"2026-11-23",12), c = transaction(3,"2026-11-21",8);
    const rows = [a,b,c,a,transaction(4,"2026-11-25",200),transaction(4,"2026-11-25",400), { ...a, price_usd: 999, is_outlier: true },
        { ...a, url:link(6), grade_key:"PSA:9" }, { ...a, url:link(7), edition:"first_edition" }, transaction(9,"2026-11-26",100)];
    const listings = [ask(5,18),{ ...ask(6,21), landed_price_usd: 23 },{ ...ask(7,1), listing_format:"auction" },ask(9,2),
        { ...ask(8,1), last_verified_live_at: "2026-11-20" }];
    const result = await silphEvidence(scope,link(9),now,signal,async (path, params) => {
        assert.equal(params.grade_key,"raw:near_mint"); assert.equal(params.edition,"unlimited"); assert.equal(params.marketplace,"ebay");
        if (path === "price") { assert.equal(params.q,"88072"); assert.equal(params.method,"median_30d"); return head; }
        assert.equal(params.ids,"neo1-70");
        if (path === "sales") return { contract:"sales.v2", data: { rows } };
        assert.equal(path,"listings");
        return { contract:"listings-collection.v1", meta:{ cohort:pins }, data:{ cards:{ "neo1-70":{ listings } } } };
    });
    assert.deepEqual(result.prices.map(p=>p.price),[9.95,23,18]);
    assert.match(result.prices[0].basis,/16 provider-reported sales.*review/);
    assert.match(result.prices[2].basis,/before shipping/);
    assert.equal(result.sales.length,3);
    assert.deepEqual(result.points,[{day:"2026-11-21",price:9},{day:"2026-11-23",price:12}]);
});
test("thin and fallback markets cannot furnish an exact resale price", async () => {
    const result = await silphEvidence(scope,"",now,signal,async path => path === "price" ?
        { ...head, data: { ...head.data, status:"thin", value_usd:null, last_sale:{price_usd:200}, n_sales:1 } } : null);
    assert.deepEqual(result.prices,[]); assert.match(result.context[0],/thin/);
    const mismatch = await silphEvidence(scope,"",now,signal,async path => {
        assert.equal(path,"price");
        return { ...head, data:{ ...head.data, cohort:{ ...head.data.cohort, resolved_by:"fallback" } } };
    });
    assert.deepEqual(mismatch.sales,[]); assert.match(mismatch.notes[0],/confirm this exact market/);
});

test("daily set movers prefer repeated activity and restrict each research lead to its release", async () => {
    const { silphSetSeeds } = await import("../../server/pricing/silphco.ts");
    const card = (id: string, name: string, sales: number, prior: number) => ({ tcg_card_id:id, name, n_sales:sales, n_sales_prior_7d:prior, trust:"ok", capped:false });
    const surge = card("base1-69","Weedle",3,4), steady = card("base1-6","Gyarados",22,90);
    const hints = await silphSetSeeds("base1","Base Set",signal,async (_,params) => {
        assert.equal(params.agg,"movers"); assert.equal(params.marketplace,"ebay");
        return { contract:"sales.v2", request:{set_id:"base1"}, data:{ rows:[{top_gainers:[surge,steady],
            top_volume:[card("base2-1","Wrong release",100,100),{...steady, name:"Ineligible", capped:true},steady]}] } };
    });
    assert.deepEqual(hints.map(h=>[h.name,h.number,h.set]),[["Gyarados","6","Base Set"],["Weedle","69","Base Set"]]);
});
