import assert from "node:assert/strict";
import test from "node:test";
import { supplementalResearch } from "../../server/pricing/supplemental-research.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";
import { underwrite } from "../../shared/money/underwriting.ts";

const options = { cacheOnly: false, signal: new AbortController().signal, now: Date.now() };
function candidate() {
    const e = cardEvaluation();
    Object.assign(e.listing, { buyingOption: "FIXED_PRICE", availability: "ACTIVE", endTime: null, shipping: 3, price: 25 });
    e.photoCheck!.cardCount = "ONE";
    e.rawPricing = { status: "PRICE_UNAVAILABLE" };
    e.gradedPricing = null;
    e.underwriting = underwrite(e);
    return e;
}

test("research checks both providers for the photographed condition and keeps context out of the profit calculation", async () => {
    const calls: string[] = [], value = candidate();
    const web = { checkedAt: new Date().toISOString(), observations: [] };
    const result = await supplementalResearch(value, options, {
        tracker: async (_e, _signal, opts) => { calls.push("tracker"); assert.equal(opts?.cacheOnly, false); return null; },
        web: async (market, opts) => { calls.push("web"); assert.equal(opts?.cacheOnly, false);
            assert.equal(market.grade, "Lightly Played"); assert.equal(market.printingLabel, "Unlimited"); return web; },
    });
    assert.deepEqual(calls, ["tracker", "web"]);
    assert.deepEqual(result, { webPriceResearch: web });
    assert.equal(value.underwriting?.verdict, "CANT_PRICE");
});

test("an adaptive lookup dispatches only the provider the planner selected", async () => {
    for (const source of ["tracker", "web"] as const) {
        const calls: string[] = [];
        await supplementalResearch(candidate(), { ...options, source }, {
            tracker: async () => { calls.push("tracker"); return null; },
            web: async () => { calls.push("web"); return null; },
        });
        assert.deepEqual(calls, [source]);
    }
});

test("price refresh and sufficient exact condition sales only read cached references", async () => {
    for (const cacheOnly of [true, false]) {
        const value = candidate();
        if (!cacheOnly) value.rawPricing = { status: "PRICED", prices: [{ condition: "LIGHTLY_PLAYED", price: 45,
            updatedAt: null, basis: "EBAY_SOLD", comps: salesSummary("RAW", "LIGHTLY_PLAYED", [41, 45, 48]) }] };
        const requested: boolean[] = [];
        await supplementalResearch(value, { ...options, cacheOnly }, {
            tracker: async (_e, _sig, opts) => { requested.push(opts!.cacheOnly!); return null; },
            web: async (_target, opts) => { requested.push(opts!.cacheOnly!); return null; },
        });
        assert.deepEqual(requested, [true, true]);
    }
});

test("the buyer comparison requests fresh sources even when matched sales already price the copy", async () => {
    const value = candidate(), modes: boolean[] = [];
    value.rawPricing = { status: "PRICED", prices: [{ condition: "LIGHTLY_PLAYED", price: 45, updatedAt: null,
        basis: "EBAY_SOLD", comps: salesSummary("RAW", "LIGHTLY_PLAYED", [41, 45, 48]) }] };
    await supplementalResearch(value, { ...options, comparePrices: true }, {
        tracker: async (_e, _sig, opts) => { modes.push(opts!.cacheOnly!); return null; },
        web: async (_target, opts) => { modes.push(opts!.cacheOnly!); return null; },
    });
    assert.deepEqual(modes, [false, false]);
});

test("unresolved printing skips secondary pricing and a storage failure blocks subsequent paid calls", async () => {
    const value = candidate();
    const fail = new StorageUnavailableError();
    let n = 0;
    const sources = { tracker: async () => { n++; throw fail; }, web: async () => { throw Error("Unexpected dispatch"); } };
    value.identity!.status = "NEEDS_REVIEW";
    assert.deepEqual(await supplementalResearch(value, options, sources), {});
    assert.equal(n, 0);
    value.identity!.status = "IDENTIFIED";
    await assert.rejects(supplementalResearch(value, options, sources), error => error === fail);
    assert.equal(n, 1);
});

test("a narrow provisional raw grade uses only saved Tracker evidence when both sides are shown", async () => {
    const value = candidate();
    Object.assign(value.listing, { sellerCondition: "Ungraded" });
    Object.assign(value.photoCheck!, { holder: "OTHER", cardMatch: { verdict: "MATCH", problems: [] } });
    Object.assign(value.condition!, { rawCondition: "UNKNOWN", gradeRange: null });
    value.provisionalGradeRange = { low: 5, likely: 6, high: 7 };
    const before = structuredClone(value.underwriting);
    const reference = { source: "POKEMON_PRICE_TRACKER" as const, tcgPlayerId: 84599, printingLabel: "Unlimited Holofoil",
        gradedMarket: { grade: "6", grader: "PSA", priceUsd: 494, statistic: "7_DAY_MEDIAN" as const, reportedSales: 33,
            lastSaleAt: new Date().toISOString(), marketplaces: ["eBay", "Fanatics Collect"] }, caveat: "Conditional on PSA 6." };
    let lookups = 0;
    const sources = { tracker: async (_e, _s, opts) => { lookups++; assert.equal(opts.cacheOnly, true); return { trackerPriceReference: reference }; },
        web: async () => { throw Error("A provisional grade cannot start a web search."); } } satisfies NonNullable<Parameters<typeof supplementalResearch>[2]>;
    assert.deepEqual(await supplementalResearch(value, options, sources), { trackerPriceReference: reference });
    for (const condition of ["no back", "stock back", "wide grade", "identity unresolved", "suspected crease", "unverified holder"]) {
        const invalid = structuredClone(value);
        if (condition === "no back") invalid.photoCheck!.images = invalid.photoCheck!.images.filter(image => image.view !== "BACK");
        if (condition === "stock back") invalid.photoCheck!.images.find(image => image.view === "BACK")!.isStockImage = true;
        if (condition === "wide grade") invalid.provisionalGradeRange!.high = 9;
        if (condition === "identity unresolved") invalid.identity!.status = "NEEDS_REVIEW";
        if (condition === "suspected crease") invalid.condition!.creases = "SUSPECTED";
        if (condition === "unverified holder") invalid.listing.sellerCondition = null;
        assert.deepEqual(await supplementalResearch(invalid, options, sources), {}, condition);
    }
    assert.equal(lookups, 1);
    assert.deepEqual(value.underwriting, before);
});

test("a recoverable Tracker failure still checks web sales under the original research policy", async () => {
    const web = { checkedAt: new Date().toISOString(), observations: [] };
    const result = await supplementalResearch(candidate(), options, {
        tracker: async () => { throw new Error("provider timed out"); },
        web: async (_market, options) => { assert.equal(options?.cacheOnly, false); return web; },
    });
    assert.deepEqual(result.webPriceResearch, web);
    assert.match(result.supplementalPriceNote!, /Pokémon Price Tracker/);
});
