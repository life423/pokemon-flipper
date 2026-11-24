import assert from "node:assert/strict";
import test from "node:test";
import type { ListingSummary, SearchIntent } from "../../shared/types.ts";
import { getAiUsageContext } from "../../server/ai/usage-context.ts";
import { discoverMarketListings, type MarketQueryObservation } from "../../server/analysis/same-set-listings.ts";
import { EbayBudgetError } from "../../server/ebay/daily-budget.ts";
import { shortlistMarketCopies } from "../../server/analysis/deal-hunt-market-checks.ts";

const source = "743c9275-1cb4-4cd5-8ced-0ffe67777611";
const market: SearchIntent = { cardName: "Dark Gengar", sets: ["Neo Destiny"], cardNumber: "6/105", printing: "UNLIMITED",
    finish: "HOLO", graded: false, titleWords: ["dark", "gengar"], source: "rules" };
const signal = new AbortController().signal;
function listing(index: number, title: string, overrides: Partial<ListingSummary> = {}): ListingSummary {
    const number = 120000000000 + index;
    return { id: `v1|${number}|0`, url: `https://www.ebay.com/itm/${number}`, title, buyingOption: "FIXED_PRICE",
        currentPrice: 50, shipping: 5, isGraded: false, bids: 0, seller: null, endTime: null, images: ["photo"], ...overrides };
}
const knownSets = async () => ["Silver Tempest", "Neo Destiny"];

const leafeon: SearchIntent = { ...market, cardName: "Leafeon V (Alternate Full Art)", sets: ["SWSH07: Evolving Skies"], cardNumber: "167/203" };
const aliases = ["Leafeon V (Alternate Full Art) 167 Evolving Skies", "167/203", "Evolving Skies 167"];
const onPage = (listings: ListingSummary[]) => ({ listings, total: listings.length, skipped: 0 });

test("three same-ceiling searches admit name-free anchored leads, retain overlap and skip explicit contradictions", async () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    const row = (id: number, title: string, fields: Partial<ListingSummary> = {}) => listing(id, title,
        { listedAt: new Date(now - 1000).toISOString(), currentPrice: 25, ...fields });
    const old = row(1, "Leafeon V 167/203", { listedAt: new Date(now - 86_400_000).toISOString() });
    const named = row(2, "Leafeon V 167/203 Evolving Skies"), nameless = row(3, "Old shiny Pokémon 167/203");
    const setOnly = row(4, "Pokémon card Evolving Skies 167");
    const numberFirst = row(5, "167 Evolving Skies holo");
    const rejects = ["Espeon V 167/203", "Leafeon VMAX 167/203", "Pokémon card 167/204", "Evolving Skies 1167",
        "Evolving Skies 167.5", "Evolving Skies $167", "Evolving Skies $ 167", "Evolving Skies 167 HP", "Espeon V 167/203 in my collection",
        "Leafeon V 167/203 Extended Artwork Case", "Pokémon 167/203 Japanese", "Pokémon 167/203 proxy",
        "Silver Tempest 167/203"].map((title, index) => row(20 + index, title));
    const pages = [[old], [named, nameless, ...rejects, row(8, named.title, { currentPrice: 33.86 })], [named, setOnly, setOnly, numberFirst]];
    const observations: MarketQueryObservation[] = [];
    let calls = 0;
    const result = await discoverMarketListings(source, leafeon, { maxPrice: 33.85 }, signal, {
        knownSets, now: () => now, newlyListedRaw: true, collectorNumberDiscovery: "compare", onQuery: note => observations.push(note),
        search: async (query, options) => {
            assert.equal(query, aliases[calls]);
            assert.deepEqual(options, { sort: "newlyListed", filters: { maxPrice: 33.85, typeFilter: "FIXED_PRICE", kindFilter: "raw" },
                maxResults: 200, keepReserve: true, signal });
            return onPage(pages[calls++]);
        },
    });
    assert.equal(calls, 3);
    assert.deepEqual(result.map(row => row.id), [named.id, nameless.id, setOnly.id, numberFirst.id]);
    assert.equal(result[1].screen?.card?.name, null);
    assert.ok(result.every(row => row.found?.how === "NUMBER_ONLY"));
    assert.deepEqual(observations.map(note => note.eligibleIds), [[], [named.id, nameless.id], [named.id, setOnly.id, numberFirst.id]]);
    assert.deepEqual(observations.map(note => note.numberOnlyIds), [[], [nameless.id], [setOnly.id, numberFirst.id]]);
    assert.deepEqual(observations.map(note => note.newEligibleIds), [[], [named.id, nameless.id], [setOnly.id, numberFirst.id]]);
    assert.deepEqual(observations[2].returnedIds, [named.id, setOnly.id, numberFirst.id]);
});

