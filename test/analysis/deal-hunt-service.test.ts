import { createRecentListingTerms } from "../../server/listings/recent-terms.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { DealHuntRequest } from "../../shared/deal-hunt.ts";
import { HUNT_RECHECK_MS } from "../../shared/deal-hunt.ts";
import { matchesListingFilters } from "../../shared/listing-filters.ts";
import { listingEvidenceKey } from "../../shared/listing-evidence.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import type { Evaluation, ListingSummary, SearchIntent } from "../../shared/types.ts";
import { getAiUsageContext, getBudgetContext, withAiUsageContext } from "../../server/ai/usage-context.ts";
import { huntPhotoIdentityIssue } from "../../server/analysis/deal-hunt-market-checks.ts";
import { huntProgress } from "../../server/analysis/deal-hunt-progress.ts";
import { createDealHuntService, dealHuntRequest } from "../../server/analysis/deal-hunt-service.ts";
import { runDealHunt } from "../../server/analysis/deal-hunt.ts";
import { createModelExperimentRunner } from "../../server/analysis/model-experiment.ts";
import { evaluationContextKey } from "../../server/analysis/private-evaluation.ts";
import { rankHuntMarkets } from "../../server/analysis/same-set-markets.ts";
import { createHuntInventoryScanner, type SearchSummary } from "../../server/deals/find-deals.ts";
import type { ListingDetails } from "../../server/ebay/listings.ts";
import { EbayBudgetError } from "../../server/ebay/usage.ts";
import { cardEvaluation, clearReleaseFixture, salesSummary } from "../fixtures/card-evaluation.ts";
import { offlineSearchSteps } from "../fixtures/search-steps.ts";
import { matchedRawPrice } from "../fixtures/card-evaluation.ts";
import { configuredShippingZip } from "../../server/ebay/shipping-destination.ts";
import { PricingProviderError } from "../../server/pricing/errors.ts";

const searchId = "348cae85-377d-44a4-9436-25a311eb2d4c";
const listingId = "v1|120000000001|0";
const now = Date.parse("2026-11-24T12:05:00Z");
const stamp = new Date(now).toISOString();
const old = new Date(now - 3_600_000).toISOString();
const goal: DealHuntRequest = { listingIds: [listingId], goal: "grade_raw", targets: { minProfit: 0, minRoi: 0 } };

function example() {
    const e = cardEvaluation(goal.targets);
    Object.assign(e.listing, { id: listingId, price: 5, shipping: 0, termsCheckedAt: stamp, availability: "ACTIVE", buyingOption: "FIXED_PRICE",
        title: "1999 Base Set Venusaur 15/102 Holo", url: "https://www.ebay.com/itm/120000000001", photos: ["https://i.ebayimg.com/images/g/front/s-l1600.jpg", "https://i.ebayimg.com/images/g/back/s-l1600.jpg"] });
    e.photoCheck!.cardCount = "ONE";
    clearReleaseFixture(e);
    Object.assign(e, { answeredAt: stamp, pricesCheckedAt: stamp, pricingVersion: PRICING_VERSION, assessmentVersion: "offline/bounded-prompts-4", conditionVersion: "offline/bounded-condition-1/prompts-1" });
    for (const pricing of Object.values(e.gradedPricing!)) {
        Object.assign(pricing, { printing: "UNLIMITED", source: "pkmnprices", variant: "holo" });
        for (const summary of pricing.byGrade!) for (const sale of summary.sales) Object.assign(sale, { saleType: "fixed_price", soldAt: old });
    }
    const row: ListingSummary = { id: listingId, title: e.listing.title, buyingOption: "FIXED_PRICE", currentPrice: 5,
        shipping: 0, images: e.listing.photos!, url: e.listing.url, endTime: null, bids: 0, isGraded: false, seller: e.listing.seller };
    const intent: SearchIntent = { cardName: "Venusaur", sets: [], cardNumber: null, printing: null, graded: false, titleWords: ["venusaur"], source: "rules" };
    const inventory = { intent, filters: { typeFilter: "FIXED_PRICE" as const }, rows: [{ listing: row, assessable: true }] };
    const discovery = { searchId, savedAt: stamp, discovery: { total: 1, found: 1, skipped: 0, deferred: 0, retainedIds: [listingId] } };
    const key = evaluationContextKey({ title: row.title, images: row.images, aspects: e.listing.aspects });
    const snapshot = { searchId, version: 1 as const, evidenceKey: listingEvidenceKey(row), contextKey: key, evaluation: e };
    const details: ListingDetails = { ...e.listing, images: row.images, condition: "Ungraded", retrievedAt: stamp };
    return { e, inventory, discovery, snapshot, details };
}

const unexpected = async () => assert.fail("Unexpected provider or storage call");
const emptyInventory = () => async (_query: string, intent: SearchIntent) => ({ listings: [],
    summary: { intent, mode: "development", deferred: 0, total: 0, found: 0, count: 0, skipped: 0 } satisfies SearchSummary });

test("a watching search waits between passes and through the eBay reserve reset before doing further research", async () => {
    let clock = now, passes = 0, budgetReads = 0;
    const reset = now + HUNT_RECHECK_MS * 3;
    const request: DealHuntRequest = { goal: "resell", standalone: true, watch: true, freshListings: true,
        scope: "any_card", listingIds: [], filters: { typeFilter: "FIXED_PRICE" }, targets: goal.targets };
    const id = crypto.randomUUID(), signal = new AbortController().signal;
    const check = service(example(), { now: () => clock,
        browseReserveReset: async () => { budgetReads++; return clock > now && clock < reset ? reset : null; },
        plan: async () => { passes++; return { searchId: id, goal: "resell", decision: "WAIT", reason: "No match", steps: [], destination: null }; },
    });
    assert.equal((await check(id, request, signal)).nextCheckAt, now + HUNT_RECHECK_MS);
    clock += 100;
    assert.equal((await check(id, request, signal)).nextCheckAt, now + HUNT_RECHECK_MS);
    assert.equal(budgetReads, 1);
    clock = now + HUNT_RECHECK_MS;
    const paused = await check(id, request, signal);
    assert.equal(paused.waitingForQuota, true);
    assert.equal(paused.nextCheckAt, reset);
    assert.equal(passes, 1);
    clock = reset - 1;
    assert.equal((await check(id, request, signal)).nextCheckAt, reset);
    assert.equal(budgetReads, 2);
    clock = reset;
    const resumed = await check(id, request, signal);
    assert.equal(resumed.waitingForQuota, undefined);
    assert.equal(resumed.nextCheckAt, reset + HUNT_RECHECK_MS);
    assert.equal(passes, 2);
});

function service(fixture: ReturnType<typeof example>, overrides: Parameters<typeof createDealHuntService>[0] = {}, onChoice?: (chosen: string, options: string[]) => void) {
    const cache = new Map();
    const choose = createModelExperimentRunner({
        cached: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, value); },
        run: async request => {
            const { menu } = JSON.parse(request.prompt) as { menu: { key: string }[] };
            const options = ["0/finish/grading", "0/finish/photos", "0/finish/sales", "0/check_listing", "0/inspect_photos", "0/check_sales", "0/check_price_references", "0/calculate_grading", "market-0/find_listings"];
            const choice = options.find(key => menu.some(entry => entry.key === key)) ?? menu.find(entry => entry.key.endsWith("/find_listings"))?.key;
            assert.ok(choice, "The fake chooser requires an option the app actually supplied");
            onChoice?.(choice, menu.map(entry => entry.key));
            return { result: { choice, reason: "Check the relevant evidence for this card." }, usage: { inputTokens: 1, outputTokens: 1 } };
        },
    });
    return createDealHuntService({
        now: () => now, discovery: async () => fixture.discovery, inventory: async () => fixture.inventory, snapshot: async () => fixture.snapshot,
        details: unexpected, evaluate: unexpected, supplement: unexpected, inventoryScanner: emptyInventory, pricedInventoryTargets: async () => [], cachedLiquidMarkets: async () => [], liquidMarkets: async () => [],
        plan: (input, signal) => runDealHunt(input, signal, choose), ...overrides,
    });
}

test("server-observed purchase terms stay with the account, destination and newest unexpired quote", () => {
    let clock = now;
    const terms = createRecentListingTerms(() => clock);
    const { inventory } = example();
    const row = { ...inventory.rows[0].listing, shippingDestination: "76133", termsCheckedAt: new Date(now).toISOString(), currentPrice: 40 };
    terms.remember("root", row);
    assert.equal(terms.read("other", row.id, "76133"), null);
    assert.equal(terms.read("root", row.id, "10001"), null);
    clock += 1000;
    terms.remember("root", { ...row, termsCheckedAt: new Date(clock).toISOString(), currentPrice: 22 });
    terms.remember("root", row);
    assert.equal(terms.read("root", row.id, "76133")?.price, 22);
    clock += 180000;
    assert.equal(terms.read("root", row.id, "76133"), null);
});

const signal = () => new AbortController().signal;

test("a thin exact search recovers contradictory holder clues only for photo verification", async () => {
    const { inventory, e } = example();
    for (const kind of ["graded", "raw"] as const) {
        const row = { ...inventory.rows[0].listing, isGraded: kind === "raw" };
        const title = "Venusaur 15/102 Base Set Holo";
        const queries: string[] = [];
        const scan = createHuntInventoryScanner(signal(), offlineSearchSteps([], {
            search: async (q, options) => {
                queries.push(q);
                const titles = options?.anyCategory ? [title + (kind === "raw" ? " ungraded" : " PSA 8"), title + " PSA 10 contender",
                    "Charizard 4/102 Base Set PSA 8"] : [];
                return { listings: titles.map((title, i) => ({ ...row, title, id: row.id + i })), total: titles.length, skipped: 0 };
            },
        }));
        const intent = { ...inventory.intent, sets: ["Base Set"], cardNumber: "15/102", graded: kind === "graded" };
        const filters = { typeFilter: "FIXED_PRICE" as const, kindFilter: kind };
        const batch = await scan(title, intent, filters, goal.targets, now, { excludeIds: new Set(), freshGrading: false, freshListings: true });
        assert.equal(queries.length, 2);
        assert.equal(batch.listings.length, 1);
        const [copy] = batch.listings;
        assert.equal(copy.researchKind, kind);
        assert.equal(copy.isGraded, row.isGraded);
        assert.equal(matchesListingFilters(copy, filters), true);
        assert.equal(matchesListingFilters(copy, filters, { ...e, photoCheck: null }), false);
    }
});

test("a number-only seller title can enter exact photo verification within one reserve-protected fallback", async () => {
    const { inventory } = example();
    const row = inventory.rows[0].listing;
    const queries: string[] = [];
    const scan = createHuntInventoryScanner(signal(), offlineSearchSteps([], {
        search: async (query, options) => {
            queries.push(query);
            const titles = options?.anyCategory ? ["Old Base Set Holo 15/102", "Old Base Set Holo 14/102"] : [];
            return { listings: titles.map((title, i) => ({ ...row, title, id: row.id + i })), total: titles.length, skipped: 0 };
        },
    }));
    const intent = { ...inventory.intent, sets: ["Base Set"], cardNumber: "15/102", graded: null };
    const batch = await scan("Venusaur", intent, { typeFilter: "FIXED_PRICE", kindFilter: "all" }, goal.targets, now,
        { excludeIds: new Set(), freshGrading: false, freshListings: true, recoverTitles: true });
    assert.equal(queries.length, 2);
    assert.equal(queries[1], "Base Set 15/102");
    assert.deepEqual(batch.listings.map(l => [l.title, l.researchIdentity]), [["Old Base Set Holo 15/102", true]]);
});

test("a restarted flip scanner drains the saved page before making another Browse call", async () => {
    const { inventory } = example();
    const query = "Venusaur";
    const rows = Array.from({ length: 66 }, (_, i) => ({ ...inventory.rows[0].listing, id: `v1|${120000032000 + i}|0` }));
    const filters = { typeFilter: "FIXED_PRICE" as const };
    const options = { excludeIds: new Set<string>(), freshGrading: false, freshListings: true };
    const first = await createHuntInventoryScanner(signal(), offlineSearchSteps(rows))(query, inventory.intent, filters, goal.targets, now, options);
    assert.ok(first.backlog?.pending.length);
    const resumed = await createHuntInventoryScanner(signal(), offlineSearchSteps([], { search: unexpected }))(
        query, inventory.intent, filters, goal.targets, now + HUNT_RECHECK_MS, { ...options, resumeBacklog: first.backlog });
    assert.equal(resumed.sourcePages, 0);
    assert.equal(resumed.hasMore, false);
    assert.deepEqual(new Set([...first.listings, ...resumed.listings].map(row => row.id)), new Set(rows.map(row => row.id)));
});

