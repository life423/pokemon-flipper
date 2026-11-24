import "../fixtures/isolated-data.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { evaluationContextKey } from "../../server/analysis/private-evaluation.ts";
import { createSearchDiagnosticStore, SearchDiagnosticInputError } from "../../server/analysis/search-diagnostic-store.ts";
import { discoverCollectorListings, findBinCompetition, verifyCollectorListing } from "../../server/deals/bin-competition.ts";
import { EbayError } from "../../server/ebay/api.ts";
import type { ListingDetails } from "../../server/ebay/listings.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { maxBid, netFromSale, pathNumbers } from "../../shared/money/underwriting.ts";
import type { SearchCompetition } from "../../shared/search-diagnostic.ts";
import type { Evaluation, ListingSummary, ScreeningSoldReference } from "../../shared/types.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";

const now = Date.now();
const title = "PSA 9 Giratina V 186/196 Alt Alternate Art Pokemon Lost Origin MINT 138177850";
const reference: ScreeningSoldReference = { name: "Giratina V (Alternate Full Art) (Secret)", set: "Lost Origin", cardNumber: "186/196",
    recordId: 1, grader: "PSA", grade: "9", printing: "UNLIMITED", finish: "HOLO", condition: null, summary: salesSummary("PSA", 9, [800, 850, 900]) };
const targets = { minProfit: 10, minRoi: 0.1 };
const expectedNet = netFromSale(850, "graded", MONEY_CONFIG.selling);
const row = (index: number, price: number, suffix = ""): ListingSummary => ({
    id: `v1|12345678900${index}|0`, title: title + suffix, currentPrice: price,
    shipping: 0, images: [], seller: null, url: "https://example.com/", isGraded: true, buyingOption: "FIXED_PRICE", bids: 0, endTime: null,
});
const detail = (row: ListingSummary, shipping: number | null): ListingDetails => ({
    ...row, retrievedAt: new Date(now).toISOString(), availability: "ACTIVE", price: row.currentPrice, shipping, condition: "Graded",
    cardCondition: null, conditionNotes: [], aspects: { "Card Name": "Giratina V", Set: "Pokemon Lost Origin", "Card Number": "186", Language: "English",
        Finish: "Full Art", "Professional Grader": "Professional Sports Authenticator (PSA)", Grade: "9" },
});

function slabEvaluation(): Evaluation {
    const evaluation = cardEvaluation();
    evaluation.identity = { ...evaluation.identity!, name: "Giratina V", set: "Lost Origin", cardNumber: "186/196" };
    evaluation.photoCheck = { ...evaluation.photoCheck!, cardCount: "ONE", holder: "GRADED_SLAB", slab: {
        present: true, grader: "PSA", grade: "9", gradeQualifier: null, certNumber: null, labelText: "LOST ORIGIN GIRATINA V #186 MINT 9",
        caseCondition: "INTACT", authenticity: "NONE_SEEN", authenticityEvidence: [], concerns: [],
    } };
    evaluation.slab = { status: "OK", grader: "PSA", grade: "9", gradeQualifier: null, certNumber: null, certUrl: null, labelText: null,
        caseCondition: "INTACT", reasons: [], concerns: [] };
    evaluation.underwriting = null;
    return evaluation;
}