test("fallback expands only when the full-name query has no new usable copy", async () => {
    const known = listing(1, "Leafeon V 167/203"), expensiveShipping = listing(2, known.title, { shipping: 100 });
    const possible = listing(3, "Pokémon card 167/203");
    for (const [hasNew, expected] of [[true, 1], [false, 3]] as const) {
        const notes: MarketQueryObservation[] = [];
        const found = await discoverMarketListings(source, leafeon, {}, signal, { knownSets, collectorNumberDiscovery: "fallback",
            knownListingIds: new Set([known.id]), isUsable: row => (row.shipping ?? 0) < 10, onQuery: note => notes.push(note),
            search: async query => onPage(query === aliases[0] ? [known, expensiveShipping, ...(hasNew ? [possible] : [])] : [possible]) });
        assert.equal(notes.length, expected);
        assert.deepEqual(found.map(row => row.id), [possible.id]);
        assert.deepEqual(notes[0].newEligibleIds, hasNew ? [possible.id] : []);
        assert.deepEqual(notes[0].numberOnlyIds, hasNew ? [possible.id] : []);
    }
});

test("alternate artwork keeps the printed name and normalized number, while another set or denominator stays excluded", async () => {
    const target = { ...leafeon, cardNumber: " # 167 / 203 " };
    const plainName = listing(1, "Leafeon V 167/203 Evolving Skies");
    const packed = listing(2, "Leafeon V 167/203 Evolving Skies - shipped in a penny sleeve");
    const wrong = ["Leafeon V 167/203 Silver Tempest", "Leafeon V 167/204 Evolving Skies", "Leafeon VMAX 167/203 Evolving Skies shipped in a sleeve",
        "Espeon V 167/203 Evolving Skies shipped in a holder"].map((title, i) => listing(i + 3, title));
    const notes: MarketQueryObservation[] = [];
    const found = await discoverMarketListings(source, target, {}, signal, { knownSets, collectorNumberDiscovery: "compare",
        relatedIntents: [{ ...leafeon, cardNumber: "167/204" }, { ...leafeon, cardNumber: "167/junk" }],
        onQuery: note => notes.push(note), search: async query => onPage(query === aliases[0] ? [] : [plainName, packed, ...wrong]) });
    assert.deepEqual(notes.map(note => note.query), aliases);
    assert.deepEqual(found.map(row => row.id), [plainName.id, packed.id]);
    assert.deepEqual(notes[1].numberOnlyIds, [packed.id]);
});

test("a catalog numerator discovers only by set and number, preserving prefixes and suffix letters", async () => {
    for (const [num, set, printed] of [["167", "Evolving Skies", "167"], ["TG01", "Silver Tempest", "TG1"], ["25a", "Neo Destiny", "25a"]]) {
        const notes: MarketQueryObservation[] = [];
        const expected = listing(1, `Pokémon card ${set} ${printed}`);
        const same = listing(2, `Leafeon V ${printed}/203 ${set}`);
        const wrong = [`old shiny card ${printed}/203`, `Leafeon V ${printed}/203`, "Leafeon V", `${set} ${printed}b`, `Espeon V ${set} ${printed}`,
            `Leafeon V ${set} ${printed}/203 ${printed}/204`];
        if (num !== "167") wrong.push(`${set} ${parseInt(printed.replace(/^[a-z]+/i, ""), 10)}`);
        const found = await discoverMarketListings(source, { ...leafeon, cardNumber: num, sets: [set] }, {}, signal, {
            knownSets, collectorNumberDiscovery: "fallback", onQuery: note => notes.push(note),
            search: async query => onPage(query === `${set} ${num}` ? [expected, same, ...wrong.map((title, i) => listing(i + 3, title))] : []),
        });
        assert.deepEqual(notes.map(note => [note.strategy, note.query]), [
            ["full_name", `${leafeon.cardName} ${num} ${set}`], ["set_number", `${set} ${num}`],
        ]);
        assert.deepEqual(found.map(row => row.id), [expected.id, same.id], num);
        assert.deepEqual(notes[1].numberOnlyIds, [expected.id]);
    }
});