test("a first photo batch releases six candidates and resumes the rest without another eBay request", async () => {
    const { inventory } = example(), query = "Venusaur";
    const rows = Array.from({ length: 40 }, (_, i) => ({ ...inventory.rows[0].listing, id: `v1|${120000042000 + i}|0` }));
    const options = { excludeIds: new Set<string>(), freshGrading: false, freshListings: true, firstPhotoBatch: true };
    const filters = { typeFilter: "FIXED_PRICE" as const };
    const first = await createHuntInventoryScanner(signal(), offlineSearchSteps(rows))(query, inventory.intent, filters, goal.targets, now, options);
    assert.equal(first.listings.length, 6);
    assert.equal(first.backlog?.pending.length, 34);
    const rest = await createHuntInventoryScanner(signal(), offlineSearchSteps([], { search: unexpected }))(
        query, inventory.intent, filters, goal.targets, now, { ...options, resumeBacklog: first.backlog });
    assert.equal(rest.sourcePages, 0);
    assert.deepEqual(new Set([...first.listings, ...rest.listings].map(row => row.id)), new Set(rows.map(row => row.id)));
});

test("hunt set preferences are bounded, normalized and kept separate from era preferences", () => {
    const request = { ...goal, marketPreferences: { sets: [" Neo Revelation ", "Neo Revelation"], finish: "HOLO" } };
    assert.deepEqual(dealHuntRequest(request).marketPreferences?.sets, ["Neo Revelation"]);
    for (const sets of [[], [""], ["   "], "Neo Revelation", [null], ["x".repeat(121)], Array(9).fill("Neo Revelation")]) {
        assert.throws(() => dealHuntRequest({ ...request, marketPreferences: { sets } }), { status: 400 });
    }
});

test("an upper-only year ceiling survives standalone hunt admission and includes its boundary", async () => {
    const market = liquidGradingMarket();
    const request = { goal: "resell", scope: "any_card", standalone: true, listingIds: [], targets: goal.targets,
        marketPreferences: { maxYear: 2020, finish: "HOLO" }, filters: { typeFilter: "FIXED_PRICE" } };
    const validated = dealHuntRequest(request);
    assert.equal(validated.marketPreferences?.minYear, undefined);
    assert.equal(validated.marketPreferences?.maxYear, 2020);
    const hunt = service(example(), {
        discovery: unexpected, inventory: unexpected, snapshot: unexpected, discoverMarket: unexpected,
        setYears: async () => ({ "neo destiny": 2002, "vivid voltage": 2020, celebrations: 2021 }),
        markets: async () => [
            { ...market, name: "Title Boundary", set: "Vivid Voltage" }, { ...market, name: "Title Kept", set: "Neo Destiny" },
            { ...market, name: "Title Excluded", set: "Celebrations" }, { ...market, name: "Unknown", set: "Unknown year" },
        ],
        plan: async ({ markets }) => {
            assert.deepEqual(markets?.filter(x => x.source !== "inventory").map(x => x.title.split(" · ")[0]).sort(),
                [`Title Boundary ${market.cardNumber}`, `Title Kept ${market.cardNumber}`]);
            return { searchId, goal: "resell", decision: "WAIT", destination: null, reason: "Only supported release boundaries were checked.", steps: [] };
        },
    });
    await hunt(searchId, request, signal());
});

test("explicit liquidity preferences survive validation and rank exact recent markets before higher margins", async () => {
    const lead = liquidGradingMarket();
    const highMargin = { ...lead, name: "Dark Gengar", set: "Neo Destiny", cardNumber: "6/105",
        sales60: 1, projectedProfit: 110 };
    const moreActive = { ...lead, name: "Lugia", set: "Neo Genesis", cardNumber: "9/111",
        sales60: 8, projectedProfit: 30 };
    const request = { goal: "resell", scope: "any_card", standalone: true, listingIds: [], targets: goal.targets,
        filters: { typeFilter: "FIXED_PRICE", kindFilter: "raw" } };
    const preferences = { minYear: 1999, maxYear: 2003, finish: "HOLO", preferRecentSales: true };
    assert.equal(dealHuntRequest({ ...request, marketPreferences: preferences }).marketPreferences?.preferRecentSales, true);
    assert.throws(() => dealHuntRequest({ ...request, marketPreferences: { ...preferences, preferRecentSales: "true" } }), { status: 400 });
    for (const optedIn of [false, true]) {
        const hunt = service(example(), {
            discovery: unexpected, inventory: unexpected, snapshot: unexpected, discoverMarket: unexpected,
            setYears: async () => ({ "neo genesis": 2000, "neo destiny": 2002, celebrations: 2021 }),
            markets: async () => [highMargin, moreActive, { ...moreActive, set: "Celebrations" },
                { ...moreActive, finish: "REVERSE_HOLO" }],
            plan: async ({ markets, preferRecentSales }) => {
                assert.equal(Boolean(preferRecentSales), optedIn);
                assert.equal(markets?.length, 3);
                assert.match(markets![0].title, optedIn ? /Lugia/ : /Dark Gengar/);
                assert.match(markets![1].title, optedIn ? /Dark Gengar/ : /Lugia/);
                assert.equal(markets![2].source, "inventory");
                return { searchId, goal: "resell", decision: "WAIT", destination: null, reason: "Only market ordering was checked.", steps: [] };
            },
        });
        await hunt(searchId, { ...request, marketPreferences: { ...preferences, preferRecentSales: optedIn } }, signal());
    }
});

test("hunt printing and certified-grade preferences reject widening before offering markets", async () => {
    const targets = { minProfit: 0, minRoi: 0 };
    const request = { goal: "resell", listingIds: [], targets, scope: "any_card", standalone: true };
    const base = { name: "Dark Gengar", set: "Neo Destiny", cardNumber: "6/105", printing: "UNLIMITED", finish: "HOLO",
        kind: "slab", grader: "CGC", grade: 8.5, condition: null, sales30: 3, sales90: 3, latestSaleAt: stamp,
        medianUsd: 300, listingIds: [], projectedProfit: null };
    for (const marketPreferences of [{ printing: "FIRST_EDITION", finish: "HOLO" },
        { printing: "UNLIMITED", grader: "CGC", minGrade: 8, maxGrade: 9.5 }]) {
        const desired = { ...base, printing: marketPreferences.printing };
        const markets = [desired, { ...base, printing: marketPreferences.printing === "FIRST_EDITION" ? "UNLIMITED" : "FIRST_EDITION" },
            ...(marketPreferences.grader ? [{ ...base, grader: "PSA" }, { ...base, grade: 7 }, { ...base, grade: 10 },
                { ...base, kind: "raw" }] : [])];
        const hunt = createDealHuntService({ now: () => now, discovery: unexpected, inventory: unexpected, snapshot: unexpected,
            setYears: unexpected, markets: async () => markets, discoverMarket: unexpected,
            plan: async input => {
                assert.equal(input.markets?.length, 2, JSON.stringify(input.markets));
                assert.equal(input.markets![1].source, "inventory");
                assert.match(input.markets![0].summary, marketPreferences.printing === "FIRST_EDITION" ? /first edition/ : /unlimited/);
                assert.match(input.markets![0].summary, /CGC 8.5/);
                return { searchId, goal: "resell", decision: "WAIT", destination: null, reason: "No copy inspected.", steps: [] };
            } });
        await hunt(searchId, { ...request, marketPreferences }, signal());
    }
    for (const marketPreferences of [{ printing: "UNKNOWN" }, { grader: "OTHER" }, { minGrade: 0 }, { maxGrade: 10.5 },
        { minGrade: 8.2 }, { minGrade: 9, maxGrade: 8 }]) {
        assert.throws(() => dealHuntRequest({ ...request, marketPreferences }), { status: 400 });
    }
});

test("a cached Dark Gengar candidate must retain the hunt printing and certified grade", async () => {
    const e = cardEvaluation();
    Object.assign(e.identity!, { name: "Dark Gengar", set: "Neo Destiny", cardNumber: "6/105", printing: "UNLIMITED" });
    Object.assign(e.listing, { id: listingId, title: "Dark Gengar Neo Destiny 6/105 Unlimited Holo", price: 20, shipping: 0,
        buyingOption: "FIXED_PRICE", availability: "ACTIVE", termsCheckedAt: stamp, endTime: null,
        photos: ["https://i.ebayimg.com/images/g/gengar/s-l1600.jpg"] });
    e.photoCheck!.cardCount = "ONE";
    const row = { id: listingId, title: e.listing.title, currentPrice: 20, shipping: 0, buyingOption: "FIXED_PRICE",
        isGraded: false, images: e.listing.photos!, seller: null, url: e.listing.url, bids: 0, endTime: null };
    const inventory = { intent: { cardName: "Dark Gengar", sets: [], cardNumber: null, printing: null,
        graded: null, titleWords: [], source: "rules" }, filters: { typeFilter: "FIXED_PRICE" }, rows: [{ listing: row, assessable: true }] };
    const snapshot = { version: 1, searchId, evidenceKey: listingEvidenceKey(row), contextKey: "unused", evaluation: e };
    for (const [marketPreferences, expected] of [[{ printing: "UNLIMITED" }, 1], [{ printing: "FIRST_EDITION" }, 0],
        [{ grader: "CGC", minGrade: 8, maxGrade: 9 }, 0]] as const) {
        const hunt = createDealHuntService({ now: () => now,
            discovery: async () => ({ searchId, savedAt: stamp, discovery: { total: 1, found: 1, skipped: 0, deferred: 0, retainedIds: [listingId] } }),
            inventory: async () => inventory, snapshot: async () => snapshot, evaluate: unexpected, details: unexpected,
            plan: async input => { assert.equal(input.candidates.length, expected); return { searchId, goal: "resell", decision: "WAIT",
                destination: null, reason: "Only candidate scope was checked.", steps: [] }; } });
        await hunt(searchId, { goal: "resell", listingIds: [listingId], targets: { minProfit: 0, minRoi: 0 }, marketPreferences }, signal());
    }
});

test("a requested Neo Revelation market cannot broaden into Neo Genesis when no year was supplied", async () => {
    const f = example(), lead = liquidGradingMarket();
    let menuSeen = false;
    const hunt = service(f, {
        discovery: unexpected, inventory: unexpected, snapshot: unexpected, setYears: unexpected,
        markets: async (_origin, _goal, _scope, _active, accepts) => {
            assert.equal(accepts?.("Neo Revelation"), true);
            assert.equal(accepts?.("Neo Genesis"), false);
            return [{ ...lead, set: "Neo Genesis" }, { ...lead, set: "Neo Revelation" }];
        },
        discoverMarket: unexpected,
        plan: async ({ markets, candidates }) => {
            menuSeen = true;
            assert.equal(candidates.length, 0);
            assert.equal(markets?.length, 2);
            assert.equal(markets![1].source, "inventory");
            assert.match(markets![0].title, /Neo Revelation/);
            return { searchId, goal: "resell", decision: "WAIT", destination: null, reason: "The requested release has no checked copy yet.", steps: [] };
        },
    });
    await hunt(searchId, { ...goal, goal: "resell", scope: "any_card", standalone: true, listingIds: [],
        marketPreferences: { sets: ["Neo Revelation"], finish: "HOLO" } }, signal());
    assert.equal(menuSeen, true);

    Object.assign(f.e.identity!, { set: "Neo Genesis" });
    const original = service(f, { plan: async ({ candidates }) => {
        assert.equal(candidates.length, 0, "an existing different-release assessment cannot satisfy the set preference");
        return { searchId, goal: "grade_raw", decision: "WAIT", destination: null, reason: "No copy in the requested release.", steps: [] };
    } });
    await original(searchId, { ...goal, marketPreferences: { sets: ["Neo Revelation"] } }, signal());
});

test("the service rejects a listing outside the search before any inventory, evidence or provider request", async () => {
    const hunt = service(example(), { inventory: unexpected, snapshot: unexpected, plan: unexpected });
    await assert.rejects(hunt(searchId, { ...goal, listingIds: ["v1|120000000002|0"] }, signal()), { status: 409 });
});

