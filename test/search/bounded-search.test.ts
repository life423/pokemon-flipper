import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDeals, type SearchSummary } from "../../server/deals/find-deals.ts";
import { readSearchLocally, readSearchWithoutAi } from "../../server/search/intent.ts";
import { readTitleByRules, readTitleWithoutAi } from "../../server/ai/title-reader.ts";
import { readCache, writeCache } from "../../server/lib/cache.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import { MODEL } from "../../server/ai/openai.ts";
import { canAutoAnalyze } from "../../shared/analysis.ts";
import type { ListingSummary } from "../../shared/types.ts";

const row = (id: string, title = "Charizard Base Set 4/102 Holo English", extra: Partial<ListingSummary> = {}): ListingSummary => ({
    id, title, currentPrice: 80, shipping: 5, buyingOption: "FIXED_PRICE", bids: 0, isGraded: false,
    endTime: null, images: ["https://i.ebayimg.com/images/g/offline/s-l1600.jpg"], seller: null, url: "#", ...extra,
});
function noPaidSteps(search: (query: string, options: any) => Promise<any>) {
    return { search,
        soldScreening: () => async () => ({ status: "UNAVAILABLE" as const, exactScope: false, references: [], note: "No saved sold-price evidence in this metadata fixture." }),
        readIntent: async (query: string) => readSearchLocally(query),
        readTitle: async (title: string) => readTitleByRules(title),
    };
}

test("local bounded metadata transcribes explicit names and numbers without inventing a denominator", () => {
    const text = readTitleByRules("Charizard 4/102 Base Set Holo English PSA 8");
    assert.deepEqual([text.cardName, text.cardNumber, text.set, text.grader, text.grade, text.language], ["charizard", "4/102", "Base Set", "PSA", "8", "English"]);
    assert.equal(readTitleByRules("Aquapolis H28 Holo").cardNumber, "H28");
    assert.equal(readTitleByRules("Galarian Sirfetch'd SWSH050 Promo").cardNumber, "SWSH050");
    assert.equal(readTitleByRules("Charizard ex SVP074 Promo").cardNumber, "SVP074");
    assert.equal(readTitleByRules("Charizard 1999 PSA 8").cardNumber, null);
    assert.equal(readTitleByRules("Charizard #4 Base Set").cardNumber, "4");
    assert.equal(readTitleByRules("Charizard 4/102 Base Set 2").set, "Base Set 2");
    assert.equal(readTitleByRules("Unown A").cardName, "unown a");
    assert.deepEqual(readSearchLocally("1999 base set charizard holo").titleWords, ["charizard"]);
    assert.deepEqual(readSearchLocally("4/102").titleWords, []);
    assert.equal(readSearchLocally("4/102").cardNumber, "4/102");
    assert.deepEqual(readSearchLocally("1999 base set holo").sets, ["Base Set"]);
});

test("bounded search admits50 matching metadata rows from one newest BIN page without paid preliminary work", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => { assert.fail("only the injected source may run; AI and price providers cannot dispatch"); });
    let sources = 0;
    let summary: SearchSummary | undefined;
    const emitted: ListingSummary[] = [];
    const page = Array.from({ length: 200 }, (_, index) => row(String(index)));
    const result = await findDeals("1999 Base Set Charizard holo", {
        filters: { typeFilter: "FIXED_PRICE" }, onStart: value => { summary = value; }, onListing: value => { emitted.push(value); } }, noPaidSteps(async (query, settings) => {
            sources++;
            assert.match(query, /charizard/);
            assert.equal(settings.maxResults, 200);
            assert.equal(settings.sort, "newlyListed");
            return { listings: page, total: 5000, skipped: 0 };
        }));
    assert.equal(sources, 1);
    assert.equal(fetch.mock.callCount(), 0);
    // Results retain source order; concurrent cache reads can emit in any
    // completion order. Verify identical records without assuming timing.
    assert.deepEqual(result.map(listing => listing.id), Array.from({ length: 50 }, (_, index) => String(index)));
    assert.deepEqual(new Set(result.map(listing => listing.id)), new Set(emitted.map(listing => listing.id)));
    assert.equal(result.length, 50);
    assert.equal(summary?.mode, "development");
    assert.equal(summary?.count, 50);
    assert.equal(summary?.deferred, 150);
    assert.ok(result.every(listing => !canAutoAnalyze(listing)), "missing sold prices cannot authorize paid photos");
    assert.ok(result.every(listing => listing.screen?.soldEvidence?.status === "UNAVAILABLE"));
    assert.ok(result.every(listing => listing.screen?.status === "UNSCREENED" && listing.screen.bestCase === null));
});