test("slabs, auctions and malformed collector numbers use their single full-name query", async () => {
    for (const [intent, typeFilter] of [[leafeon, "AUCTION"], [{ ...leafeon, graded: true, grader: "PSA", minGrade: 9, maxGrade: 9 }, "FIXED_PRICE"],
        [{ ...leafeon, cardNumber: "167/unknown" }, "FIXED_PRICE"]] as const) {
        let calls = 0;
        await discoverMarketListings(source, intent, { typeFilter }, signal, { knownSets, collectorNumberDiscovery: "compare",
            search: async () => { calls++; return onPage([]); } });
        assert.equal(calls, 1);
    }
});

test("an optional quota limit preserves completed pages, while baseline and accounting errors propagate", async () => {
    const candidate = listing(1, "Leafeon V 167/203");
    const observations: MarketQueryObservation[] = [];
    const found = await discoverMarketListings(source, leafeon, {}, signal, { knownSets, collectorNumberDiscovery: "compare",
        onQuery: note => observations.push(note), search: async query => {
            if (query === aliases[2]) throw new EbayBudgetError("reserved", "QUOTA");
            return onPage(query === aliases[0] ? [] : [candidate]);
        } });
    assert.deepEqual(found.map(row => row.id), [candidate.id]);
    assert.deepEqual(observations.map(note => note.status), ["complete", "complete", "quota"]);
    for (const [failAt, reason] of [[0, "QUOTA"], [1, "ACCOUNTING"]] as const) {
        const error = new EbayBudgetError("failed", reason);
        await assert.rejects(discoverMarketListings(source, leafeon, {}, signal, { knownSets, collectorNumberDiscovery: "compare",
            search: async query => { if (query === aliases[failAt]) throw error; return onPage([]); } }), error);
    }
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(discoverMarketListings(source, leafeon, {}, controller.signal, { knownSets, collectorNumberDiscovery: "compare",
        onQuery: () => controller.abort(), search: async () => { calls++; return onPage([]); } }), { name: "AbortError" });
    assert.equal(calls, 1);
});

test("fresh grading discovery asks eBay for newest raw copies and uses the original listing date when supplied", async () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    const date = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const title = "Dark Gengar 6/105 Neo Destiny Unlimited Holo";
    const rows = [listing(1, title, { listedAt: date(2) }), listing(2, title, { createdAt: date(3) }),
        listing(3, title, { listedAt: date(24), createdAt: date(1) }), listing(4, title), listing(5, title, { listedAt: date(-1) })];
    const found = await discoverMarketListings(source, market, { maxPrice: 100 }, signal, { knownSets, now: () => now, newlyListedRaw: true,
        search: async (_query, options) => {
            assert.equal(options?.sort, "newlyListed");
            assert.equal(options?.cacheMode, undefined);
            assert.equal(options?.filters?.kindFilter, "raw");
            assert.equal(options?.filters?.typeFilter, "FIXED_PRICE");
            return { listings: rows, total: rows.length, skipped: 0 };
        } });
    assert.deepEqual(found.map(row => row.id), [rows[0].id, rows[1].id]);
});