test("a root hunt can research original and continued copies without borrowing another search", async () => {
    const fixture = example();
    const batchId = "2f044091-d0f0-4207-b2ec-a6f95c104805";
    const continuedId = "v1|120000000002|0";
    const continuedListing = { ...fixture.inventory.rows[0].listing, id: continuedId };
    const hunt = service(fixture, {
        batchOwner: async id => id === batchId ? searchId : undefined,
        discovery: async id => id === searchId ? fixture.discovery : { ...fixture.discovery, searchId: batchId,
            discovery: { ...fixture.discovery.discovery, retainedIds: [continuedId] } },
        inventory: async id => id === searchId ? fixture.inventory : { ...fixture.inventory,
            rows: [{ listing: continuedListing, assessable: true }] },
        snapshot: async () => null,
        evaluate: async id => {
            assert.equal(id, continuedId);
            assert.equal(getAiUsageContext().searchId, batchId);
            assert.equal(getBudgetContext().searchId, searchId);
            return { ...fixture.e, listing: { ...fixture.e.listing, id } };
        },
        plan: async input => {
            assert.deepEqual(input.candidates.map(candidate => candidate.listingId), [listingId, continuedId]);
            await input.candidates[1].read("inspect_photos", signal());
            return { searchId, goal: "grade_raw", decision: "WAIT", destination: null, reason: "Both batches were admitted.", steps: [] };
        },
    });
    const request = { ...goal, listingIds: [listingId, continuedId], batchIds: [batchId] };
    assert.equal((await hunt(searchId, request, signal())).report.searchId, searchId);
    await assert.rejects(hunt(searchId, { ...request, batchIds: ["64b3c69b-6b2d-4c92-8f05-d4505175c040"] }, signal()), { status: 409 });
});

test("the selected screened listing gets one bounded photo assessment, then normal planning uses that assessment in its destination", async () => {
    const f = example();
    let calls = 0;
    const hunt = service(f, {
        snapshot: async () => null,
        evaluate: async (id, options) => {
            calls++;
            assert.equal(id, listingId);
            assert.equal(options?.automatic, true); assert.equal(options?.typeFilter, "FIXED_PRICE");
            assert.deepEqual(options?.targets, goal.targets);
            assert.equal(getAiUsageContext().searchId, searchId);
            assert.equal(getAiUsageContext().listingId, listingId);
            const progress = huntProgress.read(searchId);
            assert.equal(progress?.phase, "reviewing");
            assert.equal(progress.action, "inspect_photos");
            assert.equal(progress.cohort, f.e.listing.title);
            assert.equal(progress.retained, 1);
            assert.equal(progress.reviewed, 0);
            return f.e;
        },
    });
    const result = await hunt(searchId, goal, signal());
    assert.equal(calls, 1);
    assert.equal(result.report.steps[0].action, "inspect_photos");
    assert.equal(result.report.decision, "BUY");
    assert.deepEqual(result.report.destination, { listingId, section: "grading" });
    assert.equal(result.evaluation?.listing.id, listingId);
    assert.equal(huntProgress.read(searchId)?.phase, "completed");
    assert.equal(huntProgress.read(searchId)?.reviewed, 1);
});

test("refreshed shipping and price change the decision without repeating any earlier photo check", async () => {
    const f = example();
    f.e.listing.termsCheckedAt = old;
    let lookups = 0;
    const hunt = service(f, { details: async (id, opts) => {
        assert.equal(id, listingId);
        assert.equal(opts?.keepReserve, true);
        lookups++; return { ...f.details, price: 1500, shipping: 12 };
    } });
    const result = await hunt(searchId, goal, signal());
    assert.equal(lookups, 1);
    assert.equal(result.report.decision, "WAIT");
    assert.equal(result.evaluation?.listing.price, 1500);
    assert.equal(result.evaluation?.listing.shipping, 12);
    assert.match(result.report.steps.find(step => step.action === "check_listing")!.observation, /\$1,500.00/);
});

test("a changed gallery retires the candidate before an obsolete photo assessment can support any destination", async () => {
    const f = example();
    f.e.listing.termsCheckedAt = old;
    const hunt = service(f, { details: async () => ({ ...f.details, images: ["https://i.ebayimg.com/images/g/another/s-l1600.jpg"] }) });
    const result = await hunt(searchId, goal, signal());
    assert.equal(result.evaluation, null);
    assert.equal(result.report.destination, null); assert.equal(result.report.decision, "WAIT");
    assert.match(result.report.steps[0].observation, /gallery changed|photos changed/i);
    assert.deepEqual(result.report.steps.map(step => step.action), ["check_listing"]);
});

test("research accepts only the goal's eligible rows and excludes a different card established by the assessment", async () => {
    const f = example();
    f.inventory.rows[0].assessable = false;
    const skipped = await service(f, { snapshot: async () => null })(searchId, goal, signal());
    assert.deepEqual(skipped.report.steps, []);
    f.inventory.rows[0].assessable = true;
    const other: Evaluation = structuredClone(f.e);
    other.identity!.notThisCard = "Photos show a different card.";
    const changed = await service(f, { snapshot: async () => null, evaluate: async () => other })(searchId, goal, signal());
    assert.equal(changed.report.decision, "WAIT"); assert.equal(changed.evaluation, null);
    assert.match(changed.report.steps[0].observation, /outside the search|different card/);
});

test("an older saved search reuses only its own assessment when a search inventory was never captured", async () => {
    const f = example();
    const hunt = service(f, { inventory: async () => null });
    const result = await hunt(searchId, goal, signal());
    assert.equal(result.report.decision, "BUY");
    assert.equal(result.evaluation?.listing.id, listingId);
    const replay = await hunt(searchId, goal, signal());
    assert.deepEqual(replay.report.destination, result.report.destination);
    assert.ok(replay.report.steps.filter(step => step.reused !== null).every(step => step.reused));
    f.snapshot.searchId = "581ca4c5-4184-4495-873c-0db4f3688442";
    const unrelated = await hunt(searchId, goal, signal());
    assert.equal(unrelated.report.destination, null);
    assert.deepEqual(unrelated.report.steps, []);
});

test("expired market evidence is refreshed through the price-only evaluator and reused photos remain attached", async () => {
    const f = example();
    f.e.pricesCheckedAt = "2026-11-19T12:00:00Z";
    let refreshes = 0;
    const result = await service(f, { evaluate: async (id, options) => {
        refreshes++;
        assert.equal(id, listingId);
        assert.equal(options?.priceOnly, true);
        assert.equal(getAiUsageContext().searchId, searchId);
        return retargetEvaluation({ ...f.e, pricesCheckedAt: stamp }, goal.targets);
    } })(searchId, goal, signal());
    assert.equal(refreshes, 1);
    assert.equal(result.report.decision, "BUY");
    assert.deepEqual(result.evaluation?.photoCheck, f.e.photoCheck);
    assert.equal(result.evaluation?.pricesCheckedAt, stamp);
    assert.deepEqual(result.report.destination, { listingId, section: "grading" });
});

test("a global eBay hold pauses before further copy checks", async () => {
    const f = example();
    f.e.listing.termsCheckedAt = old;
    f.e.pricesCheckedAt = "2026-11-19T12:00:00Z";
    const capped = async () => { throw new EbayBudgetError("Browse quota reached", "QUOTA"); };
    const result = await service(f, { details: capped, evaluate: capped })(searchId, goal, signal());
    assert.equal(result.report.decision, "WAIT");
    assert.match(result.report.reason, /eBay listing allowance/);
    assert.ok(!result.report.steps.some(step => step.action === "check_sales" && /PSA 7/.test(step.observation)));
});

test("a replaced photo subject in a full or price-only evaluation retires the listing even when its eBay ID and card name still match", async () => {
    for (const saved of [false, true]) {
        const f = example();
        f.e.pricesCheckedAt = "2026-11-19T12:00:00Z";
        const replacement = retargetEvaluation(structuredClone(f.e), goal.targets);
        replacement.listing.photos = ["https://i.ebayimg.com/images/g/different-copy/s-l1600.jpg"];
        replacement.pricesCheckedAt = stamp;
        const result = await service(f, {
            snapshot: async () => saved ? f.snapshot : null,
            evaluate: async () => replacement,
        })(searchId, goal, signal());
        assert.equal(result.report.destination, null, saved ? "a price refresh cannot switch the underlying copy" : "a new assessment must match the retained listing");
        assert.equal(result.report.decision, "WAIT");
        assert.equal(result.evaluation, null);
    }
});

function liquidGradingMarket() {
    const history = example();
    const likely = history.e.gradedPricing!.PSA!.byGrade!.find(summary => summary.grade === 7)!;
    likely.sales.forEach((sale, index) => {
        sale.url = "https://www.ebay.com/itm/" + (220000000001 + index);
        sale.soldAt = new Date(now - (index + 1) * 86_400_000).toISOString();
    });
    const [lead] = rankHuntMarkets([history.e], null, "resell", "any_card", now);
    assert.ok(lead);
    assert.equal(lead.sales30, 3);
    return lead;
}

const freshHuntRequest: DealHuntRequest = { ...goal, listingIds: [], scope: "any_card", standalone: true,
    filters: { typeFilter: "FIXED_PRICE", kindFilter: "raw", maxPrice: 100 } };

function freshCopy(number: number) {
    const f = example(), row = f.inventory.rows[0].listing;
    const id = `v1|${number}|0`, url = `https://www.ebay.com/itm/${number}`;
    const images = ["front", "back"].map(side => `https://i.ebayimg.com/images/g/${number}-${side}/s-l1600.jpg`);
    Object.assign(row, { id, url, images, listedAt: old,
        screen: { status: "UNSCREENED", needsAnalysis: "IDENTITY", card: null, bestCase: null, assumed: null, reason: null } });
    Object.assign(f.e.listing, { id, url, photos: images, listedAt: old, endTime: null });
    clearReleaseFixture(f.e);
    Object.assign(f.details, { ...f.e.listing, images });
    f.e.gradedPricing = { PSA: f.e.gradedPricing!.PSA };
    for (const summary of f.e.gradedPricing.PSA!.byGrade!) {
        Object.assign(summary, { newestSale: old });
        summary.sales.forEach((sale, index) => Object.assign(sale, {
            title: `Venusaur Base Set 15/102 Holo Unlimited PSA ${summary.grade}`,
            url: `https://www.ebay.com/itm/${220000001000 + Number(summary.grade) * 10 + index}`,
        }));
    }
    f.e.rawPricing = null;
    f.snapshot.contextKey = evaluationContextKey({ ...f.e.listing, images });
    f.snapshot.evidenceKey = listingEvidenceKey(row);
    return { ...f, row };
}

test("a standalone fresh grading hunt assesses the ranked fifteen before choosing its buyer verdict", async () => {
    const fixtures = Array.from({ length: 50 }, (_, index) => freshCopy(120000010001 + index));
    const current = new Map(fixtures.map(f => [f.row.id, f]));
    const picks = fixtures.slice(-15).reverse().map(f => f.row.id);
    const saved = picks.at(-1)!;
    const checked: string[] = [];
    const stale = { ...fixtures[0].row, id: "older", listedAt: "2026-11-20T00:00:00Z", createdAt: stamp };
    const expensive = { ...fixtures[0].row, id: "expensive", shipping: 500 };
    let selections = 0;
    const hunt = service(fixtures[0], {
        snapshot: async id => id === saved ? current.get(id)!.snapshot : null,
        markets: async () => [liquidGradingMarket()],
        discoverMarket: async (_id, intent, filters, _active, options) => {
            assert.equal(intent.graded, false);
            assert.equal(filters.typeFilter, "FIXED_PRICE");
            assert.equal(options?.newlyListedRaw, true);
            return [stale, expensive, ...fixtures.map(f => f.row)];
        },
        researchFreshRawSellers: async rows => {
            assert.deepEqual(new Set(rows.map(row => row.id)), new Set(current.keys()));
            return rows;
        },
        selectReviews: async rows => {
            selections++;
            assert.equal(rows.length, 50);
            return { source: "ai", listingIds: picks };
        },
        details: async id => current.get(id)!.details,
        evaluate: async (id, opts) => {
            assert.equal(opts?.automatic, true);
            assert.equal(opts?.typeFilter, "FIXED_PRICE");
            assert.equal(getAiUsageContext().searchId, searchId);
            assert.equal(getAiUsageContext().listingId, id);
            checked.push(id);
            return current.get(id)!.e;
        },
    }, choice => {
        if (choice.endsWith("/find_listings")) return;
        assert.deepEqual(new Set(checked), new Set(picks.filter(id => id !== saved)),
            "planner receives all fifteen photo assessments, including the previously saved assessment");
    });
    const result = await hunt(searchId, freshHuntRequest, signal());
    assert.equal(selections, 1);
    assert.equal(checked.length, 14, "reuse prevents a second assessment when the planner selects an already inspected copy");
    assert.equal(result.report.decision, "BUY", JSON.stringify(result.report));
    assert.deepEqual(result.report.destination, { listingId: picks[0], section: "grading" });
    assert.equal(result.alternative?.listing.id, picks[0]);
    assert.match(result.report.marketNote!, /15 priority copies.*All 50 eligible copies remain available/);
    assert.match(result.report.reason, /grading.*costs/i);
    assert.match(result.report.reason, /grade 7.*3 sales in 60 days.*grade 6.*3 sales in 60 days/i);
});

