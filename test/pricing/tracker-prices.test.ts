import { isolatedDataDir } from "../fixtures/isolated-data.ts";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { trackerPriceReference, trackerMarketReferences } from "../../server/pricing/price-tracker.ts";
import { withAiUsageContext } from "../../server/ai/usage-context.ts";
import { withSavedProviderEvidence } from "../../server/lib/saved-provider-evidence.ts";
import { writeCache, readCache } from "../../server/lib/cache.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

function keys(id: number) {
    return { catalog: `pkmnprices:/cards/${id}?currency=usd`, tracker: `pokemonpricetracker:card-by-tcg:v2:${id + 900}:ebay:limit1` };
}
async function fixture(id: number) {
    const value = cardEvaluation();
    value.identity!.recordId = id;
    value.photoCheck!.cardCount = "ONE";
    const key = keys(id);
    const record = { id, tcg_player_id: id + 900, number: "015", total_set_number: "102", name: "Venusaur", set: { name: "Base Set" },
        prices: [{ currency: "USD", variant: "Holofoil" }] };
    await writeCache(key.catalog, record);
    const date = new Date(Date.now() - 86_400_000).toISOString();
    const bucket = { count: 13, marketPriceMedian7Day: 71, medianPrice: 59, lastSaleDate: date, lastMarketUpdate: date,
        salesBySource: { ebay: 11, fanatics: 2 } };
    const row = { tcgPlayerId: String(id + 900), cardNumber: "15/102", totalSetNumber: 102, name: "Venusaur", setName: "Base Set",
        printingsAvailable: ["Holofoil"], ebay: { salesByGrade: { psa7: bucket } }, prices: { market: 240 } };
    return { value, key, row, record, bucket };
}
test("a cached exact product supplies dated grade context without adding sale rows or using TCGplayer prices", async () => {
    const { value, key, row } = await fixture(101);
    await writeCache(key.tracker, { data: row });
    const lookup = () => trackerPriceReference(value, undefined, { cacheOnly: true });
    const result = await lookup();
    assert.equal(result?.gradedMarket.priceUsd, 71);
    assert.equal(result?.printingLabel, "Holofoil");
    assert.equal(result?.gradedMarket.reportedSales, 13);
    assert.equal(result?.gradedMarket.statistic, "7_DAY_MEDIAN");
    assert.deepEqual(result?.gradedMarket.marketplaces, ["eBay", "Fanatics Collect"]);
    assert.match(result!.caveat, /estimated grade/);
    row.ebay.salesByGrade.psa7.lastMarketUpdate = new Date(Date.now() - 5 * 86_400_000).toISOString();
    await writeCache(key.tracker, { data: [row] });
    assert.equal((await lookup())?.gradedMarket.statistic, "HISTORICAL_MEDIAN");
    for (const patch of [{ currency: "EUR" }, { tcgPlayerId: "999" }, { language: "Japanese" }, { cardNumber: "2/130" },
        { setName: "Base Set 2" }, { name: "Blastoise" }, { totalSetNumber: 130 }, { printingsAvailable: ["Reverse Holofoil"] },
        { printingsAvailable: ["Holofoil", "1st Edition Holofoil"] }, { printingsAvailable: ["Stamped Holofoil"] },
        { ebay: { salesByGrade: { cgc7: row.ebay.salesByGrade.psa7 } } }, { ebay: {} }]) {
        await writeCache(key.tracker, { data: { ...row, ...patch } });
        assert.equal(await lookup(), null, JSON.stringify(patch));
    }
});
test("an identified ordinary slab uses its certified grade instead of the raw estimate", async () => {
    const { value, key, row, bucket } = await fixture(110);
    value.condition = null;
    value.photoCheck!.holder = "GRADED_SLAB";
    value.photoCheck!.slab = { present: true, grader: "CGC", grade: "9", gradeQualifier: null, certNumber: "12345", labelText: "CGC 9",
        caseCondition: "INTACT", authenticity: "NONE_SEEN", concerns: [] };
    value.slab = { status: "OK", grader: "CGC", grade: "9", gradeQualifier: null, certNumber: "12345", certUrl: null, labelText: "CGC 9",
        caseCondition: "INTACT", reasons: [], concerns: [] };
    await writeCache(key.tracker, { data: { ...row, ebay: { salesByGrade: { cgc9: bucket } } } });
    const ref = await trackerPriceReference(value, undefined, { cacheOnly: true });
    assert.equal(ref?.gradedMarket.grader, "CGC");
    assert.equal(ref?.gradedMarket.grade, "9");
    value.slab.gradeQualifier = "Pristine";
    assert.equal(await trackerPriceReference(value, undefined, { cacheOnly: true }), null);
});
test("saved-only, conflict, original search allowance, uncertain dispatch and concurrent listings bound Tracker credits", async t => {
    const original = process.env.POKEMON_PRICE_TRACKER_API_KEY;
    process.env.POKEMON_PRICE_TRACKER_API_KEY = "tracker-offline-test";
    t.after(() => { if (original) process.env.POKEMON_PRICE_TRACKER_API_KEY = original; else delete process.env.POKEMON_PRICE_TRACKER_API_KEY; });
    const [first, second, third] = await Promise.all([201, 202, 203].map(fixture));
    const searchId = randomUUID();
    const lookup = (value = first.value, id = searchId) => withAiUsageContext({ searchId: id }, () => trackerPriceReference(value));
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (raw: string) => {
        calls++;
        const url = new URL(raw);
        assert.equal(url.host, "www.pokemonpricetracker.com");
        assert.equal(url.searchParams.get("limit"), "1");
        assert.equal(url.searchParams.get("includeEbay"), "true");
        if (url.searchParams.get("tcgPlayerId") === second.row.tcgPlayerId) throw new Error("provider outcome unknown");
        assert.equal(url.searchParams.get("tcgPlayerId"), first.row.tcgPlayerId);
        return Response.json({ data: first.row }, { headers: { "x-api-calls-consumed": "2" } });
    });
    assert.equal(await trackerPriceReference(first.value, undefined, { cacheOnly: true }), null);
    const missed: string[] = [];
    await assert.rejects(withSavedProviderEvidence(source => missed.push(source), () => lookup()), /Saved evidence/);
    assert.deepEqual(missed, ["POKEMON_PRICE_TRACKER"]);
    assert.equal(await trackerPriceReference(first.value), null, "an unscoped lookup cannot spend");
    const ambiguous = structuredClone(first.record);
    ambiguous.prices.push({ currency: "USD", variant: "Unlimited Holofoil" });
    await writeCache(first.key.catalog, ambiguous);
    assert.equal(await lookup(), null);
    assert.equal(calls, 0);
    await writeCache(first.key.catalog, first.record);
    const refs = await Promise.all([lookup(), lookup()]);
    assert.deepEqual(refs[0], refs[1]);
    assert.equal(refs[0]?.gradedMarket.priceUsd, 71);
    assert.equal((await readCache(first.key.tracker + ":receipt:" + searchId, 1)).reportedCredits, 2);
    assert.equal(calls, 1);
    assert.equal((await withSavedProviderEvidence(() => assert.fail("replay requested a provider"), () => lookup()))?.gradedMarket.priceUsd, 71);
    assert.equal(await lookup(second.value), null);
    assert.equal(await lookup(second.value), null);
    assert.equal(await lookup(second.value, randomUUID()), null, "a new search does not repeat an uncertain call today");
    assert.equal(await lookup(third.value), null);
    assert.equal(calls, 2);
    // A broken store must propagate without dispatch or replacement evidence.
    await writeCache(third.key.tracker, { damaged: true });
    await assert.rejects(lookup(third.value), /Saved Pokémon Price Tracker evidence is invalid/);
    assert.ok((await fs.readdir(path.join(isolatedDataDir, "tracker-price-reservations"))).length > 0);
    assert.equal(calls, 2);
});