test("compares delivered terms for the cheapest exact matches from one bounded page", async () => {
    const wrongFinish = row(0, 10, " reverse holo"), badGrade = row(1, 20, " PSA 9 OC"), gone = row(2, 100),
        lowerItem = row(3, 740), lowerDelivered = row(4, 750), unvisited = row(5, 765);
    const checked: string[] = [];
    const signal = new AbortController().signal;
    const result = await findBinCompetition("Giratina V Lost Origin 186 PSA 9", reference, expectedNet, targets, undefined, signal, {
        now: () => now,
        search: async (_query, options) => {
            assert.deepEqual(options, { maxResults: 200, sort: "price", keepReserve: true, signal,
                filters: { typeFilter: "FIXED_PRICE", kindFilter: "graded" } });
            return { listings: [wrongFinish, badGrade, lowerDelivered, unvisited, gone, lowerItem], total: 6, skipped: 0 };
        },
        details: async (id, options) => {
            assert.equal(options?.signal, signal);
            assert.equal(options?.keepReserve, true);
            checked.push(id);
            if (id === gone.id) throw new EbayError("Gone", 410);
            if (id === lowerItem.id) return detail(lowerItem, 30);
            if (id === lowerDelivered.id) return detail(lowerDelivered, 0);
            return assert.fail("Unexpected detail lookup");
        },
        loadEvaluation: async () => null,
    });
    assert.deepEqual(checked, [gone.id, lowerItem.id, lowerDelivered.id]);
    const numbers = pathNumbers({ expectedNet, fixedCosts: 0, shipping: 0, price: 750 }, { ...MONEY_CONFIG, targets });
    assert.deepEqual(result, { title, url: "https://www.ebay.com/itm/123456789004", price: 750, shipping: 0,
        ceiling: maxBid({ expectedNet, fixedCosts: 0, shipping: 0 }, { ...MONEY_CONFIG, targets }), identity: "LISTING",
        pricing: { resale: 850, totalCost: numbers.cost, profit: numbers.profit, roi: numbers.roi, sales: 3 }, seller: null,
        checkedAt: new Date(now).toISOString(), coverage: { found: 6, checked: 3 } });
    assert.ok(result!.pricing!.profit < 0, "the cheapest checked copy remains useful while showing the cost of a losing flip");
});

test("requires fresh active terms with a destination quote and does not override a saved assessment", async () => {
    const unquoted = row(0, 700), stale = row(1, 705), conflict = row(2, 709);
    const details = new Map([
        [unquoted.id, detail(unquoted, null)],
        [stale.id, { ...detail(stale, 0), retrievedAt: new Date(now - 120_001).toISOString() }],
        [conflict.id, detail(conflict, 0)],
    ]);
    const checked: string[] = [];
    const result = await findBinCompetition("Giratina V", reference, expectedNet, targets, undefined, undefined, {
        now: () => now,
        search: async () => ({ listings: [unquoted, stale, conflict], total: 3, skipped: 0 }),
        details: async id => details.get(id)!,
        checkLabel: async () => assert.fail("Unquoted, stale or photo-conflicting inventory cannot trigger another label check."),
        loadEvaluation: async id => {
            checked.push(id);
            return { version: 1, contextKey: evaluationContextKey(details.get(id)!), evidenceKey: "unused", evaluation: cardEvaluation() };
        },
    });
    assert.deepEqual(checked, [conflict.id]);
    assert.equal(result, undefined);
});

test("uses matching saved label evidence over incomplete eBay specifics", async () => {
    const candidate = row(0, 780);
    const listing = { ...detail(candidate, 9), aspects: {} };
    const evaluation = slabEvaluation();
    evaluation.slab!.concerns = ["Minor scuffs on the plastic case."];
    const result = await findBinCompetition("Giratina V", reference, expectedNet, targets, 800, undefined, {
        now: () => now,
        search: async () => ({ listings: [candidate], total: 1, skipped: 0 }),
        details: async () => listing,
        loadEvaluation: async () => ({ version: 1, contextKey: evaluationContextKey(listing), evidenceKey: "unused", evaluation }),
    });
    assert.equal(result?.identity, "PHOTO");
    assert.equal(result?.shipping, 9);
    assert.equal(result?.ceiling, maxBid({ expectedNet, fixedCosts: 0, shipping: 9 }, { ...MONEY_CONFIG, targets }));
    assert.deepEqual(result?.concerns, ["Minor scuffs on the plastic case."]);
});