test("a standalone fresh grading buy requires the actual copy's edition and sales at the lower grade", async () => {
    for (const missing of ["lower grade", "matching edition"] as const) {
        const f = freshCopy(120000020001);
        if (missing === "lower grade") f.e.gradedPricing!.PSA!.byGrade = f.e.gradedPricing!.PSA!.byGrade!.filter(s => s.grade !== 6);
        else f.e.identity!.printing = "FIRST_EDITION";
        const result = await service(f, {
            markets: async () => [liquidGradingMarket()], discoverMarket: async () => [f.row],
            selectReviews: async () => ({ source: "rules", listingIds: [f.row.id] }),
            researchFreshRawSellers: async rows => rows,
            snapshot: async () => null, evaluate: async () => f.e,
        })(searchId, freshHuntRequest, signal());
        assert.equal(result.report.decision, "WAIT", missing + " " + JSON.stringify(result.report));
    }
});

test("omitting the hunt scope keeps a named search within its retained rows without market discovery", async () => {
    const result = await service(example(), { markets: unexpected, discoverMarket: unexpected })(searchId, goal, signal());
    assert.equal(result.report.decision, "BUY");
    assert.equal(result.report.destination?.listingId, listingId);
    assert.equal(result.alternative, undefined);
    assert.equal(result.candidates, undefined);
});

test("a broad hunt with no saved markets screens new releases under its original filters and holds unpriced copies for review", async () => {
    const f = example();
    const budgetId = "42c350cb-1b6c-4780-9b7a-bd2dc9d9a6c6";
    const copy = (number: number, title: string): ListingSummary => ({ ...f.inventory.rows[0].listing, title,
        id: `v1|${number}|0`, url: `https://www.ebay.com/itm/${number}`, currentPrice: 14 });
    const lugia = copy(120000000031, "Lugia 9/111 Neo Genesis Unlimited Holo English");
    const gengar = copy(120000000032, "Dark Gengar 6/105 Neo Destiny Unlimited Holo English");
    const modern = copy(120000000033, "Pikachu 58/102 Celebrations Classic Collection Holo English");
    const reverse = copy(120000000034, "Lugia 9/111 Neo Genesis Unlimited Reverse Holo English");
    const filters = { typeFilter: "FIXED_PRICE", kindFilter: "raw", minPrice: 7, maxPrice: 30 } as const;
    const releases: string[] = [], snapshots: string[] = [], notes: string[] = [];
    let priceSources = 0;
    const hunt = service(f, {
        discovery: unexpected, inventory: unexpected, discoverMarket: unexpected, markets: async () => [],
        setYears: async () => ({ "neo genesis": 2000, "neo destiny": 2002, celebrations: 2021 }),
        inventoryScanner: active => createHuntInventoryScanner(active, offlineSearchSteps([], {
            readIntent: unexpected,
            priceSource: () => {
                priceSources++;
                return { lookupCards: unexpected, lookupQueryCards: unexpected, fetchComps: unexpected, fetchRawComps: unexpected,
                    fetchSoldPage: unexpected, stats: () => ({ requests: 0, limit: 128 }) };
            },
            search: async (query, options) => {
                releases.push(query);
                assert.equal(getBudgetContext().searchId, budgetId);
                const progress = huntProgress.read(budgetId, searchId);
                assert.equal(progress?.phase, "discovering");
                assert.equal(progress.cohort, query);
                assert.equal(progress.scans, releases.length - 1);
                assert.equal(options?.sort, "newlyListed");
                assert.equal(options?.keepReserve, true);
                assert.equal(options?.ccgInventory, true);
                assert.deepEqual(options?.filters, filters);
                const listings = query === "neo genesis" ? [lugia, modern, reverse, lugia] : [gengar, lugia];
                return { listings, total: listings.length, skipped: 0, rejections: [], sourceLimitReached: query === "neo genesis" };
            },
        })),
        snapshot: async id => { snapshots.push(id); return null; },
        plan: async ({ goal, markets, candidates }, active) => {
            assert.deepEqual(candidates, []);
            assert.deepEqual(markets?.map(m => m.source), ["inventory"]);
            const source = markets![0];
            assert.deepEqual(releases, [], "a source offered to the planner does not spend until selected");
            const first = await source.discover(active, note => notes.push(note));
            assert.deepEqual(first.map(c => c.listingId), [lugia.id]);
            const firstProgress = huntProgress.read(budgetId, searchId);
            assert.equal(firstProgress?.discovered, 3);
            assert.equal(firstProgress.retained, 1);
            assert.equal(firstProgress.reviewed, 0);
            assert.equal(firstProgress.scans, 1);
            assert.deepEqual(first[0].available(new Set()), ["inspect_photos"]);
            assert.equal(first[0].outcome(new Set()), null);
            assert.equal(source.hasMore?.(), true);
            const second = await source.discover(active, note => notes.push(note));
            assert.deepEqual(second.map(c => c.listingId), [gengar.id]);
            assert.equal(source.hasMore?.(), false);
            return { searchId, goal, decision: "WAIT", reason: "Copy evidence remains unchecked.", destination: null, steps: [] };
        },
    });
    const result = await withAiUsageContext({ searchId, watchBudgetId: budgetId }, () => hunt(searchId,
        { ...goal, goal: "resell", listingIds: [], scope: "any_card", standalone: true, filters,
            marketPreferences: { minYear: 1999, maxYear: 2003, finish: "HOLO", printing: "UNLIMITED" } }, signal()));
    assert.deepEqual(releases, ["neo genesis", "neo destiny"]);
    assert.deepEqual(snapshots, [lugia.id, gengar.id]);
    assert.equal(priceSources, 1, "release queries share one price-screening allowance");
    assert.match(notes[0], /loaded 3 distinct listing summaries.*part of the source results/);
    assert.match(result.report.marketNote!, /2 eBay source pages.*2 inventory queries.*Coverage remains partial/);
    assert.equal(result.report.decision, "WAIT");
    assert.equal(result.evaluation, null);
    assert.deepEqual(result.candidates?.map(listing => listing.id), [lugia.id, gengar.id]);
    const completed = huntProgress.read(budgetId, searchId);
    assert.equal(completed?.phase, "completed");
    assert.equal(completed.discovered, 5);
    assert.equal(completed.retained, 2);
    assert.equal(completed.reviewed, 0);
    assert.equal(completed.scans, 2);
});

test("quota and cancellation stop an unseeded inventory hunt before photos", async () => {
    const request = { ...goal, goal: "resell", listingIds: [], scope: "any_card", standalone: true };
    let scans = 0;
    const quota = service(example(), { markets: async () => [], evaluate: unexpected, snapshot: unexpected,
        inventoryScanner: () => async () => { scans++; throw new EbayBudgetError("Daily quota", "QUOTA"); } });
    const limited = await quota(searchId, request, signal());
    assert.equal(scans, 1);
    assert.equal(limited.report.decision, "WAIT");
    assert.match(limited.report.reason, /eBay listing allowance ran out/);
    assert.match(limited.report.marketNote!, /0 eBay source pages.*0 review batches/);
    assert.deepEqual(limited.candidates, []);

    const { promise: dispatched, resolve } = Promise.withResolvers<void>();
    const { promise: cancelled, resolve: finished } = Promise.withResolvers<void>();
    const abort = new AbortController();
    const blocked = service(example(), { markets: async () => [], evaluate: unexpected, snapshot: unexpected,
        inventoryScanner: active => async () => {
            resolve();
            await new Promise<void>(done => active.addEventListener("abort", () => { finished(); done(); }, { once: true }));
            active.throwIfAborted();
            assert.fail("the cancelled scan must not return candidates");
        } });
    const pending = blocked(searchId, request, abort.signal);
    await dispatched;
    abort.abort(new Error("Stop the hunt"));
    await assert.rejects(pending, /Stop the hunt/);
    await cancelled;
});

test("a flip with no seed searches the liquid market with the buyer's filters and returns the checked copy", async () => {
    const f = example(), lead = liquidGradingMarket();
    const filters = { typeFilter: "FIXED_PRICE" as const, kindFilter: "raw" as const, minPrice: 3, maxPrice: 23 };
    let marketReads = 0, termsChecks = 0;
    const other: ListingSummary = { ...f.inventory.rows[0].listing, id: "v1|120000000002|0",
        url: "https://www.ebay.com/itm/120000000002", currentPrice: 6,
        screen: { status: "UNSCREENED", needsAnalysis: "IDENTITY", reason: "Check the original photos.",
            bestCase: null, assumed: null, card: null, evidence: { photos: 2, mainPhoto: "UNKNOWN" } } };
    const hunt = service(f, {
        discovery: unexpected, inventory: unexpected,
        snapshot: async id => id === listingId ? f.snapshot : null,
        details: async id => { assert.equal(id, listingId); termsChecks++; return f.details; },
        markets: async (origin, goal, scope) => {
            assert.equal(origin, null); assert.equal(goal, "resell"); assert.equal(scope, "any_card");
            return [lead];
        },
        discoverMarket: async (id, intent, constraints, active) => {
            assert.equal(id, searchId);
            assert.equal(intent.cardName, lead.name); assert.deepEqual(intent.sets, [lead.set]);
            assert.equal(intent.cardNumber, lead.cardNumber); assert.equal(intent.printing, lead.printing);
            assert.equal(intent.finish, lead.finish); assert.equal(intent.graded, false);
            assert.deepEqual(constraints, filters); assert.equal(active.aborted, false);
            marketReads++;
            return [f.inventory.rows[0].listing, other, other];
        },
    });
    const result = await hunt(searchId, { ...goal, goal: "resell", listingIds: [], scope: "any_card", standalone: true, filters }, signal());
    assert.equal(marketReads, 1);
    assert.equal(termsChecks, 1);
    assert.equal(result.report.decision, "BUY");
    assert.deepEqual(result.report.destination, { listingId, section: "grading" });
    assert.equal(result.report.steps[0].action, "find_listings");
    assert.equal(result.alternative?.listing.id, listingId);
    assert.match(result.alternative!.reason, /3 observed matching sales in 60 days/);
    assert.equal(result.evaluation?.listing.id, listingId);
    assert.deepEqual(result.candidates, [other]);
});

test("standalone auctions return actual live copies on a hunt-wide Wait and drop changed or ended copies", async () => {
    const f = example(), lead = liquidGradingMarket();
    let clock = now;
    const copy = (number: number, end: number): ListingSummary => ({ ...f.inventory.rows[0].listing,
        id: `v1|${number}|0`, url: `https://www.ebay.com/itm/${number}`, buyingOption: "AUCTION",
        endTime: new Date(end).toISOString(), screen: { status: "UNSCREENED", needsAnalysis: "IDENTITY",
            reason: "Check the photos.", bestCase: null, assumed: null, card: null, evidence: { photos: 2, mainPhoto: "UNKNOWN" } } });
    const live = copy(120000000002, now + 3_600_000);
    const changed = copy(120000000003, now + 3_600_000);
    const ending = copy(120000000004, now + 1000);
    const excluded = copy(120000000005, now + 10 * 3_600_000);
    const hunt = service(f, {
        now: () => clock, discovery: unexpected, inventory: unexpected, snapshot: async () => null,
        markets: async () => [lead], researchAuctionSellers: async rows => rows,
        discoverMarket: async () => [changed, live, ending, excluded, live],
        details: async id => ({ ...f.details, id, buyingOption: "AUCTION", endTime: live.endTime, price: 8, shipping: 1,
            bids: 2, auctionBids: { currentBid: 8, minimumBid: 9 }, title: id === changed.id ? "Different card" : live.title }),
        plan: async ({ markets }) => {
            const copies = await markets![0].discover();
            assert.deepEqual(copies.map(copy => copy.listingId).sort(), [live.id, changed.id, ending.id]);
            for (const candidate of copies.filter(c => c.listingId !== ending.id)) await candidate.read("check_listing");
            clock += 2000;
            return { searchId, goal: "resell", decision: "WAIT", reason: "The research limit was reached.", destination: null, steps: [] };
        },
    });
    const result = await hunt(searchId, { ...goal, goal: "resell", listingIds: [], scope: "any_card", standalone: true,
        filters: { typeFilter: "AUCTION" } }, signal());
    assert.equal(result.evaluation, null);
    assert.equal(result.alternative, undefined);
    assert.deepEqual(result.candidates?.map(c => [c.id, c.currentPrice, c.shipping, c.bids, c.images, c.url]),
        [[live.id, 8, 1, 2, live.images, live.url]]);
});