test("Tracker grade history for a numbered Plasma Blast full art stays bound to its native product and artwork", async () => {
    const { value, key, row, record } = await fixture(14616);
    const label = "Palkia EX (Team Plasma) (100 Full Art)";
    Object.assign(value.identity!, { name: "Palkia EX", set: "Plasma Blast", cardNumber: "100/101" });
    await writeCache(key.catalog, { ...record, name: label, number: "100", total_set_number: "101", set: { name: "Plasma Blast" } });
    const product = { ...row, name: label, cardNumber: "100/101", totalSetNumber: 101, setName: "Plasma Blast" };
    await writeCache(key.tracker, { data: product });
    assert.equal((await trackerPriceReference(value, undefined, { cacheOnly: true }))?.gradedMarket.reportedSales, 13);
    await writeCache(key.tracker, { data: { ...product, name: "Palkia EX (Team Plasma) (66 Full Art)" } });
    assert.equal(await trackerPriceReference(value, undefined, { cacheOnly: true }), null);
});

test("Neo Destiny exact-printing half-grade sales give a reference for a scratched CGC slab and preserve its purchase verdict", async () => {
    const { key, record, row, value, bucket } = await fixture(24221);
    const labels = ["1st Edition Holofoil", "Unlimited Holofoil"];
    Object.assign(value.identity!, { set: "Neo Destiny", name: "Dark Gengar", cardNumber: "006/105" });
    Object.assign(value.listing, { title: "CGC 8.5 Dark Gengar 6/105 Neo Destiny Holo Pokemon Card", price: 999, shipping: 0 });
    value.condition = null;
    value.photoCheck!.holder = "GRADED_SLAB";
    value.photoCheck!.slab = { present: true, grader: "CGC", grade: "8.5", gradeQualifier: null, certNumber: "6216397042", labelText: "Dark Gengar CGC 8.5", caseCondition: "SCRATCHED", authenticity: "NONE_SEEN", concerns: [] };
    value.slab = { status: "OK", grader: "CGC", grade: "8.5", gradeQualifier: null, certNumber: "6216397042", certUrl: null, labelText: "Dark Gengar CGC 8.5", caseCondition: "SCRATCHED", reasons: [], concerns: [] };
    await writeCache(key.catalog, { ...record, name: "Dark Gengar", set: { name: "Neo Destiny" }, number: "006", total_set_number: "105", prices: labels.map(variant => ({ currency: "USD", variant })) });
    const soldAt = new Date(Date.now() - 29 * 86_400_000).toISOString();
    const grade = { ...bucket, count: 8, medianPrice: 874.5, lastSaleDate: soldAt, smartMarketPrice: { price: 927.93, daysUsed: 90, method: "90day_filtered_weighted", confidence: "medium" } };
    const variant = { salesByGrade: { cgc8_5: grade, cgc8: bucket, cgc9: bucket, psa7: bucket } };
    const market = { salesByGrade: { cgc8_5: { ...grade, medianPrice: 2760 } }, salesByPrinting: {
        "Unlimited Holofoil": variant, "1st Edition Holofoil": { salesByGrade: { cgc8_5: { ...grade, medianPrice: 2760 } } },
    } };
    const product = { ...row, setName: "Neo Destiny", name: "Dark Gengar", cardNumber: "006/105", totalSetNumber: 105, printingsAvailable: labels };
    const save = (ebay: unknown, printingsAvailable = labels) => writeCache(key.tracker, { data: { ...product, printingsAvailable, ebay } });
    const lookup = () => trackerPriceReference(value, undefined, { cacheOnly: true });
    await save(market);
    const before = structuredClone(value.underwriting);
    const result = await lookup();
    assert.equal(result?.printingLabel, "Unlimited Holofoil");
    assert.equal(result?.gradedMarket.priceUsd, 874.5);
    assert.equal(result?.gradedMarket.grade, "8.5");
    assert.equal(result?.gradedMarket.reportedSales, 8);
    assert.deepEqual(result?.gradedMarket.filteredEstimate, { priceUsd: 927.93, days: 90, confidence: "medium" });
    assert.deepEqual(value.underwriting, before);
    for (const unscoped of [{ salesByGrade: market.salesByGrade }, { ...market, salesByPrinting: { "1st Edition Holofoil": variant } },
        { ...market, salesByPrinting: { "Unlimited Holofoil": { salesByGrade: { psa8_5: grade, cgc9: grade } } } },
        { ...market, salesByPrinting: { "Unlimited Holofoil": { currency: "EUR", ...variant } } }]) {
        await save(unscoped);
        assert.equal(await lookup(), null);
    }
    await save({ salesByGrade: market.salesByGrade }, ["Unlimited Holofoil"]);
    assert.equal(await lookup(), null, "a single label on one provider cannot override a multi-printing catalog");
    await save(market);
    value.slab.caseCondition = "CRACKED";
    assert.equal(await lookup(), null);
    const raw = cardEvaluation();
    raw.identity = value.identity;
    raw.photoCheck!.cardCount = "ONE";
    raw.listing.title = "Dark Gengar 6/105 Neo Destiny Holo";
    assert.equal((await trackerPriceReference(raw, undefined, { cacheOnly: true }))?.gradedMarket.grader, "PSA");
    value.identity!.status = "NEEDS_REVIEW";
    assert.equal(await trackerPriceReference(raw, undefined, { cacheOnly: true }), null);
});

