import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findDeals, type SearchSummary } from "../../server/deals/find-deals.ts";
import { readSearchLocally, readSearchWithoutAi } from "../../server/search/intent.ts";
import { readTitleByRules, readTitleWithoutAi, readTitlesWithoutAi } from "../../server/ai/title-reader.ts";
import { readCache, writeCache } from "../../server/lib/cache.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import { MODEL } from "../../server/ai/openai.ts";
import { canAutoAnalyze } from "../../shared/analysis.ts";
import { salesSummary } from "../fixtures/card-evaluation.ts";
import { explicitReprintSet } from "../../shared/reprint-release.ts";
import { evaluatedIdentityMismatch } from "../../shared/search-criteria.ts";
import type { Evaluation, ListingSummary } from "../../shared/types.ts";
import type { SourceDispositionRow } from "../../shared/search-diagnostic.ts";

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

test("bounded BIN search retains fifty unresolved rows without paid preliminary work across both source orders", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => { assert.fail("only the injected source may run; AI and price providers cannot dispatch"); });
    const sorts: string[] = [];
    let summary: SearchSummary | undefined;
    const emitted: ListingSummary[] = [];
    const page = Array.from({ length: 200 }, (_, index) => row(String(index)));
    const result = await findDeals("1999 Base Set Charizard holo", {
        filters: { typeFilter: "FIXED_PRICE" }, onStart: value => { summary = value; }, onListing: value => { emitted.push(value); } }, noPaidSteps(async (query, settings) => {
            sorts.push(settings.sort);
            assert.match(query, /charizard/);
            assert.equal(settings.maxResults, 200);
            return { listings: page, total: 5000, skipped: 0 };
        }));
    assert.deepEqual(sorts, ["newlyListed", "price"]);
    assert.equal(fetch.mock.callCount(), 0);
    // Results retain source order; concurrent cache reads can emit in any
    // completion order. Verify identical records without assuming timing.
    assert.deepEqual(result.map(listing => listing.id), Array.from({ length: 50 }, (_, index) => String(index)));
    assert.deepEqual(new Set(result.map(listing => listing.id)), new Set(emitted.map(listing => listing.id)));
    assert.equal(result.length, 50);
    assert.equal(summary?.mode, "development");
    assert.equal(summary?.count, 50);
    assert.equal(summary?.found, 200);
    assert.equal(summary?.screened, 200);
    assert.equal(summary?.deferred, 0);
    assert.equal(summary?.unresolvedOverflow, 150);
    assert.deepEqual(summary?.pricePass, { status: "COMPLETE", newListings: 0, candidates: 0 });
    assert.ok(result.every(listing => !canAutoAnalyze(listing)), "missing sold prices cannot authorize paid photos");
    assert.ok(result.every(listing => listing.screen?.soldEvidence?.status === "UNAVAILABLE"));
    assert.ok(result.every(listing => listing.screen?.status === "UNSCREENED" && listing.screen.bestCase === null));
});