test("two empty live markets lead to a third copy and its checked grading breakdown in the same hunt", async () => {
    const f = example(), lead = liquidGradingMarket();
    const names: string[] = [];
    const hunt = service(f, {
        discovery: unexpected, inventory: unexpected, evaluate: unexpected,
        details: async () => f.details,
        markets: async () => [{ ...lead, name: "Blastoise", cardNumber: "2/102" }, { ...lead, name: "Chansey", cardNumber: "3/102" }, lead],
        discoverMarket: async (id, intent) => {
            assert.equal(id, searchId);
            names.push(intent.cardName!);
            return intent.cardName === lead.name ? [f.inventory.rows[0].listing] : [];
        },
    });
    const result = await hunt(searchId, { ...goal, goal: "resell", listingIds: [], scope: "any_card", standalone: true }, signal());
    assert.deepEqual(names, ["Blastoise", "Chansey", "Venusaur"]);
    assert.equal(result.report.decision, "BUY", result.report.reason);
    assert.deepEqual(result.report.destination, { listingId, section: "grading" });
    assert.equal(result.alternative?.listing.id, listingId);
    assert.equal(result.evaluation?.listing.id, listingId);
});

test("one raw search considers each affordable exit after the photos rule out the first interpretation", async () => {
    const f = example(), lead = liquidGradingMarket();
    const damaged = { ...lead, grader: null, grade: null, condition: "DAMAGED" as const, medianUsd: 25 };
    const otherCard = { ...lead, name: "Blastoise", cardNumber: "2/102" };
    const reads: string[] = [];
    const result = await service(f, {
        discovery: unexpected, inventory: unexpected, snapshot: async () => null,
        markets: async () => [damaged, otherCard, lead],
        evaluate: async () => f.e,
        discoverMarket: async (_id, intent, filters) => {
            reads.push(intent.cardName!);
            assert.ok(filters.maxPrice! > damaged.medianUsd, "one Browse covers the higher grading exit ceiling");
            return [{ ...f.inventory.rows[0].listing, screen: { status: "UNSCREENED", needsAnalysis: "IDENTITY",
                reason: "A photo assessment is needed.", bestCase: null, assumed: null, card: null,
                evidence: { photos: 2, mainPhoto: "UNKNOWN" } } }];
        },
    })(searchId, { ...goal, goal: "resell", listingIds: [], scope: "any_card", standalone: true }, signal());
    assert.deepEqual(reads, ["Venusaur"], JSON.stringify(result.report));
    assert.deepEqual(result.report.steps.filter(step => step.action === "find_listings").map(step => step.title), [`Venusaur ${lead.cardNumber} · Base Set`]);
    assert.equal(result.report.decision, "BUY", result.report.reason);
    assert.deepEqual(result.report.destination, { listingId, section: "grading" });
    assert.equal(result.evaluation?.condition?.rawCondition, "LIGHTLY_PLAYED");
});

test("a liquid comparison market cannot qualify a copy whose assessed printing differs", async () => {
    const f = example(), lead = liquidGradingMarket();
    f.e.identity!.printing = "FIRST_EDITION";
    const result = await service(f, {
        inventory: unexpected, discovery: unexpected, markets: async () => [lead],
        discoverMarket: async () => [f.inventory.rows[0].listing],
    })(searchId, { ...goal, goal: "resell", listingIds: [], scope: "any_card", standalone: true }, signal());
    assert.equal(result.report.decision, "WAIT");
    assert.deepEqual(result.report.steps.map(step => step.action), ["find_listings", "find_listings"]);
    assert.equal(result.report.destination, null);
    assert.equal(result.evaluation, null);
    assert.equal(result.alternative, undefined);
    assert.deepEqual(result.candidates, []);
});

test("a number-discovered Leafeon can reach the buyer only after its original artwork matches the target", async () => {
    const f = freshCopy(120000000167);
    const lead = { ...liquidGradingMarket(), name: "Leafeon V (Alternate Full Art)", set: "Evolving Skies", cardNumber: "167/203" };
    f.row.title = f.e.listing.title = f.details.title = "Evolving Skies shiny card 167/203";
    Object.assign(f.e.identity!, { name: lead.name, set: lead.set, cardNumber: lead.cardNumber, hasEditions: false });
    const check = f.e.photoCheck!;
    check.printedName = "Leafeon V";
    check.printedNumber = "167/203";
    check.cardIdentity = { name: "Leafeon V", set: lead.set, cardNumber: check.printedNumber,
        language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["The original front reads Leafeon V, 167/203."] };
    for (const summary of f.e.gradedPricing!.PSA!.byGrade!) {
        for (const sale of summary.sales) sale.title = `Leafeon V Alternate Full Art 167/203 Evolving Skies Holo PSA ${summary.grade}`;
    }
    f.snapshot.evidenceKey = listingEvidenceKey(f.row);
    f.snapshot.contextKey = evaluationContextKey(f.details);
    const request: DealHuntRequest = { ...goal, goal: "resell", listingIds: [], scope: "any_card", standalone: true };
    for (const saved of [false, true]) for (const artworkMatches of [false, true]) {
        let artworkChecks = 0;
        const dependencies: NonNullable<Parameters<typeof createDealHuntService>[0]> = {
            inventory: unexpected, discovery: unexpected, markets: async () => [lead],
            snapshot: async () => saved ? f.snapshot : null,
            evaluate: saved ? unexpected : async () => f.e,
            details: async () => f.details,
            discoverMarket: async (_id, _intent, _filters, _active, options) => {
                options?.onQuery?.({ strategy: "full_name", query: "Leafeon V 167 Evolving Skies", status: "complete", total: 0,
                    returnedIds: [], eligibleIds: [], numberOnlyIds: [], newEligibleIds: [] });
                options?.onQuery?.({ strategy: "collector_number", query: "167/203", status: "complete", total: 1,
                    returnedIds: [f.row.id], eligibleIds: [f.row.id], numberOnlyIds: [f.row.id], newEligibleIds: [f.row.id] });
                return [f.row];
            },
            verifyCollectorArtwork: async (e, m) => {
                artworkChecks++;
                assert.equal(e.listing.id, f.row.id);
                assert.equal(m.cardNumber, "167/203");
                return { matches: artworkMatches, reason: artworkMatches ? "Leafeon appears among autumn leaves."
                    : "The abstract orange background matches the regular full art." };
            },
        };
        if (saved && !artworkMatches) {
            const unfinished = await service(f, { ...dependencies, verifyCollectorArtwork: unexpected, plan: async ({ markets }) => {
                const [candidate] = await markets![0].discover();
                assert.deepEqual(candidate.available(new Set()), ["inspect_photos"]);
                return { searchId, goal: "resell", decision: "WAIT", reason: "Stopped before inspecting the candidate.", destination: null, steps: [] };
            } })(searchId, request, signal());
            assert.deepEqual(unfinished.candidates, [], "a cached primary reading cannot surface an unchecked alternative");
        }
        const result = await service(f, dependencies)(searchId, request, signal());
        const observations = result.report.steps.filter(step => step.action !== "find_listings");
        assert.equal(observations[0]?.action, "inspect_photos", JSON.stringify(result.report));
        assert.equal(artworkChecks, 1, JSON.stringify({ saved, artworkMatches, report: result.report }));
        if (artworkMatches) {
            assert.equal(result.report.decision, "BUY", result.report.reason);
            assert.equal(result.report.destination?.listingId, f.row.id);
            assert.equal(result.alternative?.listing.id, f.row.id);
        } else {
            assert.deepEqual(observations.map(step => step.action), ["inspect_photos"]);
            assert.match(observations[0].observation, /orange background/);
            assert.equal(result.report.decision, "WAIT");
            assert.equal(result.report.destination, null);
            assert.equal(result.evaluation, null);
            assert.equal(result.alternative, undefined);
            assert.deepEqual(result.candidates, []);
        }
    }
});

test("a refreshed purchase total must fit the buyer's budget including shipping and estimated tax", async () => {
    const f = example();
    Object.assign(f.inventory.rows[0].listing, { currentPrice: 5, shipping: 0, termsCheckedAt: stamp, availability: "ACTIVE" });
    const result = await service(f)(searchId, { ...goal, filters: { maxPrice: 5.20 } }, signal());
    assert.equal(result.report.decision, "WAIT");
    assert.match(result.report.reason, /\$5\.41 after shipping and estimated tax, above your \$5\.20/);
});

test("a broad hunt rejects an invented source ID, incompatible scope or malformed budget before provider access", async () => {
    const f = example();
    const hunt = service(f, { markets: unexpected, discoverMarket: unexpected });
    const empty = { ...goal, standalone: true, scope: "any_card", listingIds: [] };
    for (const invalid of [empty, { ...empty, goal: "resell", listingIds: [listingId] },
        { ...empty, goal: "resell", filters: { maxPrice: -1 } }, { ...empty, goal: "resell", filters: { maxPrice: "5" } },
        { ...empty, goal: "resell", minPotentialGrade: 11 }, { ...empty, goal: "resell", scope: null }]) {
        assert.throws(() => hunt(searchId, invalid, signal()), { status: 400 });
    }
    await assert.rejects(hunt(searchId, { ...goal, goal: "resell", scope: "any_card", listingIds: ["unretained"] }, signal()), { status: 409 });
});

test("an alternate copy reuses its existing photo assessment and original price allowance when sales expire", async () => {
    const f = example(), lead = liquidGradingMarket();
    const sourceSearch = "581ca4c5-4184-4495-873c-0db4f3688442";
    f.snapshot.searchId = sourceSearch;
    f.e.pricesCheckedAt = "2026-11-19T12:00:00Z";
    let priceChecks = 0;
    const hunt = service(f, {
        inventory: unexpected, discovery: unexpected, markets: async () => [lead],
        discoverMarket: async () => [f.inventory.rows[0].listing], details: async () => f.details,
        evaluate: async (id, options) => {
            assert.equal(id, listingId);
            assert.equal(options?.priceOnly, true);
            assert.equal(getAiUsageContext().searchId, sourceSearch);
            priceChecks++;
            return retargetEvaluation({ ...f.e, pricesCheckedAt: stamp }, goal.targets);
        },
    });
    const result = await hunt(searchId, { ...goal, goal: "resell", listingIds: [], scope: "any_card", standalone: true }, signal());
    assert.equal(priceChecks, 1);
    assert.equal(result.report.searchId, searchId);
    assert.equal(result.report.decision, "BUY");
});