test("checks the label of an affordable Gallery copy above the flip ceiling", async () => {
    const market = { ...reference, name: "Leafeon VSTAR", set: "SWSH: Crown Zenith: Galarian Gallery", cardNumber: "GG35/GG70",
        grade: "10", summary: salesSummary("PSA", 10, [145, 150, 155]) };
    const source = { ...row(0, 130), title: "Crown Zenith #GG35 Full Art/Leafeon VSTAR PSA 10", shipping: 6 };
    const tie = { ...source, id: row(1, 130).id };
    const wrongNumber = { ...source, id: row(2, 90).id, title: source.title.replace("GG35", "GG34"), currentPrice: 90 };
    const missingNumber = { ...wrongNumber, id: row(3, 90).id, title: source.title.replace("#GG35", "") };
    const listing = { ...detail(source, 6), images: ["https://i.ebayimg.com/example.jpg"],
        aspects: { Set: "Crown Zenith", "Card Name": "FULL ART/LEAFEON VSTAR", "Card Number": "GG35", "Professional Grader": "PSA", Grade: "10" } };
    const result = await findBinCompetition("Leafeon VSTAR", market, netFromSale(150, "graded", MONEY_CONFIG.selling),
        { minProfit: 0, minRoi: 0 }, undefined, undefined, {
            now: () => now,
            search: async () => ({ listings: [wrongNumber, missingNumber, source, tie], total: 4, skipped: 0 }),
            details: async id => { assert.equal(id, source.id); return listing; },
            loadEvaluation: async () => null,
            checkLabel: async (item, ref) => { assert.equal(item, listing); assert.equal(ref, market); return true; },
        });
    assert.equal(result?.identity, "LABEL");
    assert.equal(result?.pricing?.totalCost, 147.22);
    assert.ok(result!.pricing!.profit < 0);
    assert.ok(result!.ceiling < 130);
    assert.deepEqual(result?.coverage, { found: 4, checked: 1 });
    const overMarket = await findBinCompetition("Leafeon VSTAR", market, netFromSale(150, "graded", MONEY_CONFIG.selling),
        { minProfit: 0, minRoi: 0 }, undefined, undefined, {
            now: () => now, search: async () => ({ listings: [source], total: 1, skipped: 0 }),
            details: async () => ({ ...listing, shipping: 12 }), loadEvaluation: async () => null,
            checkLabel: async () => assert.fail("The updated shipping quote already prices this copy above its sold reference."),
        });
    assert.equal(overMarket, undefined);
});

test("respects user price bounds in discovery and after current terms change", async () => {
    const below = row(0, 99), above = row(1, 801), raised = row(2, 700), matching = row(3, 750);
    const checked: string[] = [];
    const result = await findBinCompetition("Giratina V", reference, expectedNet, targets, 800, undefined, {
        minPrice: 100, now: () => now,
        search: async (_query, options) => {
            assert.deepEqual(options?.filters, { typeFilter: "FIXED_PRICE", kindFilter: "graded", minPrice: 100, maxPrice: 800 });
            return { listings: [below, above, raised, matching], total: 4, skipped: 0 };
        },
        details: async id => {
            checked.push(id);
            return id === raised.id ? { ...detail(raised, 0), price: 850 } : detail(matching, 0);
        },
        loadEvaluation: async () => null,
    });
    assert.deepEqual(checked, [raised.id, matching.id]);
    assert.equal(result?.price, 750);
    assert.equal(await findBinCompetition("Giratina V", reference, expectedNet, targets, 50, undefined, {
        minPrice: 100, search: async () => assert.fail("An invalid price range must not request listings."),
    }), undefined);
});

