import assert from "node:assert/strict";
import test from "node:test";
import type { DealHuntRequest } from "../../shared/deal-hunt.ts";
import { listingEvidenceKey } from "../../shared/listing-evidence.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import type { Evaluation, ListingSummary, SearchIntent } from "../../shared/types.ts";
import { getAiUsageContext } from "../../server/ai/usage-context.ts";
import { createDealHuntService } from "../../server/analysis/deal-hunt-service.ts";
import { runDealHunt } from "../../server/analysis/deal-hunt.ts";
import { createModelExperimentRunner } from "../../server/analysis/model-experiment.ts";
import { evaluationContextKey } from "../../server/analysis/private-evaluation.ts";
import { rankHuntMarkets } from "../../server/analysis/same-set-markets.ts";
import type { ListingDetails } from "../../server/ebay/listings.ts";
import { EbayBudgetError } from "../../server/ebay/usage.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";

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
        details: unexpected, evaluate: unexpected, supplement: unexpected, plan: (input, signal) => runDealHunt(input, signal, choose), ...overrides,
    });
}

const signal = () => new AbortController().signal;

test("the service rejects a listing outside the search before any inventory, evidence or provider request", async () => {
    const hunt = service(example(), { inventory: unexpected, snapshot: unexpected, plan: unexpected });
    await assert.rejects(hunt(searchId, { ...goal, listingIds: ["v1|120000000002|0"] }, signal()), { status: 409 });
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
            return f.e;
        },
    });
    const result = await hunt(searchId, goal, signal());
    assert.equal(calls, 1);
    assert.equal(result.report.steps[0].action, "inspect_photos");
    assert.equal(result.report.decision, "BUY");
    assert.deepEqual(result.report.destination, { listingId, section: "grading" });
    assert.equal(result.evaluation?.listing.id, listingId);
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

test("the hunt can explain saved comparisons when the purchase and price refresh hit the eBay quota", async () => {
    const f = example();
    f.e.listing.termsCheckedAt = old;
    f.e.pricesCheckedAt = "2026-11-19T12:00:00Z";
    const capped = async () => { throw new EbayBudgetError("Browse quota reached", "QUOTA"); };
    const result = await service(f, { details: capped, evaluate: capped })(searchId, goal, signal());
    assert.equal(result.report.decision, "WAIT");
    assert.match(result.report.reason, /last checked listing/);
    assert.ok(result.report.steps.some(step => step.action === "check_sales" && /PSA 7/.test(step.observation)));
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

test("omitting the hunt scope keeps a named search within its retained rows without market discovery", async () => {
    const result = await service(example(), { markets: unexpected, discoverMarket: unexpected })(searchId, goal, signal());
    assert.equal(result.report.decision, "BUY");
    assert.equal(result.report.destination?.listingId, listingId);
    assert.equal(result.alternative, undefined);
    assert.equal(result.candidates, undefined);
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
    assert.match(result.alternative!.reason, /3 matched sales in 30 days/);
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
    assert.deepEqual(result.report.steps.map(step => step.action), ["find_listings"]);
    assert.equal(result.report.destination, null);
    assert.equal(result.evaluation, null);
    assert.equal(result.alternative, undefined);
    assert.deepEqual(result.candidates, []);
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