test("TCGplayer references select fresh named printing and condition data from the existing Tracker response", async () => {
    const { value, key, row } = await fixture(273);
    value.photoCheck!.cardMatch = { verdict: "MATCH", problems: [] };
    const point = (price: number, age: number) => ({ price, lastUpdated: new Date(Date.now() - age * 86400000).toISOString() });
    const variants = { Holofoil: { "Lightly Played Holofoil": point(48, 1), "Near Mint Holofoil": point(70, 1) },
        "1st Edition Holofoil": { "Lightly Played 1st Edition Holofoil": point(425, 1) } };
    const persist = (name = "Venusaur (15)") => writeCache(key.tracker, { data: { ...row, name, prices: { market: 600, variants } } });
    await persist();
    const check = async () => (await trackerMarketReferences(value, undefined, { cacheOnly: true }))?.trackerRawReference ?? null;
    assert.equal((await check())?.priceUsd, 48);
    await persist("Venusaur (18)");
    assert.equal(await check(), null);
    variants.Holofoil["Lightly Played Holofoil"] = point(50, 8);
    await persist();
    const cleaner = await check();
    assert.equal(cleaner?.priceUsd, 70);
    assert.equal(cleaner?.condition, "NEAR_MINT");
    variants.Holofoil["Near Mint Holofoil"] = point(72, 9);
    await persist();
    assert.equal(await check(), null);
});
