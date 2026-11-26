import assert from "node:assert/strict";
import test from "node:test";
import { buyerMarketPrices, providerPrices } from "../../server/pricing/buyer-market-prices.ts";
import { listingMarketPrices } from "../../shared/listing-market-prices.ts";
import { PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";
import { tcgplayerRawEstimate } from "../fixtures/tcgplayer-raw-estimate.ts";

const now = Date.now(), stamp = new Date(now).toISOString(), signal = new AbortController().signal;
function raw() {
    const e = cardEvaluation();
    Object.assign(e, { pricesCheckedAt: stamp, pricingVersion: PRICING_VERSION, assessmentVersion: "offline/bounded-prompts-4", conditionVersion: "offline/bounded-condition-1/prompts-1" });
    Object.assign(e.listing, { title: "Dark Gengar 6/105", availability: "ACTIVE", endTime: null });
    Object.assign(e.identity!, { name: "Dark Gengar", set: "Neo Destiny", cardNumber: "6/105", recordId: "123", hasEditions: true });
    Object.assign(e.photoCheck!, { cardCount: "ONE", cardMatch: { verdict: "MATCH", problems: [] } });
    const comps = salesSummary("RAW", "LIGHTLY_PLAYED", [75, 80, 300]);
    comps.sales.forEach((sale, i) => Object.assign(sale, { saleType: "fixed_price", sellerCondition: "LIGHTLY_PLAYED", url: "https://www.ebay.com/itm/" + (120000000000 + i) }));
    e.rawPricing = { status: "PRICED", source: "pkmnprices", printing: "UNLIMITED", variant: "Unlimited Holofoil", finish: "HOLO", conditionEvidence: "TCGPLAYER",
        sellerConditionComps: comps, prices: [tcgplayerRawEstimate(79, stamp)] };
    e.gradedPricing = null;
    e.trackerRawReference = { source: "TCGPLAYER_MARKET", recordId: "123", tcgPlayerId: 5, printing: "UNLIMITED", finish: "HOLO",
        condition: "LIGHTLY_PLAYED", priceUsd: 82, updatedAt: stamp };
    e.webPriceResearch = { checkedAt: stamp, market: { cardName: "Dark Gengar", setName: "Neo Destiny", cardNumber: "6/105", printingLabel: "Unlimited",
        finish: "HOLO", language: "English", grader: "RAW", grade: "Lightly Played" },
        observations: [{ title: "An eBay sale", kind: "SOLD", priceUsd: 77, date: stamp, url: "https://www.ebay.com/itm/123456789012" }] };
    return e;
}
const inspect = (e: ReturnType<typeof raw>, clock = now) => listingMarketPrices(e, { ...e.listing, images: e.listing.photos! }, clock);
const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider call"); };

test("a raw result keeps independent eBay, TCGplayer, Tracker and cited prices with the actual condition and date", () => {
    const e = raw(), prices = inspect(e)!;
    assert.equal(prices.scope, "Lightly Played"); assert.equal(prices.printing, "Unlimited");
    assert.equal(prices.sold?.price, 80); assert.equal(prices.sold?.count, 3); assert.equal(prices.sold?.sellerCondition, true);
    assert.deepEqual(prices.sold?.sales?.map(sale => [sale.url, sale.price, sale.method]), [75, 80, 300].map((price, i) =>
        ["https://www.ebay.com/itm/" + (120000000000 + i), price, "fixed_price"]));
    assert.equal(prices.tcg?.market, 79); assert.equal(prices.tcg?.marketRecordAt, stamp);
    assert.deepEqual(providerPrices(e, now).map(r => [r.source, r.basis, r.price]), [
        ["Pokémon Price Tracker", "TCGplayer market", 82], ["Cited web price", "ebay.com sale", 77]]);
    e.trackerRawReference!.condition = "NEAR_MINT";
    e.webPriceResearch!.market!.printingLabel = "1st Edition";
    assert.deepEqual(providerPrices(e, now), []);
    assert.equal(listingMarketPrices(e, { ...e.listing, images: ["different front"] }, now), undefined);
});

test("tile sale history preserves accepted offers and excludes unconfirmed amounts and currencies", () => {
    const e = raw(), sales = e.rawPricing!.sellerConditionComps!.sales;
    sales[0].saleType = "best_offer_accepted";
    delete sales[1].saleType;
    Object.assign(sales[2], {currency: "EUR"});
    const price = inspect(e)!;
    assert.equal(price.sold?.price, 75);
    assert.deepEqual(price.sold?.sales, [{price: 75, method: "best_offer_accepted", title: sales[0].title,
        soldAt: sales[0].soldAt, url: sales[0].url}]);
    assert.equal(price.tcg?.market, 79);
});

test("one expired TCGplayer offer does not erase a current market quote or an eBay sale", () => {
    const e = raw(), row = e.rawPricing!.prices![0], offer = row.offers!;
    const time = new Date(now - 86_400_000 + 1000).toISOString();
    row.basis = "TCGPLAYER_OFFERS"; Object.assign(offer, { method: "LOWEST_DELIVERED_COMPETITION", snapshotAt: time, offers: [
        { id: "one", sellerId: "a", sellerName: "a", price: 78, shipping: 1, total: 79, quantity: 1, snapshotAt: time }] });
    const prices = inspect(e, now + 2000)!;
    assert.ok(prices.tcg!.offerValidUntil! <= now + 2000);
    assert.ok(prices.sold!.validUntil! > now + 2000); assert.ok(prices.tcg!.validUntil! > now + 2000);
});

test("CGC 8.5 with no eBay sales still gets both Tracker estimates and matched European asking prices", async () => {
    const e = raw();
    e.rawPricing = null; e.condition = null;
    e.slab = { status: "OK", grader: "CGC", grade: "8.5", gradeQualifier: null, certNumber: null, certUrl: null, labelText: "Dark Gengar CGC 8.5",
        caseCondition: "INTACT", concerns: [], reasons: [] };
    Object.assign(e.photoCheck!, { holder: "GRADED_SLAB", slab: { ...e.slab, present: true, authenticity: "NONE_SEEN" } });
    const lookup = inspect(e)!.lookup!;
    assert.equal(inspect(e)?.sold, undefined);
    const track = { source: "POKEMON_PRICE_TRACKER" as const, tcgPlayerId: 123, printingLabel: "Unlimited Holofoil", caveat: "",
        gradedMarket: { grader: "CGC", grade: "8.5", priceUsd: 90, statistic: "HISTORICAL_MEDIAN" as const, reportedSales: 6, lastSaleAt: stamp, marketplaces: ["eBay"],
            filteredEstimate: { priceUsd: 82, days: 30, confidence: "medium" } } };
    const providers: string[] = [];
    const deps = { supplement: async () => { providers.push("references"); return { trackerPriceReference: track }; },
        european: async () => { providers.push("Europe"); return { status: "AVAILABLE" as const, reason: null, currency: "EUR" as const, basis: "ACTIVE_ASK" as const,
            checkedAt: stamp, offers: [{ articleId: "a", priceEur: 71, updatedAt: stamp, condition: null, variant: "Unlimited Holofoil", grader: "CGC", grade: "8.5", sellerCountry: "DE" }] }; },
        priceCharting: async () => {
            providers.push("guide");
            return { observation: "Grade guide", prices: [{ source: "PriceCharting", basis: "Grade 9 guide · mixed graders", price: 120, currency: "USD" as const,
                asOf: stamp, validUntil: now + 86_400_000 }] };
        },
        silph: async () => {
            providers.push("Silph Co");
            return { notes:[], context:[], prices: [{ source:"Silph Co · eBay", basis:"CGC 8.5 · 30-day sold median", price:92,
                currency:"USD" as const, asOf:stamp, validUntil:now + 86_400_000 }], sales: [{ url:"https://www.ebay.com/itm/123456789014", date:stamp.slice(0,10), priceUsd:90 }],
                points:[{ day:stamp.slice(0,10), price:90 }] };
        },
        rawQuote: unexpected, record: unexpected, recentSales: async () => [] };
    const before = structuredClone(e);
    const comparison = await buyerMarketPrices(e, lookup.market, signal, deps, () => now);
    assert.deepEqual(comparison?.prices.map(row => [row.source, row.price, row.currency]), [
        ["Pokémon Price Tracker", 90, "USD"], ["Pokémon Price Tracker", 82, "USD"], ["Cardmarket", 71, "EUR"], ["PriceCharting", 120, "USD"], ["Silph Co · eBay", 92, "USD"]]);
    assert.equal(comparison?.silphHistory?.sales[0].priceUsd,90);
    assert.deepEqual(e, before);
    track.gradedMarket.grade = "9";
    assert.deepEqual(providerPrices({ ...e, trackerPriceReference: track }, now), []);
    track.gradedMarket.grade = "8.5"; track.printingLabel = "1st Edition Holofoil";
    assert.deepEqual(providerPrices({ ...e, trackerPriceReference: track }, now), []);
    assert.equal(await buyerMarketPrices(e, "earlier assessment", signal, deps, () => now), null);
    assert.deepEqual(providers, ["references", "Europe", "guide", "Silph Co"]);
});

test("one unavailable source preserves the other returned prices and a note", async () => {
    const e = raw();
    const result = await buyerMarketPrices(e, inspect(e)!.lookup!.market, signal, { supplement: async () => ({}),
        european: async () => { throw new Error("offline provider"); }, rawQuote: unexpected, record: unexpected, recentSales: unexpected }, () => now);
    assert.equal(result?.prices.length, 2);
    assert.deepEqual(result?.notes, ["Cardmarket is unavailable for this check."]);
});