test("auction hunt preserves the vintage holo request through two misses and verifies a live bid without rebuying photos", async () => {
    const f = example();
    const terms = { buyingOption: "AUCTION" as const, bids: 1, endTime: new Date(now + 2 * 3_600_000).toISOString() };
    const row = Object.assign(f.inventory.rows[0].listing, terms);
    Object.assign(f.e.listing, terms, { auctionQuote: {currentBid: 5, minimumBid: 6, checkedAt: stamp} });
    const comp = salesSummary("RAW", "LIGHTLY_PLAYED", [80, 85, 90]);
    comp.sales.forEach((sale, i) => Object.assign(sale, { url: "https://www.ebay.com/itm/" + (260000000001 + i),
        saleType: "auction", soldAt: old, photoCondition: "LIGHTLY_PLAYED", conditionEvidence: ["Light whitening visible on back."] }));
    f.e.photoCheck!.cardMatch = { verdict: "MATCH", problems: [] };
    f.e.rawPricing = { status: "PRICED", source: "pkmnprices", printing: "UNLIMITED", finish: "HOLO", variant: "holo",
        conditionEvidence: "AI_PHOTOS", prices: [{ condition:"LIGHTLY_PLAYED", basis: "EBAY_SOLD", price: 85, updatedAt: stamp, comps: comp }] };
    f.e.gradedPricing = null;
    const [market] = rankHuntMarkets([f.e], null, "resell", "any_card", now);
    assert.ok(market);
    const reads: string[] = [];
    let refreshing = 0, sellerChecks = 0;
    const hunt = service(f, {
        discovery: unexpected, inventory: unexpected, evaluate: unexpected,
        setYears: async () => ({"base set": 1999, "neo destiny": 2002, "silver tempest": 2022}),
        markets: async () => [
            { ...market, set: "Silver Tempest" }, { ...market, finish: "NON_HOLO" }, { ...market, set: "Unknown year" },
            { ...market, name: "Mewtwo", cardNumber: "10/102"}, { ...market, name: "Dark Gengar", set: "Neo Destiny", cardNumber: "6/105" }, market
        ],
        discoverMarket: async (_id, intent, bounds) => {
            assert.equal(bounds.typeFilter, "AUCTION");
            reads.push(intent.cardName!);
            return intent.cardName === "Venusaur" ? [row] : [];
        },
        researchAuctionSellers: async rows => {
            sellerChecks += rows.length;
            return rows.map(listing => ({ ...listing, auctionResearch: {cardListings: 2, otherListings: 100, categories: ["CCG singles", "home and garden"], sampledAt: stamp} }));
        },
        details: async (_id, opts) => {
            assert.equal(opts?.maxAgeHours, 0);
            refreshing++;
            return {...f.details, ...terms, auctionBids: {currentBid: 5, minimumBid: 6}};
        },
    });
    const result = await hunt(searchId, { goal:"resell", targets: {minProfit:25, minRoi:0}, listingIds:[], standalone:true, scope:"any_card",
        marketPreferences: {minYear:1999, maxYear:2003, finish:"HOLO"}, filters:{typeFilter:"AUCTION"} }, signal());
    assert.deepEqual(reads, ["Mewtwo", "Dark Gengar", "Venusaur"]);
    assert.equal(sellerChecks, 1); assert.equal(refreshing, 1);
    assert.equal(result.report.decision, "BID", result.report.reason);
    assert.equal(result.evaluation?.listing.auctionQuote?.minimumBid, 6);
    assert.equal(result.auctionOpportunity?.status, "BID");
    assert.equal(result.auctionOpportunity?.reason, result.report.reason);
    assert.equal(result.alternative?.listing.auctionResearch?.otherListings, 100);
    assert.match(result.report.reason, /Bid up to/);
});

test("the planner can check an unassessed auction's legal next bid before paying to study photos", async () => {
    const f = example(), terms = { buyingOption: "AUCTION" as const, bids: 1, endTime: new Date(now + 2 * 3_600_000).toISOString() };
    Object.assign(f.inventory.rows[0].listing, terms);
    const hunt = service(f, {
        inventory: async () => ({ ...f.inventory, filters: {typeFilter: "AUCTION"} }),
        snapshot: async () => null, evaluate: unexpected, markets: unexpected,
        details: async () => ({ ...f.details, ...terms, price: 40, shipping: 10, auctionBids: { currentBid: 40, minimumBid: 41 } }),
    });
    const result = await hunt(searchId, { goal: "resell", targets: goal.targets, scope: "search", listingIds: [listingId],
        filters: { typeFilter: "AUCTION", maxPrice: 50 } }, signal());
    assert.equal(result.report.decision, "WAIT");
    assert.deepEqual(result.report.steps.map(s => s.action), ["check_listing"]);
    assert.match(result.report.reason, /No supported bid.*next bid of/);
    assert.match(result.report.steps[0].observation, /next bid of \$41\.00.*\$55\.21/);
});

test("the planner recovers a sparse slab reference under the hunt allowance and reuses it without photo or listing calls", async () => {
    const f = example(), row = f.inventory.rows[0].listing;
    f.e.condition = null;
    f.e.rawPricing = null;
    f.e.gradedPricing = null;
    f.e.listing.endTime = null;
    f.e.slab = { status: "OK", grader: "CGC", grade: "8.5", gradeQualifier: null, certNumber: null, certUrl: null,
        labelText: "Venusaur 15/102 Unlimited Holo CGC 8.5", caseCondition: "INTACT", reasons: [], concerns: [] };
    Object.assign(f.e.photoCheck!, { holder: "GRADED_SLAB", slab: { ...f.e.slab, present: true, authenticity: "NONE_SEEN" } });
    f.e.slabPricing = { status: "PRICE_UNAVAILABLE", printing: "UNLIMITED", grader: "CGC", grade: 8.5 };
    Object.assign(row, { isGraded: true });
    f.inventory.intent.graded = true;
    let settled = false;
    const modes: boolean[] = [];
    const second = { ...row, id: "v1|120000000002|0" };
    f.inventory.rows.push({ listing: second, assessable: true });
    f.discovery.discovery.retainedIds.push(second.id);
    let hadAlternative = false;
    const hunt = service(f, { snapshot: async id => id === listingId ? f.snapshot : null, restoreRaw: async () => null, supplement: async (e, options) => {
        assert.equal(e.listing.id, listingId);
        assert.deepEqual(getAiUsageContext(), { searchId, listingId });
        modes.push(options.cacheOnly);
        if (!settled && options.cacheOnly) return {};
        settled = true;
        return { trackerPriceReference: { source: "POKEMON_PRICE_TRACKER", printingLabel: "Unlimited Holofoil", tcgPlayerId: 4, caveat: "",
            gradedMarket: { grader: "CGC", grade: "8.5", priceUsd: 110, statistic: "7_DAY_MEDIAN", reportedSales: 9, lastSaleAt: old, marketplaces: ["eBay"] } } };
    } }, (action, menu) => {
        if (action === "0/check_price_references" && menu.includes("1/inspect_photos")) hadAlternative = true;
    });
    const request = { ...goal, goal: "collect_slab", listingIds: [listingId, second.id] };
    for (let i = 0; i < 2; i++) {
        const { report, evaluation } = await hunt(searchId, request, signal());
        assert.equal(report.decision, "WAIT", report.reason);
        assert.match(report.reason, /\$110\.00.*Pokémon Price Tracker/);
        assert.match(report.reason, /matched transaction is still needed/);
        assert.equal(report.steps.filter(step => step.action === "check_price_references").length, 1);
        assert.equal(evaluation?.slabPricing?.summary, undefined);
        assert.equal(evaluation?.underwriting?.best, null);
    }
    assert.deepEqual(modes, [true, false, true]);
    assert.equal(hadAlternative, true, "the planner could instead choose the other copy’s photos");
});

test("a reseller can consult price history, European offers or either supplemental provider under the initiating account", async () => {
    const f = example();
    f.e.listing.endTime = null;
    f.e.identity!.recordId = "1234";
    f.e.rawPricing = { status: "PRICE_UNAVAILABLE" };
    f.e.gradedPricing = null;
    const calls: string[] = [];
    const model = createModelExperimentRunner({ cached: async () => null, save: async () => {},
        run: async request => {
            const { menu } = JSON.parse(request.prompt) as { menu: {key: string}[] };
            const order = ["check_listing", "inspect_photos", "check_sales", "check_price_history", "compare_cardmarket", "search_web_sales", "check_price_tracker"];
            const pick = order.map(action => "0/" + action).find(key => menu.some(m => m.key === key)) ?? menu[0].key;
            return { result: { choice: pick, reason: "Check the available evidence." }, usage: {inputTokens: 1, outputTokens: 1} };
        },
    });
    const remember = (source: string) => {
        assert.equal(getBudgetContext().searchId, searchId);
        assert.equal(getAiUsageContext().listingId, listingId);
        calls.push(source);
    };
    const hunt = service(f, { restoreRaw: async () => null, plan: (input, active) => runDealHunt(input, active, model),
        marketHistory: async () => { remember("history"); return {source:"TCGplayer", scope:"Lightly Played", points:[{day:"2026-11-23",price:45}],
            outlook:"Insufficient evidence", reason:"Sparse daily prices."}; },
        compareCardmarket: async () => { remember("offers"); return {checkedAt:stamp, currency:"EUR", basis:"ACTIVE_ASK", status:"UNAVAILABLE",
            reason:"No offers match this condition.", offers:[]}; },
        supplement: async (_value, options) => { if (!options.cacheOnly) remember(options.source!); return {}; },
    });
    const response = await hunt(searchId, { ...goal, goal:"resell", marketPreferences:{preferRecentSales:true} }, signal());
    assert.deepEqual(calls, ["history", "offers", "web", "tracker"]);
    assert.equal(response.report.decision, "WAIT");
    assert.match(response.report.steps.find(s => s.action === "check_price_history")!.observation, /TCGplayer.*Lightly Played.*\$45\.00/);
    assert.match(response.report.steps.find(s => s.action === "compare_cardmarket")!.observation, /No offers match/);
});

test("an open resale hunt can use a cited catalog lead after its current eBay queries are exhausted", async () => {
    const queries: string[] = [];
    const hunt = service(example(), { discovery: unexpected, inventory: unexpected, snapshot: unexpected, markets: unexpected,
        browsePressure: async () => null, liquidMarkets: async () => [],
        inventoryScanner: () => async (query, intent) => { queries.push(query); return emptyInventory()(query, intent); },
        webInventoryTargets: async (_seed, permitted, kind, _now, _active, _accepts, report) => {
            assert.deepEqual(permitted, []); assert.equal(kind, "raw");
            report?.("The catalog confirmed the cited printing.");
            return [{name:"Lapras", number:"10/62", set:"Fossil", stage:"Catalog-checked web lead"}];
        },
        plan: (input, active) => runDealHunt(input, active, createModelExperimentRunner({cached: async () => null, save: async () => {},
            run: async request => {
                const {menu} = JSON.parse(request.prompt);
                const pick = menu.find((m: {market?:string}) => m.market?.includes("on the web")) ?? menu[0];
                return {result:{choice:pick.key, reason:"Find another eligible printing."},usage:{inputTokens:1,outputTokens:1}};
            },
        })),
    });
    const response = await hunt(searchId, {goal:"resell",scope:"any_card",standalone:true,listingIds:[],freshListings:true,
        targets:goal.targets,filters:{typeFilter:"FIXED_PRICE",kindFilter:"raw"},marketPreferences:{preferRecentSales:true}}, signal());
    assert.deepEqual(queries, ["Pokemon","Lapras 10/62 Fossil"]);
    assert.equal(response.report.decision, "WAIT");
    assert.ok(response.report.steps.some(s => s.observation.includes("confirmed the cited printing")));
});

test("a collector can pursue an under-market auction that fails resale targets using existing slab evidence", async () => {
    const f = example();
    const listing = f.inventory.rows[0].listing;
    const ends = new Date(now + 3_600_000).toISOString();
    const terms = { price: 84, shipping: 5, buyingOption: "AUCTION" as const, endTime: ends, bids: 1 };
    const slab = { status: "OK" as const, grader: "CGC", grade: "8.5", gradeQualifier: null, certNumber: null, certUrl: null,
        labelText: "Venusaur CGC 8.5 Unlimited Holo", caseCondition: "INTACT" as const, reasons: [], concerns: [] };
    Object.assign(f.e.listing, terms, { auctionQuote: { currentBid: 84, minimumBid: 85, checkedAt: stamp } });
    Object.assign(listing, terms, { isGraded: true, currentPrice: 84 });
    Object.assign(f.inventory.filters, { typeFilter: "AUCTION" });
    f.inventory.intent.graded = true;
    const summary = salesSummary("CGC", "8.5", [95, 100, 105]);
    summary.sales.forEach((sale, i) => Object.assign(sale, { saleType: "auction", soldAt: old, url: `https://www.ebay.com/itm/${120000002110 + i}` }));
    Object.assign(f.e, { condition: null, gradedPricing: null, rawPricing: null, slab,
        slabPricing: { status: "PRICED", printing: "UNLIMITED", variant: "Holofoil", grade: 8.5, grader: "CGC", summary } });
    Object.assign(f.e.photoCheck!, { holder: "GRADED_SLAB", slab: { ...slab, present: true, authenticity: "NONE_SEEN" } });
    let detailReads = 0;
    const leads = rankHuntMarkets([f.e], null, "collect_slab", "any_card", now);
    assert.equal(leads.length, 1);
    const hunt = service(f, { details: async () => {
        detailReads++;
        return { ...f.details, ...terms, auctionBids: { currentBid: 84, minimumBid: 85 } };
    }, discoverMarket: async (_id, intent) => {
        assert.equal(intent.grader, "CGC");
        return [listing];
    }, markets: async () => leads, researchAuctionSellers: async rows => rows });
    const criteria = { ...goal, targets: { minProfit: 50, minRoi: 50 }, filters: { typeFilter: "AUCTION", maxPrice: 98 } };
    const collector = await hunt(searchId, { ...criteria, goal: "collect_slab" }, signal());
    assert.equal(collector.report.decision, "BID", collector.report.reason);
    assert.equal(collector.collectorAuction?.marketValue, 100);
    assert.equal(collector.collectorAuction?.nextTotal, 97.43);
    assert.equal(collector.collectorAuction?.maxBid, 85.53);
    assert.equal(collector.auctionOpportunity, undefined);
    assert.equal(collector.report.destination?.section, "sales");
    const reseller = await hunt(searchId, { ...criteria, goal: "resell" }, signal());
    assert.equal(reseller.report.decision, "WAIT", reseller.report.reason);
    const broad = await hunt(searchId, { ...criteria, goal: "collect_slab", standalone: true, listingIds: [], scope: "any_card" }, signal());
    assert.equal(broad.report.decision, "BID", broad.report.reason);
    assert.equal(broad.collectorAuction?.maxBid, collector.collectorAuction?.maxBid);
    assert.equal(detailReads, 3);
});