test("a liquid-market search spends a single reserved Browse page under the original search and screens the returned copies", async () => {
    const original = listing(1, "Dark Gengar 6/105 Neo Destiny Unlimited Holo");
    const numberless = listing(2, "Dark Gengar Neo Destiny");
    const others = [
        listing(3, "Dark Gengar 6/105 1st Edition"), listing(4, "Dark Gengar 6/105 Neo Destiny Reverse Holo"),
        listing(5, "Dark Gengar 6/105 Silver Tempest"), listing(6, "Dark Gengar 7/105 Neo Destiny"),
        listing(7, "Dark Gengar 6/105 Japanese"), listing(8, "Dark Gyarados 6/105 Neo Destiny"), listing(9, "Dark Gengar 6/105 lot of 3 cards"),
        listing(10, original.title, { buyingOption: "AUCTION" }), listing(11, original.title, { currentPrice: 101 }),
        listing(12, original.title, { currentPrice: 9 }), listing(13, original.title, { images: [] }), listing(14, original.title, { isGraded: true }),
        listing(15, original.title, { endTime: "2024-01-01T00:00:00Z" }), listing(16, original.title, { url: "https://example.org/" }),
    ];
    let requests = 0;
    const result = await discoverMarketListings(source, market, { minPrice: 10, maxPrice: 100 }, signal, {
        knownSets,
        search: async (query, options) => {
            requests++;
            assert.match(query, /Dark Gengar 6 Neo Destiny/);
            assert.equal(getAiUsageContext().searchId, source);
            assert.deepEqual(options, { sort: "price", filters: { typeFilter: "FIXED_PRICE", kindFilter: "raw", minPrice: 10, maxPrice: 100 },
                maxResults: 200, cacheMode: "resume", keepReserve: true, signal });
            return { listings: [original, ...others, original, numberless], total: 800, skipped: 0 };
        },
    });
    assert.equal(requests, 1);
    assert.deepEqual(result.map(row => row.id), [original.id, numberless.id]);
    assert.equal(result[1].screen?.status, "UNSCREENED");
});

test("a precise slab market excludes different holders, qualifiers and grades while keeping exact-grade half points", async () => {
    const slab = { ...market, graded: true, grader: "CGC", minGrade: 8.5, maxGrade: 8.5 };
    const rows = ["CGC 8.5", "CGC 8", "PSA 8.5", "CGC 8.5 (OC)"].map((grade, index) =>
        listing(index, `Dark Gengar Neo Destiny 6/105 ${grade}`, { isGraded: true }));
    const found = await discoverMarketListings(source, slab, {}, signal, { knownSets, search: async (query, options) => {
        assert.match(query, /CGC 8\.5$/);
        assert.equal(options?.filters?.kindFilter, "graded");
        return { listings: rows, total: rows.length, skipped: 0 };
    } });
    assert.deepEqual(found.map(row => row.id), [rows[0].id]);
});

test("a copy later in the same paid Browse page can win once destination shipping and tax are included", async () => {
    const title = "Dark Gengar Neo Destiny 6/105 Unlimited Holo";
    const unaffordable = Array.from({ length: 50 }, (_, index) => listing(index, title, { shipping: 90 }));
    const affordable = listing(50, title, { shipping: 0 });
    const rows = [...unaffordable, affordable], filters = { maxPrice: 100 };
    const found = await discoverMarketListings(source, market, filters, signal, {
        knownSets, search: async () => ({ listings: rows, total: rows.length, skipped: 0 }),
    });
    const shortlist = shortlistMarketCopies(found, {
        name: "Dark Gengar", set: "Neo Destiny", cardNumber: "6/105", printing: "UNLIMITED", finish: "HOLO", kind: "raw", condition: "LIGHTLY_PLAYED",
        grader: null, grade: null, sales30: 3, sales90: 3, latestSaleAt: new Date().toISOString(), medianUsd: 150, projectedProfit: null, listingIds: [],
    }, "resell", { minProfit: 0, minRoi: 0 }, filters);
    assert.deepEqual(shortlist.map(row => row.id), [affordable.id]);
});

test("unspecified markets, a different requested card kind, or prior cancellation avoid a provider search", async () => {
    const deps = { knownSets, search: async () => assert.fail("unexpected eBay call") };
    assert.deepEqual(await discoverMarketListings(source, market, { kindFilter: "graded" }, signal, deps), []);
    assert.deepEqual(await discoverMarketListings(source, { ...market, sets: [] }, {}, signal, deps), []);
    assert.deepEqual(await discoverMarketListings(source, { ...market, printing: null }, {}, signal, deps), []);
    assert.deepEqual(await discoverMarketListings("unknown", market, {}, signal, deps), []);
    await assert.rejects(discoverMarketListings(source, market, {}, AbortSignal.abort(), deps), { name: "AbortError" });
});