test("does not promote a saved cracked slab or a deeper material concern", async () => {
    const candidate = row(0, 600), listing = detail(candidate, 0);
    for (const cracked of [true, false]) {
        const evaluation = slabEvaluation();
        if (cracked) evaluation.slab!.caseCondition = "CRACKED";
        else evaluation.deeperPhotoReview = { inputKey: "saved", reviewedAt: new Date(now).toISOString(), summary: "Focused holder review", photoNumbers: [1],
            findings: [{ area: "SURFACE", impact: "NEW_CONCERN", observation: "The holder may have been tampered with.", photoNumbers: [1] }],
            requestedPhotos: [], usage: { inputTokens: 100, outputTokens: 30 } };
        const result = await findBinCompetition("Giratina V", reference, expectedNet, targets, undefined, undefined, {
            now: () => now, search: async () => ({ listings: [candidate], total: 1, skipped: 0 }), details: async () => listing,
            loadEvaluation: async () => ({ version: 1, contextKey: evaluationContextKey(listing), evidenceKey: "unused", evaluation }),
        });
        assert.equal(result, undefined);
    }
});

test("saves enriched current-buy comparisons and continues reading older comparison records", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bin-comparison-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = createSearchDiagnosticStore({ directory });
    const discovery = { total: 0, found: 0, skipped: 0, deferred: 0, retainedIds: [] };
    const legacy: SearchCompetition = { title, url: "https://www.ebay.com/itm/123456789000", price: 780, shipping: 9, ceiling: 600, identity: "LISTING" };
    const enriched: SearchCompetition = { ...legacy, pricing: { resale: 850, totalCost: 854.09, profit: -137.34, roi: -0.16, sales: 3 },
        image: "https://i.ebayimg.com/images/g/example/s-l1600.jpg", seller: { username: "example", feedbackPercentage: 99.8, feedbackScore: 200 },
        checkedAt: new Date(now).toISOString(), coverage: { found: 200, checked: 3 }, concerns: ["Minor plastic scuffs."] };
    for (const competition of [legacy, enriched]) {
        const id = randomUUID();
        await store.saveDiscovery(id, { ...discovery, competition });
        assert.deepEqual((await store.loadDiscovery(id))?.discovery.competition, competition);
        assert.deepEqual((await store.saveSnapshot(id, [], {}))?.discovery.competition, competition);
    }
    for (const competition of [{ ...enriched, pricing: { ...enriched.pricing!, profit: NaN } },
        { ...enriched, image: "javascript:alert(1)" }, { ...enriched, url: "https://example.com/" },
        { ...enriched, coverage: { found: 1, checked: 3 } }]) {
        await assert.rejects(store.saveDiscovery(randomUUID(), { ...discovery, competition }), SearchDiagnosticInputError);
    }
});