test("wrong cards, sets, numbers, foreign titles, junk, budget exclusions and far-off auctions do not consume bounded slots", async () => {
    const page = [row("other-card", "Charmander Base Set 46/102 Holo"), row("other-set", "Charizard Base Set 2 4/130 Holo"),
        row("other-number", "Charizard Base Set 5/102 Holo"), row("foreign", "Charizard Japanese Base Set 4/102 Holo"),
        row("junk", "Charizard Base Set 4/102 custom proxy"), row("absurd", undefined, { currentPrice: 223200 }),
        row("far-auction", undefined, { buyingOption: "AUCTION", endTime: new Date(Date.now() + 7 * 86400000).toISOString() }),
        row("filtered-price", undefined, { currentPrice: 250 }), row("known"), row("one"), row("two"), row("three")];
    const result = await findDeals("Charizard Base Set 4/102 holo", { filters: { maxPrice: 200 }, newOnly: { excludeIds: ["known"] } },
        noPaidSteps(async () => ({ listings: page, total: page.length, skipped: 0 })));
    assert.deepEqual(result.map(listing => listing.id), ["one", "two", "three"]);
});

test("known cached mismatches are excluded before filling50 slots, including newest scans", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("metadata admission cannot call a provider"));
    const page = Array.from({ length: 100 }, (_, index) => row(String(index)));
    const emitted: ListingSummary[] = [];
    let reads = 0;
    const dependencies = { ...noPaidSteps(async () => ({ listings: page, total: 100, skipped: 0 })),
        readTitle: async (title: string) => {
            const reading = readTitleByRules(title);
            return { ...reading, set: reads++ < 6 ? "Jungle" : reading.set };
        } };
    const result = await findDeals("Charizard Base Set 4/102 holo", {
        newOnly: { excludeIds: [], limit: 50 }, onListing: listing => emitted.push(listing) }, dependencies);
    assert.equal(result.length, 50);
    assert.deepEqual(result.map(listing => listing.id), Array.from({ length: 50 }, (_, index) => String(index + 6)));
    assert.equal(emitted.length, 50);
    assert.ok(emitted.every(listing => !listing.match));
    assert.equal(reads, 56, "only enough free metadata is read to fill the matching batch; rows are not checked twice");
    assert.equal(fetch.mock.callCount(), 0);
});

test("number-only bounded searches do not invent a Pokemon or reject a matching card", async () => {
    const result = await findDeals("4/102", {}, noPaidSteps(async () => ({ listings: [row("one")], total: 1, skipped: 0 })));
    assert.equal(result.length, 1);
    assert.equal(result[0].screen?.card?.cardNumber, "4/102");
});

test("explicit reprint releases are excluded before bounded slots without paid interpretation", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("reprint rejection cannot call a provider"));
    const page = [
        row("celebration", "Pokemon 30th Celebration Charizard 4/102"),
        row("celebrations", "Charizard Base Set Celebrations 4/102 English"),
        row("anniversary", "Charizard 25th Anniversary 4/102 English"),
        row("evolutions", "Charizard Base Set XY Evolutions 11/108 Holo"),
        row("legendary", "Charizard Base Set Legendary Collection Holo 3/110"),
        row("base-two", "Charizard Base Set 2 4/102 Holo"), row("one"), row("two"), row("three"),
    ];
    const result = await findDeals("1999 Base Set Charizard holo", {}, noPaidSteps(async () => ({ listings: page, total: page.length, skipped: 0 })));
    assert.deepEqual(result.map(listing => listing.id), ["one", "two", "three"]);
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(readTitleByRules(page[0].title).set, "30th Celebration");
    assert.equal(readTitleByRules(page[0].title).cardName, "charizard");
    assert.equal(readTitleByRules("Charizard Celebration 4/102").set, "Celebrations");
});