test("Browse uses seller-facing release names and card numbers while screening against the full catalog market", async () => {
    const cases = [
        { cardName: "Mew", set: "SWSH: Crown Zenith: Galarian Gallery", cardNumber: "GG10/GG70", grade: 9,
            query: "Mew GG10 Crown Zenith PSA 9",
            matching: "Mew GG10/GG70 Crown Zenith Galarian Gallery Holo PSA 9",
            wrong: "Mew GG11/GG70 Crown Zenith Holo PSA 9" },
        { cardName: "Mew", set: "SWSH: Crown Zenith: Galarian Gallery", cardNumber: "GG10/GG70", grade: 9,
            query: "Mew GG10 Crown Zenith PSA 9", matching: "2023 POKEMON SWORD & SHIELD CROWN ZENITH #GG10 FULL ART/MEW PSA 9",
            wrong: "2023 POKEMON SWORD & SHIELD CROWN ZENITH #10 FULL ART/MEW PSA 9" },
        { cardName: "Mewtwo", set: "Base Set", cardNumber: "010/102", grade: 8,
            query: "Mewtwo 10 Base Set PSA 8",
            matching: "Mewtwo 10/102 Base Set Holo PSA 8", wrong: "Mewtwo 10/130 Base Set 2 Holo PSA 8" },
        { cardName: "Blastoise", set: "Base Set", cardNumber: "002/102", grade: 8,
            query: "Blastoise 2 Base Set PSA 8",
            matching: "Blastoise 2/102 Base Set Holo PSA 8", wrong: "Blastoise 2/130 Base Set 2 Holo PSA 8" },
    ];
    for (const c of cases) {
        const intent = { ...market, cardName: c.cardName, cardNumber: c.cardNumber, sets: [c.set], graded: true, grader: "PSA", minGrade: c.grade, maxGrade: c.grade };
        const exact = listing(1, c.matching, { isGraded: true });
        const found = await discoverMarketListings(source, intent, {}, signal, {
            knownSets: async () => ["Base Set", "Base Set 2", "Crown Zenith", c.set],
            search: async query => {
                assert.equal(query, c.query);
                return { listings: [exact, listing(2, c.wrong, { isGraded: true })], total: 2, skipped: 0 };
            },
        });
        assert.deepEqual(found.map(row => row.id), [exact.id], c.matching);
    }
});

test("one Browse can screen several eligible finishes without admitting an unrelated finish or another release", async () => {
    const titles = ["Holo", "Reverse Holo", "Non Holo"].map((variant, i) => listing(i, `Dark Gengar 6/105 Neo Destiny ${variant}`));
    const found = await discoverMarketListings(source, market, {}, signal, {
        relatedIntents: [{ ...market, finish: "REVERSE_HOLO" }, { ...market, sets: ["Jungle"], finish: "NON_HOLO" }],
        knownSets, search: async () => ({ listings: titles, total: 3, skipped: 0 }),
    });
    assert.deepEqual(found.map(row => row.id), titles.slice(0, 2).map(row => row.id));
});

test("auction market discovery orders by ending time and keeps only auctions below ten hours", async () => {
    const now = Date.now(), hour = 3_600_000, title = "Dark Gengar 6/105 Neo Destiny Unlimited Holo";
    const rows = [9, 10, 11, 0].map((hours, i) => listing(i + 1, title, {buyingOption: "AUCTION", endTime: new Date(now + hours * hour).toISOString()}));
    const found = await discoverMarketListings(source, market, {typeFilter: "AUCTION"}, signal, {
        now: () => now, knownSets, search: async (_q, config) => {
            assert.equal(config?.sort, "endingSoonest");
            assert.equal(config?.filters?.typeFilter, "AUCTION");
            return {listings: [...rows, listing(6, title)], total: 5, skipped: 0};
        },
    });
    assert.deepEqual(found.map(r => r.id), [rows[0].id]);
});