test("a hunt dispatches only the eligible printing detail and reevaluates that copy against its verified edition", async () => {
    const fixture = example(), { e } = fixture;
    const identified = structuredClone(e);
    e.identity = { ...e.identity!, printing: "UNKNOWN", status: "NEEDS_REVIEW",
        reasons: ["The photos don't clearly show which printing this is."] };
    e.photoCheck!.cardIdentity = { name: "Venusaur", set: "Base Set", cardNumber: "15/102", finish: "HOLO", language: "English", confidence: "HIGH", evidence: ["Name and number on the card."] };
    e.photoCheck!.printingMarks = { firstEditionStamp: "CANT_TELL", artBoxShadow: "CANT_TELL", reprintMark: "NONE_SEEN", evidence: [] };
    identified.focusedPrinting = { rightEdge: "PRESENT", bottomEdge: "PRESENT", stamp: "NOT_PRESENT", observation: "Printed shadows on both frame edges.",
        photoNumber: 1, sourceSha256: "a".repeat(64) };
    let detailCalls = 0;
    const app = service(fixture, {
        evaluate: async (id, options) => {
            detailCalls++; assert.equal(id, listingId); assert.equal(options?.priceOnly, true);
            assert.equal(options?.huntPrinting?.maxDelivered, 80); assert.equal(getAiUsageContext().searchId, searchId);
            return identified;
        },
        plan: async ({ candidates }) => {
            const copy = candidates[0];
            const checked = new Set<import("../../shared/deal-hunt.ts").DealHuntAction>(["inspect_photos"]);
            assert.ok(!copy.available(checked).includes("resolve_printing"));
            await copy.read("check_listing"); checked.add("check_listing");
            assert.ok(copy.available(checked).includes("resolve_printing"));
            assert.equal(copy.outcome(checked), null);
            const observed = await copy.read("resolve_printing");
            assert.match(observed, /original photo 1.*Base Set.*Unlimited/);
            assert.ok(!copy.available(checked).includes("resolve_printing"));
            return { searchId, goal: "resell", decision: "WAIT", steps: [], reason: observed, destination: { listingId, section: "photos" } };
        },
    });
    const response = await app(searchId, { ...goal, goal: "resell", filters: { maxPrice: 80 } }, signal());
    assert.equal(detailCalls, 1);
    assert.equal(response.evaluation?.identity?.printing, "UNLIMITED");
});

test("fresh fixed-price resale starts with current inventory even when past research favored one card", async () => {
    const queries: string[] = [];
    const hunt = service(example(), {
        inventory: unexpected, discovery: unexpected, snapshot: unexpected, markets: unexpected, discoverMarket: unexpected,
        browsePressure: async () => null,
        inventoryScanner: () => async (query, intent, filters, _targets, _now, scan) => {
            queries.push(query);
            assert.equal(intent.cardName, null);
            assert.equal(filters.typeFilter, "FIXED_PRICE");
            assert.equal(scan.freshListings, true);
            return emptyInventory()(query, intent);
        },
    });
    const response = await hunt(searchId, { goal: "resell", scope: "any_card", freshListings: true, standalone: true,
        targets: goal.targets, filters: { typeFilter: "FIXED_PRICE" }, listingIds: [] }, signal());
    assert.deepEqual(queries.map(q => q.toLowerCase()), ["pokemon"]);
    assert.equal(response.report.decision, "WAIT");
});

test("blank liquid hunts still inspect independent inventory when the sampled ranking is empty or temporarily unavailable", async () => {
    for (const unavailable of [false, true]) {
        const queries: string[] = [];
        const hunt = service(example(), {
            discovery: unexpected, inventory: unexpected, snapshot: unexpected, markets: unexpected,
            liquidMarkets: async () => {
                if (unavailable) throw new PricingProviderError("Offline temporary ranking failure", "TEMPORARY", now + 30_000);
                return [];
            },
            inventoryScanner: () => async (query, intent) => { queries.push(query); return emptyInventory()(query, intent); },
        });
        const result = await hunt(searchId, { goal: "resell", scope: "any_card", standalone: true, freshListings: true,
            listingIds: [], targets: goal.targets, filters: { typeFilter: "FIXED_PRICE" }, marketPreferences: { preferRecentSales: true } }, signal());
        assert.deepEqual(queries, ["Pokemon"]);
        assert.equal(result.report.decision, "WAIT");
        assert.doesNotMatch(result.report.marketNote ?? "", /Try a named card/);
    }
    for (const kind of ["CONFIG", "CREDITS", "RATE_LIMIT"] as const) {
        const stop = new PricingProviderError("Offline provider stop", kind);
        const queries: string[] = [];
        const hunt = service(example(), { liquidMarkets: async () => { throw stop; },
            inventoryScanner: () => async (query, intent) => { queries.push(query); return emptyInventory()(query, intent); } });
        await assert.rejects(hunt(searchId, { goal: "resell", scope: "any_card", standalone: true, freshListings: true,
            listingIds: [], targets: goal.targets, filters: { typeFilter: "FIXED_PRICE" }, marketPreferences: { preferRecentSales: true } }, signal()),
            error => error === stop);
        assert.deepEqual(queries, ["Pokemon"], "the first page runs before an uncached ranking is requested");
    }
});

test("a blank flip hunt passes sampled markets and three source pages to find a profitable later physical copy", async t => {
    t.mock.method(globalThis, "fetch", unexpected);
    const queries: [string, number][] = [], assessed: string[] = [], owners = new Set<string | undefined>();
    const root = "fb81c58b-7b64-4d58-bb77-dc67334c1048";
    const rows: ListingSummary[] = Array.from({ length: 800 }, (_, i) => ({
        id: `v1|${120000020000 + i}|0`, title: "Nidoking 11/102 Base Set Unlimited Holo English",
        currentPrice: i === 660 ? 5 : 90, shipping: 0, buyingOption: "FIXED_PRICE", bids: 0, endTime: null,
        images: [`offline-front-${i}`, `offline-back-${i}`], isGraded: false, seller: null,
        url: `https://www.ebay.com/itm/${120000020000 + i}`,
    }));
    const winning = rows[660];
    const model = createModelExperimentRunner({ cached: async () => null, save: async () => {}, run: async request => {
        const { menu } = JSON.parse(request.prompt);
        return { result: { choice: menu[0].key, reason: "Check the next remaining physical copy." }, usage: { inputTokens: 1, outputTokens: 1 } };
    } });
    const hunt = service(example(), {
        discovery: unexpected, inventory: unexpected, snapshot: async () => null, markets: unexpected,
        browsePressure: async () => ({ provider: "EBAY", label: "eBay Browse", limit: 5000, remaining: 4000,
            observedAt: stamp, resetsAt: new Date(now + 3_600_000).toISOString(), usedInWindow: 300, windowMinutes: 10, warning: "FAST" }),
        liquidMarkets: async () => [
            { id: 1, name: "Mew", number: "25/53", set: "Wizards Black Star Promos", sales: 30 },
            { id: 2, name: "Dragonite", number: "4/62", set: "Fossil", sales: 20 },
            { id: 3, name: "Pikachu", number: "58/102", set: "Base Set", sales: 10 },
        ],
        selectReviews: async copies => ({ source: "rules", listingIds: copies.slice(0, 15).map(row => row.id) }),
        inventoryScanner: active => createHuntInventoryScanner(active, offlineSearchSteps([], {
            search: async (query, options) => {
                queries.push([query, options?.offset ?? 0]); owners.add(getBudgetContext().searchId);
                assert.equal(options?.filters?.maxPrice, 150);
                const offset = options?.offset ?? 0;
                return { listings: query.toLowerCase() === "pokemon" ? rows.slice(offset, offset + 200) : [],
                    total: query.toLowerCase() === "pokemon" ? rows.length : 0, skipped: 0, rejections: [],
                    ...(query.toLowerCase() === "pokemon" && offset + 200 < rows.length && { nextOffset: offset + 200 }) };
            },
        })),
        evaluate: async id => {
            owners.add(getBudgetContext().searchId); assessed.push(id);
            const row = rows.find(row => row.id === id)!;
            const e = example().e;
            Object.assign(e.listing, { id, title: row.title, url: row.url, price: row.currentPrice, shipping: 0, endTime: null,
                photos: row.images, shippingDestination: configuredShippingZip(), seller: { username: "offline-seller", feedbackScore: 100, feedbackPercentage: 100 } });
            Object.assign(e.identity!, { name: "Nidoking", cardNumber: "11/102", evidence: { photo: "UNLIMITED" } });
            const card = { name: "Nidoking", cardNumber: "11/102", set: "Base Set", finish: "HOLO" as const,
                language: "English", confidence: "HIGH" as const, evidence: ["Readable name, number and set on the original front."] };
            Object.assign(e.photoCheck!, { cardIdentity: card, printedName: card.name, printedNumber: card.cardNumber });
            clearReleaseFixture(e);
            e.gradedPricing = null;
            const comp = salesSummary("RAW", "LIGHTLY_PLAYED", [100]);
            Object.assign(comp, { median: 100, newestSale: old });
            Object.assign(comp.sales[0], { title: row.title, saleType: "fixed_price", soldAt: old,
                url: "https://www.ebay.com/itm/120000029999" });
            e.rawPricing = { status: "PRICED", printing: "UNLIMITED", finish: "HOLO", variant: "holo", conditionEvidence: "AI_PHOTOS",
                prices: [matchedRawPrice(100, old)], ebayComps: [comp] };
            return retargetEvaluation(e, goal.targets);
        },
        plan: (input, active) => runDealHunt(input, active, model),
    });
    const result = await withAiUsageContext({ searchId: root }, () => hunt(searchId, {
        goal: "resell", scope: "any_card", standalone: true, freshListings: true, listingIds: [], targets: goal.targets,
        filters: { typeFilter: "FIXED_PRICE", maxPrice: 150 }, marketPreferences: { preferRecentSales: true },
    }, signal()));
    assert.equal(result.report.decision, "BUY", JSON.stringify({ report: result.report, queries, assessed }));
    assert.equal(result.report.destination?.listingId, winning.id);
    assert.equal(assessed.at(-1), winning.id, "stop at the verified copy from the fourth page");
    t.diagnostic("Distinct photo assessments before the verified fixture winner: " + assessed.length);
    assert.ok(assessed.length < 661, "the cheaper equivalent copy must move ahead of earlier expensive copies");
    assert.equal(new Set(assessed).size, assessed.length, "accepted photos must not be repurchased in later batches");
    assert.equal(queries.length, 7, "deferred copies drain without repeating source work or stopping at three pages");
    assert.deepEqual(queries.filter(([query]) => query.toLowerCase() === "pokemon").map(([, offset]) => offset), [0, 200, 400, 600]);
    assert.equal(queries.at(-1)?.[0].toLowerCase(), "pokemon", "the independent query remains available after sampled priorities fail");
    assert.deepEqual([...owners], [root]);
    assert.ok((result.candidates?.length ?? 0) <= 50);
    assert.match(result.report.marketNote ?? "", /across 4 inventory queries/);
});