test("live research keeps alternate 151 titles and unquoted shipping, then checks fresh terms and the actual slab", async t => {
    const originalZip = process.env.EBAY_SHIP_TO_ZIP;
    process.env.EBAY_SHIP_TO_ZIP = "10001";
    t.after(() => { if (originalZip === undefined) delete process.env.EBAY_SHIP_TO_ZIP; else process.env.EBAY_SHIP_TO_ZIP = originalZip; });
    const market = { ...reference, name: "Charmeleon", set: "SV: Scarlet & Violet 151", cardNumber: "169/165", soleCatalogVariant: true };
    const listing = { ...row(0, 68), title: "Pokemon MEW EN Charmeleon 169/165 Illustration Rare PSA 9", shipping: null };
    const other = { ...row(1, 70), title: "2023 Pokemon SV 151 Charmeleon 169/165 Illustration Rare Holo PSA 9 English" };
    const wrong = { ...row(2, 45), title: "Charmeleon 169/165 SV2a PSA 9" };
    const result = await discoverCollectorListings("Charmeleon PSA 9", market, undefined, { maxPrice: 70.21, includeUngraded: true,
        search: async (_, options) => {
            assert.deepEqual(options?.filters, { typeFilter: "FIXED_PRICE", kindFilter: "all", maxPrice: 70.21 });
            assert.equal(options?.cacheMode, "refresh");
            return { listings: [listing, other, wrong], total: 3, skipped: 0 };
        } });
    assert.equal(result.fetched, 3); assert.equal(result.rejected, 1);
    assert.deepEqual(result.candidates.map(candidate => candidate.id), [listing.id, other.id]);
    const candidate = result.candidates[0];
    assert.equal(candidate.total, null); assert.equal(candidate.minimumTotal, 73.61);
    const slab = { ...detail(listing, null), images: ["https://i.ebayimg.com/images/g/Test/s-l1600.jpg"], aspects: { Set: "Pokemon Mew En-151",
        "Card Name": "Charmeleon", "Card Number": "169", "Professional Grader": "PSA", Grade: "9", Language: "English", "Certification Number": "12345678" } };
    const asOf = slab.retrievedAt!;
    const saved = { asOf, query: "Charmeleon PSA 9", reference: market, listing: { title: slab.title, checkedAt: asOf, url: "https://www.ebay.com/itm/123456789000",
        image: slab.images[0], identity: "LABEL" as const, price: 68, shipping: 0, ceiling: 40, pricing: { totalCost: 73.61, resale: 76, profit: -16, roi: -0.2, sales: 8 } },
        label: { grade: "9", grader: "PSA", cert: "12345678", source: "Saved photo" } };
    const options = { now: () => now, loadEvaluation: async () => null, checkLabel: async () => false, details: async () => slab };
    assert.equal((await verifyCollectorListing(candidate, market, saved, undefined, options)).status, "unresolved");
    const quoted = { ...slab, shipping: 3 };
    const checked = await verifyCollectorListing(candidate, market, saved, undefined, { ...options, details: async () => quoted });
    assert.equal(checked.listing?.pricing?.totalCost, 76.86); assert.equal(checked.listing?.identity, "LABEL");
    const changedCert = { ...quoted, aspects: { ...quoted.aspects, "Certification Number": "87654321" } };
    assert.equal((await verifyCollectorListing(candidate, market, saved, undefined, { ...options, details: async () => changedCert })).status, "unresolved");
});

test("live discovery drops observed conflicting releases and collector numbers while retaining grade, year and certificate digits", async t => {
    const originalZip = process.env.EBAY_SHIP_TO_ZIP;
    process.env.EBAY_SHIP_TO_ZIP = "10001";
    t.after(() => { if (originalZip === undefined) delete process.env.EBAY_SHIP_TO_ZIP; else process.env.EBAY_SHIP_TO_ZIP = originalZip; });
    const market = { ...reference, name: "Charmeleon", set: "SV: Scarlet & Violet 151", cardNumber: "169/165" };
    const keep = [
        "Charmeleon 169/165 Illustration Rare PSA 9 2023",
        "2023 Charmeleon PSA 9 #123456789",
        "PSA 9 Charmeleon 123456789",
        "2023 PSA 9 Charmeleon",
        "2023 PSA 9 cert 123456789 Charmeleon",
    ];
    const reject = [
        "2023 POKEMON OBF EN-OBSIDIAN FLAMES 027 CHARMELEON PSA 9 MINT",
        "Charmeleon 079 PSA 9",
        "Pokemon Charmeleon PAF EN Special Coll Promo PSA 9 MINT",
        "PSA MINT 9 CHARMELEON FOIL VIVID VOLTAGE",
        "PSA MINT 9 - POKEMON CLC-TRADING CARD GAME CLASSIC CHARMELEON 002",
        "Charmeleon PSA 9 My First Battle - Charmander Deck Stamp",
        "Charmeleon - 5 of Spades - PSA 9 - Bicycle Mini Playing Cards",
    ];
    const listings = [...keep, ...reject].map((text, i) => ({ ...row(i, 60), title: text }));
    const result = await discoverCollectorListings("Charmeleon PSA 9", market, undefined, {
        knownSets: ["Obsidian Flames", "Trading Card Game Classic", "My First Battle", "Vivid Voltage", "Paldean Fates"],
        search: async () => ({ listings, total: listings.length, skipped: 0 }),
    });
    assert.deepEqual(result.candidates.map(candidate => candidate.title), keep);
});