test("sold-backed candidates after fifty unresolved rows stay eligible in a newest-only scan", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("the source and sold references are injected"));
    const title = "Charizard Base Set 4/102 Unlimited Holo English PSA 8";
    const page = Array.from({ length: 60 }, (_, index) => row(String(index), title, { isGraded: true, currentPrice: 80 }));
    const checked: string[] = [];
    let browseCalls = 0;
    let summary: SearchSummary | undefined;
    const overflow: { id: string; reason: string }[] = [];
    const dispositions: SourceDispositionRow[] = [];
    const dependencies = noPaidSteps(async (_query, options) => {
        browseCalls++;
        assert.equal(options.sort, "newlyListed");
        assert.equal(options.maxResults, 200);
        return { listings: page, total: page.length, skipped: 0, rejections: [] };
    });
    const result = await findDeals("Charizard Base Set holo PSA 8", {
        targets: { minProfit: 0, minRoi: 0 }, filters: { typeFilter: "FIXED_PRICE" },
        marketplaceOrder: "lowest", newOnly: { excludeIds: [] }, onStart: value => { summary = value; },
        onScreenedOverflow: row => overflow.push(row),
        onSourceDisposition: row => dispositions.push(row),
    }, {
        ...dependencies,
        soldScreening: () => async listing => {
            checked.push(listing.id);
            const index = Number(listing.id);
            if (index < 50 || index > 52) return { status: index % 2 ? "DEFERRED" : "UNAVAILABLE",
                exactScope: false, references: [], note: "No supported exact market yet." };
            return { status: "AVAILABLE", exactScope: true, note: "Exact, recent sold evidence.", references: [{
                recordId: 1, name: "Charizard", set: "Base Set", cardNumber: "4/102", printing: "UNLIMITED", finish: "HOLO",
                grader: "PSA", grade: "8", condition: null,
                summary: { ...salesSummary("PSA", "8", [180, 200, 220]), windowDays: 90 },
            }] };
        },
    });
    assert.equal(browseCalls, 1);
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(result.filter(canAutoAnalyze).map(listing => listing.id), ["50", "51", "52"]);
    assert.equal(result.length, 50);
    assert.deepEqual(result.filter(listing => !canAutoAnalyze(listing)).map(listing => listing.id), page.slice(0, 47).map(listing => listing.id));
    assert.equal(result[3].screen?.soldEvidence?.status, "UNAVAILABLE");
    assert.equal(result[4].screen?.soldEvidence?.status, "DEFERRED");
    assert.equal(summary?.screened, 54);
    assert.equal(summary?.deferred, 6, "stop once the small refill meets the supported candidate target");
    assert.equal(summary?.unresolvedOverflow, 4);
    assert.equal(summary?.marketplaceOrder, "newest", "Find new listings always uses newest inventory");
    assert.equal(summary?.sourceCoverage, "COMPLETE");
    assert.deepEqual(overflow, [47, 48, 49, 53].map(index => ({ id: String(index), reason: index % 2 ? "SOLD_EVIDENCE_DEFERRED" : "SOLD_EVIDENCE_MISSING" })));
    assert.deepEqual(dispositions, [54, 55, 56, 57, 58, 59].map(index => ({ id: String(index), outcome: "NOT_REACHED", reason: "ENOUGH_CANDIDATES" })));
    assert.equal(new Set(checked).size, 54);
});

test("wrong cards, sets, numbers, foreign titles, junk, budget exclusions and far-off auctions do not consume bounded slots", async () => {
    const page = [row("other-card", "Charmander Base Set 46/102 Holo"), row("other-set", "Charizard Base Set 2 4/130 Holo"),
        row("other-number", "Charizard Base Set 5/102 Holo"), row("foreign", "Charizard Japanese Base Set 4/102 Holo"),
        row("junk", "Charizard Base Set 4/102 custom proxy"), row("absurd", undefined, { currentPrice: 223200 }),
        row("far-auction", undefined, { buyingOption: "AUCTION", endTime: new Date(Date.now() + 7 * 86400000).toISOString() }),
        row("filtered-price", undefined, { currentPrice: 250 }), row("known"), row("one"), row("two"), row("three")];
    const dispositions: SourceDispositionRow[] = [];
    let summary: SearchSummary | undefined;
    const result = await findDeals("Charizard Base Set 4/102 holo", { filters: { maxPrice: 200 }, newOnly: { excludeIds: ["known"] },
        onSourceDisposition: row => dispositions.push(row), onStart: value => { summary = value; } },
        noPaidSteps(async () => ({ listings: page, total: page.length, skipped: 0 })));
    assert.deepEqual(result.map(listing => listing.id), ["one", "two", "three"]);
    assert.deepEqual(dispositions, [
        ["other-card", "OTHER_CARD"], ["other-set", "OTHER_SET"], ["other-number", "OTHER_CARD"],
        ["foreign", "OTHER_LANGUAGE"], ["junk", "JUNK"], ["absurd", "PRICE_ABOVE_CEILING"],
        ["far-auction", "OUTSIDE_AUCTION_WINDOW"], ["filtered-price", "ABOVE_MAX_PRICE"], ["known", "ALREADY_SEEN"],
    ].map(([id, reason]) => ({ id, reason, outcome: "REJECTED" })));
    assert.equal(summary?.sourceCoverage, "PARTIAL", "older adapter responses lack a rejection list");
});