test("a blank flip opens broad inventory first and sends the matched printing and item limit into its next scan", async () => {
    const marketIntent: SearchIntent = { cardName: "Blastoise", cardNumber: "2/102", sets: ["Base Set"], printing: "UNLIMITED",
        graded: false, finish: "HOLO", titleWords: ["Blastoise"], source: "rules" };
    const scans: { query: string; intent: SearchIntent; ceiling?: number; owner?: string }[] = [];
    const root = crypto.randomUUID();
    const hunt = service(example(), { browsePressure: async () => null,
        pricedInventoryTargets: async () => [{ name: "Blastoise", number: "2/102", set: "Base Set", stage: "Recent matched sales",
            exactMarket: { intent: marketIntent, maxItem: 32, reason: "Repeated confirmed sales" } }],
        inventoryScanner: () => async (query, intent, filters) => {
            scans.push({ query, intent, ceiling: filters.maxPrice, owner: getBudgetContext().searchId });
            return { listings: [], summary: { intent, mode: "development", deferred: 0, total: 0, found: 0, count: 0, skipped: 0 } };
        },
        plan: async ({ markets, goal }, active) => {
            const market = markets!.find(m => m.source === "inventory")!;
            await market.discover(active);
            await market.discover(active);
            return { searchId, goal, decision: "WAIT", destination: null, steps: [], reason: "Offline sequence." };
        },
    });
    await withAiUsageContext({ searchId: root }, () => hunt(searchId, { goal: "resell", scope: "any_card", standalone: true,
        freshListings: true, listingIds: [], targets: goal.targets, filters: { typeFilter: "FIXED_PRICE", maxPrice: 50 },
        marketPreferences: { preferRecentSales: true } }, signal()));
    assert.deepEqual(scans.map(s => s.query), ["Pokemon", "Blastoise 2/102 Base Set"]);
    assert.deepEqual(scans.map(s => s.ceiling), [50, 32]);
    assert.deepEqual(scans.map(s => s.owner), [root, root]);
    assert.deepEqual([scans[1].intent.cardNumber, scans[1].intent.printing, scans[1].intent.finish], ["2/102", "UNLIMITED", "HOLO"]);
});

test("ranked queries and independent inventory share turns without losing their pending physical copies", async t => {
    t.mock.method(globalThis, "fetch", unexpected);
    const priorities = [
        { id: 1, name: "Nidoking", number: "11/102", set: "Base Set", sales: 30 },
        { id: 2, name: "Espeon", number: "11/147", set: "Aquapolis", sales: 20 },
        { id: 3, name: "Dark Alakazam", number: "1/82", set: "Team Rocket", sales: 10 },
    ];
    const sourceQueries: string[] = [], batches: string[][] = [], accounts = new Set<string | undefined>();
    const root = "fb81c58b-7b64-4d58-bb77-dc67334c1048";
    const hunt = service(example(), {
        discovery: unexpected, inventory: unexpected, snapshot: async () => null, markets: unexpected,
        browsePressure: async () => null, liquidMarkets: async () => priorities,
        selectReviews: async copies => ({ source: "rules", listingIds: copies.slice(0, 15).map(row => row.id) }),
        inventoryScanner: active => createHuntInventoryScanner(active, offlineSearchSteps([], {
            search: async (query, options) => {
                sourceQueries.push(query); accounts.add(getBudgetContext().searchId);
                assert.equal(options?.offset ?? 0, 0, "no query may fetch its next page before draining its own pending copies");
                const market = priorities.find(target => query.toLowerCase().includes(target.name.toLowerCase())) ??
                    { id: 4, name: "Gengar", number: "5/62", set: "Fossil", sales: 0 };
                const listings = Array.from({ length: 200 }, (_, i): ListingSummary => ({
                    id: `v1|${120000030000 + market.id * 1000 + i}|0`,
                    title: `${market.name} ${market.number} ${market.set} Unlimited Holo English`,
                    currentPrice: 10, shipping: 0, buyingOption: "FIXED_PRICE", bids: 0, endTime: null,
                    images: [`offline-${market.id}-${i}`], isGraded: false, seller: null, url: "#",
                }));
                return { listings, total: 400, nextOffset: 200, skipped: 0, rejections: [] };
            },
        })),
        plan: async ({ markets, goal }, active) => {
            const inventory = markets!.find(market => market.source === "inventory")!;
            for (let turn = 0; turn < 5; turn++) {
                const copies = await inventory.discover(active);
                batches.push(copies.map(copy => copy.listingId));
                assert.equal(copies.length, 50);
                assert.equal(inventory.hasMore?.(), true);
            }
            return { searchId, goal, decision: "WAIT", destination: null, steps: [], reason: "Offline scheduling observation only." };
        },
    });
    await withAiUsageContext({ searchId: root }, () => hunt(searchId, { goal: "resell", scope: "any_card", standalone: true,
        freshListings: true, listingIds: [], targets: goal.targets, filters: { typeFilter: "FIXED_PRICE" },
        marketPreferences: { preferRecentSales: true } }, signal()));
    assert.equal(sourceQueries.length, 4, "the fifth turn must reuse the first market's saved backlog");
    assert.equal(sourceQueries[0].toLowerCase(), "pokemon", "independent discovery starts while market leads are prepared");
    assert.ok(batches[0][0].includes("120000034000"));
    assert.ok(batches[4][0].includes("120000034050"), "the first page's later physical copies remain available in a later round");
    assert.equal(new Set(batches.flat()).size, 250);
    assert.deepEqual([...accounts], [root]);
});

test("the photographed release, name and number must agree before a fresh resale buy", () => {
    const value = example().e;
    const card = { name: "Charizard", cardNumber: "4/102", set: "Base Set", finish: "HOLO",
        language: "English", confidence: "HIGH", evidence: ["Readable original front and edition marks."] };
    Object.assign(value.identity!, { ...card, status: "IDENTIFIED", printing: "UNLIMITED", evidence: { photo: "UNLIMITED" } });
    Object.assign(value.photoCheck!, { cardIdentity: card, cardCount: "ONE", holder: "NONE", printedName: "Charizard", printedNumber: "4/102" });
    assert.equal(huntPhotoIdentityIssue(value), null);
    card.set = "Celebrations";
    assert.match(huntPhotoIdentityIssue(value)!, /release/);
    card.set = "Base Set"; value.photoCheck!.printedName = "Nidoking";
    assert.match(huntPhotoIdentityIssue(value)!, /name and collector number/);
});

test("a guided Ampharos miss gives the planner verified vintage markets and honors its selected query", async () => {
    const queries: string[] = [], menus: string[][] = [];
    const model = createModelExperimentRunner({
        cached: async () => null, save: async () => {},
        run: async request => {
            const prompt = JSON.parse(request.prompt);
            assert.ok(prompt.observed.some((s: {observation:string}) => s.observation.includes("Aquapolis")));
            assert.equal(getAiUsageContext().searchId, searchId);
            menus.push(prompt.menu.map((m: { market:string }) => m.market));
            return { result:{choice: prompt.menu[1].key, reason: "Check Dragonite next based on the eligible markets and earlier misses."},
                usage:{inputTokens:30,outputTokens:9} };
        },
    });
    const hunt = service(example(), {
        markets: unexpected, browsePressure: async () => null,
        guidedInventoryTargets: async function*() {
            yield {name:"Ampharos", set:null, number:null};
            yield {name:null, set:"Aquapolis", number:null};
            yield {name:"Gengar", set:"Fossil", number:"5/62", sales:21};
            yield {name:"Dragonite", set:"Fossil", number:"4/62", sales:19};
        },
        inventoryScanner: () => async (query, intent) => { queries.push(query); return emptyInventory()(query, intent); },
        plan: (input, active) => runDealHunt(input, active, model),
    });
    const response = await hunt(searchId, { goal:"resell", scope:"any_card", standalone:true, listingIds:[], freshListings:true,
        targets:goal.targets, filters:{typeFilter:"FIXED_PRICE"}, marketPreferences:{preferRecentSales:true,
            seed:{name:"Ampharos",number:null,expand:true}} }, signal());
    assert.deepEqual(queries, ["Ampharos","Aquapolis","Dragonite 4/62 Fossil","Gengar 5/62 Fossil"]);
    assert.deepEqual(menus, [["Gengar 5/62 Fossil","Dragonite 4/62 Fossil"]]);
    assert.equal(response.report.steps[2].selectedBy, "model");
    assert.match(response.report.steps[2].reason, /Dragonite/);
    assert.equal(response.report.decision, "WAIT");
});

test("new quota pressure between stages prevents both the guided pivot and its next Browse call", async () => {
    const queries: string[] = [];
    let checks = 0;
    const hunt = service(example(), {
        browsePressure: async () => ++checks === 1 ? null : { provider: "EBAY", label: "eBay Browse", limit: 5000, remaining: 500,
            observedAt: stamp, resetsAt: new Date(now + 3_600_000).toISOString(), usedInWindow: 300, windowMinutes: 10, warning: "LOW_AND_FAST" },
        liquidMarkets: async () => ["A","B","C"].map((name,index) => ({name,id:index+1,set:"Aquapolis",number:"1/147",sales:9-index})),
        inventoryScanner: () => async (query, intent) => { queries.push(query); return emptyInventory()(query, intent); },
        plan: (input, active) => runDealHunt(input, active, async () => assert.fail("A protected pivot must make no model request")),
    });
    const result = await hunt(searchId, {goal:"resell",scope:"any_card",standalone:true,listingIds:[],freshListings:true,
        targets:goal.targets,filters:{typeFilter:"FIXED_PRICE"},marketPreferences:{preferRecentSales:true}}, signal());
    assert.deepEqual(queries, ["Pokemon"]);
    assert.equal(result.report.decision, "WAIT");
    assert.match(result.report.marketNote ?? "", /daily eBay allowance/);
});

test("an exact guided copy resumes at its next action on restart and different artwork never reaches the buyer", async () => {
    for (const artMatches of [false, true]) {
        const root = crypto.randomUUID(), leg = crypto.randomUUID(), f = example();
        const row = f.inventory.rows[0].listing;
        Object.assign(f.e.identity!, { name: "Venusaur", cardNumber: "15/102", set: "Base Set" });
        let pages = 0, pictures = 0, comparisons = 0, attempt = 0;
        const request: DealHuntRequest = { standalone: true, watch: true, freshListings: true, goal: "resell", scope: "any_card",
            listingIds: [], targets: goal.targets, filters: { typeFilter: "FIXED_PRICE" },
            marketPreferences: { seed: { name: "Venusaur", number: "15/102", expand: false }, preferRecentSales: true } };
        const options: NonNullable<Parameters<typeof createDealHuntService>[0]> = {
            markets: unexpected, snapshot: async () => null, browseReserveReset: async () => null, browsePressure: async () => null,
            inventoryScanner: active => createHuntInventoryScanner(active, offlineSearchSteps([], {
                search: async () => { pages++; return { listings: [row], total: 1, skipped: 0, rejections: [] }; },
            })),
            evaluate: async () => { pictures++; assert.equal(getBudgetContext().searchId, root); return f.e; },
            verifyCollectorArtwork: async (value, target) => {
                comparisons++; assert.equal(value.listing.id, row.id); assert.equal(target.cardNumber, "15/102");
                return { matches: artMatches, reason: artMatches ? "The illustrations match." : "The photographed artwork is different." };
            },
            plan: async ({ markets }, signal) => {
                const [copy] = await markets![0].discover(signal);
                assert.ok(copy);
                if (attempt++ === 0) {
                    const message = await copy.read("inspect_photos", signal);
                    assert.match(message, artMatches ? /illustrations match/ : /artwork is different/);
                    throw new Error("Simulated restart after the photo receipt");
                }
                assert.deepEqual(copy.resumedActions, ["inspect_photos"]);
                if (!artMatches) assert.deepEqual(copy.available(new Set(copy.resumedActions)), []);
                return { searchId: leg, goal: "resell", decision: "WAIT", reason: "Checked", destination: null, steps: [] };
            },
        };
        const run = () => withAiUsageContext({ searchId: leg, watchBudgetId: root }, () => service(f, options)(leg, request, signal()));
        await assert.rejects(run(), /Simulated restart/);
        const result = await run();
        assert.equal(result.candidates?.some(candidate => candidate.id === row.id), artMatches);
        assert.equal(result.report.verifiedPurchase, undefined);
        assert.equal(pages, 1);
        assert.equal(pictures, 1);
        assert.equal(comparisons, 1);
    }
});
