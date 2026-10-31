import { test } from "node:test";
import assert from "node:assert/strict";
import { createActiveComparableFinder, matchesActiveSlab } from "../../server/pricing/active-comps.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { resaleActivity } from "../../shared/liquidity.ts";
import type { ListingDetails } from "../../server/ebay/listings.ts";
import type { ListingSummary, PhotoCheck, Slab } from "../../shared/types.ts";

const identity = cardEvaluation().identity!;
const slab: Slab = { status: "OK", grader: "PSA", grade: "7", gradeQualifier: null, certNumber: "999999", certUrl: null, labelText: "PSA 7 Venusaur Holo", caseCondition: "INTACT", reasons: [], concerns: [] };
const seller = { username: "established", feedbackScore: 250, feedbackPercentage: 99.8 };
const listing = (id: string, price = 100, shipping: number | null = 0): ListingDetails => ({ id, title: "Venusaur Base Set 15/102 Holo PSA 7", url: `https://www.ebay.com/itm/${id}`, images: [`${id}-front`, `${id}-back`], price, shipping, buyingOption: "FIXED_PRICE", availability: "ACTIVE", bids: 0, endTime: null, seller, aspects: { "Professional Grader": "PSA", Grade: "7" }, condition: "Graded", cardCondition: null, conditionNotes: [] });
const summary = (value: ListingDetails): ListingSummary => ({ ...value, currentPrice: value.price, isGraded: true });
const reading = (cert = "123456"): PhotoCheck => ({ ...cardEvaluation().photoCheck!, cardCount: "ONE", holder: "GRADED_SLAB", cardIdentity: { name: identity.name, set: identity.set, cardNumber: identity.cardNumber, finish: "HOLO", language: "English", confidence: "HIGH", evidence: ["Readable name, collector number and Base Set artwork"] },
    printingMarks: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT", reprintMark: "NONE_SEEN", evidence: ["Unlimited border"] },
    slab: { present: true, grader: "PSA", grade: "7", gradeQualifier: null, certNumber: cert, labelText: "1999 POKEMON VENUSAUR #15 HOLO NM 7", caseCondition: "INTACT", authenticity: "NONE_SEEN", concerns: [] } });

test("active comparisons require the exact physical slab and reject stock images, wrong grades, cracks and self comparisons", () => {
    const photo = reading(); const item = listing("1");
    assert.equal(matchesActiveSlab(photo, item, identity, slab), true);
    assert.equal(matchesActiveSlab({ ...photo, images: photo.images.map(image => ({ ...image, isStockImage: true })) }, item, identity, slab), false);
    assert.equal(matchesActiveSlab({ ...photo, slab: { ...photo.slab!, grade: "8" } }, item, identity, slab), false);
    assert.equal(matchesActiveSlab({ ...photo, slab: { ...photo.slab!, caseCondition: "CRACKED" } }, item, identity, slab), false);
    assert.equal(matchesActiveSlab({ ...photo, slab: { ...photo.slab!, authenticity: "LIKELY_FAKE" } }, item, identity, slab), false);
    assert.equal(matchesActiveSlab(reading(slab.certNumber!), item, identity, slab), false);
    assert.equal(matchesActiveSlab({ ...photo, cardIdentity: { ...photo.cardIdentity!, finish: "REVERSE_HOLO" } }, item, identity, slab), false);
    assert.equal(matchesActiveSlab({ ...photo, printingMarks: { ...photo.printingMarks!, firstEditionStamp: "VISIBLE" } }, item, identity, slab), false);
    assert.equal(matchesActiveSlab({ ...photo, printingMarks: { ...photo.printingMarks!, artBoxShadow: "ABSENT" } }, item, { ...identity, printing: "SHADOWLESS" }, slab), false);
});

test("active fallback selects the lowest buyer total, excludes the subject and weak sellers, and reuses concurrent paid work", async () => {
    const items = [listing("subject", 1), { ...listing("weak", 2), seller: { ...seller, feedbackScore: 2 } }, listing("a", 80, 30), listing("b", 100, 0), listing("missing", 70, null)];
    const cache = new Map<string, unknown>(); let searches = 0, details = 0, photos = 0;
    const find = createActiveComparableFinder({
        search: async () => { searches++; return { listings: items.map(summary), total: items.length, skipped: 0 }; },
        details: async id => { details++; return items.find(item => item.id === id)!; },
        read: async (_urls, item) => { photos++; return { result: reading(item.id === "a" ? "111111" : "222222"), usage: {} as any }; },
        cached: async <T>(key: string) => cache.get(key) as T ?? null, save: async (key, value) => { cache.set(key, value); }, savedAssessment: async () => null,
    });
    const [a, b] = await Promise.all([find(identity, slab, "subject"), find(identity, slab, "subject")]);
    assert.equal(searches, 1); assert.equal(details, 3); assert.equal(photos, 2);
    assert.equal(a?.lowestTotal, 100); assert.equal(a?.resalePrice, 95); assert.deepEqual(a, b);
    assert.deepEqual(a?.listings.map(item => item.id), ["b", "a"]);
    await find(identity, slab, "subject"); assert.equal(photos, 2);
    const e = cardEvaluation({ minProfit: 0, minRoi: 0 }); e.slab = slab; e.condition = null; e.listing.price = 20; e.listing.shipping = 0;
    e.slabPricing = { status: "PRICED", source: "ebay-active", activeReference: a! };
    e.underwriting = underwrite(e, { ...MONEY_CONFIG, targets: { minProfit: 0, minRoi: 0 } });
    assert.equal(e.underwriting.verdict, "BUY_GRADED"); assert.equal(e.underwriting.best?.salePrice, 95);
    assert.ok(e.underwriting.best!.profit < 75, "tax, outbound shipping and sale fees remain included");
    assert.equal(resaleActivity(e).recentSales, null, "active listings cannot become sold volume");
    e.listing.price = 100;
    assert.equal(underwrite(e).verdict, "PASS");
    e.slabPricing.activeReference = { ...a!, grade: "8" };
    assert.equal(underwrite(e).verdict, "CANT_PRICE", "another certified grade cannot supply a value");
});

test("competing listing work is bounded and auctions cannot provide instant-purchase references", async () => {
    const items = Array.from({ length: 12 }, (_, index) => listing(String(index), index + 10));
    items.unshift({ ...listing("auction", 1), buyingOption: "AUCTION" });
    let details = 0, photos = 0;
    const find = createActiveComparableFinder({ search: async () => ({ listings: items.map(summary), total: items.length, skipped: 0 }),
        details: async id => { details++; return items.find(item => item.id === id)!; },
        read: async () => { photos++; return { result: { ...reading(), cardCount: "MULTIPLE" }, usage: {} as any }; },
        cached: async () => null, save: async () => {}, savedAssessment: async () => null,
    });
    assert.equal(await find(identity, slab, "subject"), null);
    assert.equal(details, 6); assert.equal(photos, 3);
});