test("literal reprint names correct an old seller-derived title cache without more AI", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("cached title correction cannot call a provider"));
    const title = "Offline Charizard Celebration Base Set 4/102";
    await writeCache(`title-reading:v6:${MODEL}:${title.toLowerCase()}`, { kind: "SINGLE_CARD", cardName: "Charizard", set: "Base Set", cardNumber: "4/102", language: "English", grader: null, grade: null, condition: null });
    assert.equal((await readTitleWithoutAi(title)).set, "Celebrations");
    assert.equal(fetch.mock.callCount(), 0);
});

test("bounded helpers reuse existing paid title and intent readings without invoking AI", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => { assert.fail("saved metadata must be reused without provider calls"); });
    const title = "Offline Charizard metadata reuse";
    const reading = { kind: "SINGLE_CARD", cardName: "Charizard", set: "Base Set", cardNumber: "4/102", language: "English", grader: null, grade: null, condition: "Near Mint" };
    await writeCache(`title-reading:v6:${MODEL}:${title.toLowerCase()}`, reading);
    assert.deepEqual(await readTitleWithoutAi(title), reading);
    const query = "offline charizard cache reuse";
    const saved = { ...readSearchLocally(query), cardName: "Charizard", sets: ["Base Set"], titleWords: ["charizard"], keywords: "Charizard Base Set", source: "ai" };
    await writeCache(`search-intent:v2:${MODEL}:${query}`, saved);
    const reused = await readSearchWithoutAi(query);
    assert.equal(reused.source, "ai");
    assert.deepEqual(reused.sets, ["Base Set"]);
    assert.deepEqual(reused.titleWords, ["charizard"]);
    assert.equal(fetch.mock.callCount(), 0);
});

test("saved intent numbers cannot replace omitted, partial or lettered numbers with a model guess", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("saved intent corrections must remain free"));
    for (const [query, expected] of [["Dark Blastoise Team Rocket holo", null], ["Dark Blastoise Team Rocket #3 holo", "3"],
        ["Espeon Aquapolis H9/H32 holo", "H9/H32"], ["Galarian Sirfetch'd SWSH050 promo", "SWSH050"]]) {
        const saved = { ...readSearchLocally(query), cardNumber: "4/82", source: "ai" };
        const key = `search-intent:v2:${MODEL}:${query.toLowerCase()}`;
        await writeCache(key, saved);
        assert.equal((await readSearchWithoutAi(query)).cardNumber, expected, query);
        assert.deepEqual(await readCache(key, 24), saved, "the accepted cache payload remains unchanged");
    }
});

test("invalid saved bounded metadata fails closed rather than becoming a new AI request", async () => {
    const query = "offline invalid saved query";
    await writeCache(`search-intent:v2:${MODEL}:${query}`, { sets: [], titleWords: "bad" });
    await assert.rejects(readSearchWithoutAi(query), StorageUnavailableError);
    const title = "Offline invalid title cache";
    await writeCache(`title-reading:v6:${MODEL}:${title.toLowerCase()}`, { kind: "SINGLE_CARD", cardName: 42 });
    await assert.rejects(readTitleWithoutAi(title), StorageUnavailableError);
});

test("cancelling bounded query interpretation prevents the source request", async () => {
    const stopped = new AbortController();
    const dependencies = noPaidSteps(async () => { assert.fail("cancelled search cannot consume eBay allowance"); });
    const result = await findDeals("charizard", { signal: stopped.signal }, { ...dependencies,
        readIntent: async () => { stopped.abort(); return readSearchLocally("charizard"); } });
    assert.deepEqual(result, []);
});

test("cancelling a bounded cached title read prevents emitted work and later stages", async () => {
    const stopped = new AbortController();
    let emitted = 0;
    const dependencies = noPaidSteps(async () => ({ listings: [row("one")], total: 1, skipped: 0 }));
    const result = await findDeals("charizard", { signal: stopped.signal, onListing: () => { emitted++; } }, { ...dependencies,
        readTitle: async title => { stopped.abort(); return readTitleByRules(title); } });
    assert.deepEqual(result, []);
    assert.equal(emitted, 0);
});