test("a duplicate accepted in either source pass does not appear in rejected listings", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("source passes use saved fixtures"));
    const dispositions: SourceDispositionRow[] = [];
    const result = await findDeals("Charizard Base Set 4/102 Holo", { filters: { typeFilter: "FIXED_PRICE" },
        onSourceDisposition: row => dispositions.push(row) }, noPaidSteps(async (_query, options) => options.sort === "newlyListed" ? {
        listings: [row("first")], total: 5000, skipped: 2, rejections: [{ id: "second", reason: "VARIATION" }, { id: "lot", reason: "LOT" }],
    } : {
        listings: [row("second")], total: 5000, skipped: 2, rejections: [{ id: "first", reason: "VARIATION" }, { id: "lot", reason: "LOT" }],
    }));
    assert.deepEqual(result.map(listing => listing.id), ["first", "second"]);
    assert.deepEqual(dispositions, [{ id: "lot", outcome: "REJECTED", reason: "LOT" }]);
    assert.equal(fetch.mock.callCount(), 0);
});

test("known cached mismatches are excluded before filling fifty slots, including newest scans", async t => {
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
        newOnly: { excludeIds: [] }, onListing: listing => emitted.push(listing) }, dependencies);
    assert.equal(result.length, 50);
    assert.deepEqual(result.map(listing => listing.id), Array.from({ length: 50 }, (_, index) => String(index + 6)));
    assert.equal(emitted.length, 50);
    assert.ok(emitted.every(listing => !listing.match));
    assert.equal(reads, 100, "newest searches can check the loaded page for stronger matches without revisiting rows");
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

test("Base Set followed by the Blastoise collector fraction stays in the original market", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("collector-number disambiguation cannot call a provider"));
    const title = "Blastoise Base Set 2/102 Holo English";
    const spaced = "Blastoise Base Set 2 / 102 Holo English";
    const page = [row("original", title), row("original-spaced", spaced),
        row("reprint", "Blastoise Base Set 2 2/102 Holo English"),
        row("reprint-roman", "Blastoise Base Set II 2/102 Holo English"),
        row("reprint-separated", "Blastoise Base Set 2 / 2/130 Holo English")];
    for (const listing of page) {
        const reprint = listing.id.startsWith("reprint");
        assert.equal(explicitReprintSet(listing.title), reprint ? "Base Set 2" : null);
        const reading = readTitleByRules(listing.title, ["Base Set 2", "Base Set II"]);
        const number = listing.id === "reprint-separated" ? "2/130" : "2/102";
        assert.deepEqual([reading.cardName, reading.set, reading.cardNumber], ["blastoise", reprint ? "Base Set 2" : "Base Set", number]);
    }
    const saved = { kind: "SINGLE_CARD", cardName: "Blastoise", set: "Base Set 2", cardNumber: "2", language: "English", grader: null, grade: null, condition: null };
    const cacheKey = `title-reading:v6:${MODEL}:${title.toLowerCase()}`;
    await writeCache(cacheKey, saved);
    const result = await findDeals(title, {}, { ...noPaidSteps(async () => ({ listings: page, total: page.length, skipped: 0 })), readTitle: readTitleWithoutAi });
    assert.deepEqual(result.map(listing => listing.id), ["original", "original-spaced"]);
    assert.ok(result.every(listing => listing.screen?.card?.set === "Base Set" && listing.screen.card.cardNumber === "2/102"));
    assert.deepEqual(await readCache(cacheKey, 24), saved, "accepted cached metadata stays intact");
    assert.equal(fetch.mock.callCount(), 0);
});

test("literal reprint names correct an old seller-derived title cache without more AI", async t => {
    const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("cached title correction cannot call a provider"));
    const title = "Offline Charizard Celebration Base Set 4/102";
    await writeCache(`title-reading:v6:${MODEL}:${title.toLowerCase()}`, { kind: "SINGLE_CARD", cardName: "Charizard", set: "Base Set", cardNumber: "4/102", language: "English", grader: null, grade: null, condition: null });
    assert.equal((await readTitleWithoutAi(title)).set, "Celebrations");
    assert.equal(fetch.mock.callCount(), 0);
});

test("Prismatic Evolutions and XY Evolutions remain separate with or without saved metadata", async t => {
    const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("explicit release matching needs no provider"));
    const query = "Prismatic Evolutions holo";
    const modern = row("modern", "Umbreon ex 161/131 Prismatic — Evolutions Holo English");
    const older = row("older", "Charizard 11/108 XY Evolutions Holo English");
    for (const catalog of [[], ["Evolutions", "Prismatic Evolutions"]]) {
        const intent = readSearchLocally(query, catalog);
        assert.deepEqual([intent.sets, intent.cardName], [["Prismatic Evolutions"], null]);
        assert.equal(readTitleByRules(modern.title, catalog).cardName, "umbreon ex");
        assert.equal(readTitleByRules("Umbreon ex 161/131 Scarlet & Violet Prismatic Evolutions Holo", catalog).cardName, "umbreon ex");
        assert.equal(readTitleByRules(older.title, catalog).cardName, "charizard");
    }
    assert.equal(explicitReprintSet(modern.title), null);
    assert.equal(explicitReprintSet(older.title), "Evolutions");
    const titleCache = `title-reading:v6:${MODEL}:${modern.title.toLowerCase()}`;
    const intentCache = `search-intent:v2:${MODEL}:${query.toLowerCase()}`;
    const savedTitle = { ...readTitleByRules(modern.title), cardName: "Umbreon ex prismatic", set: "Evolutions" };
    const savedIntent = { ...readSearchLocally(query), sets: ["XY Evolutions"], cardName: "Prismatic", titleWords: ["prismatic"], keywords: "XY Evolutions" };
    await writeCache(titleCache, savedTitle);
    await writeCache(intentCache, savedIntent);
    assert.deepEqual((await readSearchWithoutAi(query)).sets, ["Prismatic Evolutions"]);
    const steps = {
        ...noPaidSteps(async () => ({ listings: [older, modern], total: 2, skipped: 0 })),
        readIntent: readSearchWithoutAi, readTitle: readTitleWithoutAi,
    };
    assert.deepEqual((await findDeals(query, {}, steps)).map(listing => listing.id), ["modern"]);
    assert.deepEqual((await findDeals("XY Evolutions holo", {}, steps)).map(listing => listing.id), ["older"]);
    const assessed = (set: string) => ({ identity: { status: "IDENTIFIED", set, finish: "HOLO" } }) as Evaluation;
    assert.equal(evaluatedIdentityMismatch(assessed("Scarlet & Violet Prismatic Evolutions"), readSearchLocally(query)), null);
    assert.equal(evaluatedIdentityMismatch(assessed("XY Evolutions"), readSearchLocally("XY Evolutions holo")), null);
    assert.equal(evaluatedIdentityMismatch(assessed("XY Evolutions"), readSearchLocally(query)), "OTHER_SET");
    assert.equal(evaluatedIdentityMismatch(assessed("Prismatic Evolutions"), readSearchLocally("XY Evolutions holo")), "OTHER_SET");
    assert.deepEqual(await readCache(titleCache, 24), savedTitle);
    assert.deepEqual(await readCache(intentCache, 24), savedIntent);
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

test("a batched title read preserves saved corrections and ordinary literal fallbacks", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("batched title reuse cannot invoke a provider"));
    const savedTitle = "Offline Charizard batch reading", literalTitle = "Charizard Base Set 4/102 Holo";
    const saved = { kind: "SINGLE_CARD", cardName: "Charizard", set: "Base Set", cardNumber: "4/102", language: "English", grader: null, grade: null, condition: "Near Mint" };
    await writeCache(`title-reading:v6:${MODEL}:${savedTitle.toLowerCase()}`, saved);
    const readings = await readTitlesWithoutAi([savedTitle, literalTitle, savedTitle]);
    assert.equal(readings.size, 2);
    assert.deepEqual(readings.get(savedTitle), saved);
    assert.deepEqual(readings.get(literalTitle), await readTitleWithoutAi(literalTitle));
    await writeCache(`title-reading:v6:${MODEL}:${literalTitle.toLowerCase()}`, { kind: "SINGLE_CARD", cardName: 42 });
    await assert.rejects(readTitlesWithoutAi([literalTitle]), StorageUnavailableError);
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
