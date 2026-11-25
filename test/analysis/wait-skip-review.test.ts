import "../fixtures/isolated-data.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { buyerReviewBlock } from "../../shared/wait-skip-review.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import type { Evaluation, ListingSummary, SearchIntent } from "../../shared/types.ts";
import { getAiUsageContext } from "../../server/ai/usage-context.ts";
import { AiSpendingError } from "../../server/ai/spending.ts";
import { ProviderError } from "../../server/lib/http.ts";
import { createBuyerListingReviewer } from "../../server/analysis/wait-skip-review.ts";
import { cardEvaluation, clearReleaseFixture, salesSummary } from "../fixtures/card-evaluation.ts";

const searchId = "e94a7e8a-2f78-40e8-afc8-941d0aab6803";
const otherSearch = "348cae85-377d-44a4-9436-25a311eb2d4c";
const listingId = "v1|120000000002|0";
const targets = { minProfit: 0, minRoi: 0 };
const now = Date.now();
const stamp = new Date(now).toISOString();
const signal = () => new AbortController().signal;

function fixture(price = 200) {
    const e = cardEvaluation(targets);
    const photos = ["a", "b", "c", "d"].map(id => `https://i.ebayimg.com/images/g/${id}/s-l1600.jpg`);
    Object.assign(e.listing, { id: listingId, photos, photosInListing: photos.length, price, shipping: 0, buyingOption: "FIXED_PRICE", endTime: null,
        availability: "ACTIVE", termsCheckedAt: stamp, url: "https://www.ebay.com/itm/120000000002" });
    Object.assign(e, { answeredAt: stamp, pricesCheckedAt: stamp, pricingVersion: PRICING_VERSION, assessmentVersion: "vendor/bounded-prompts-4",
        conditionVersion: "provider/bounded-condition-1/prompts-1", gradedPricing: null });
    e.photoCheck!.cardCount = "ONE";
    clearReleaseFixture(e);
    const sales = salesSummary("RAW", "LIGHTLY_PLAYED", [70, 75, 80]);
    for (const [i, sale] of sales.sales.entries()) {
        Object.assign(sale, { title: e.listing.title, saleType: "fixed_price", url: `https://www.ebay.com/itm/${120000001000 + i}`,
            photoCondition: "LIGHTLY_PLAYED", conditionEvidence: ["Minor edge wear."] });
    }
    e.rawPricing = { status: "PRICED", printing: "UNLIMITED", source: "pkmnprices", variant: "holo", conditionEvidence: "AI_PHOTOS",
        prices: [{ basis: "EBAY_SOLD", price: 75, condition: "LIGHTLY_PLAYED", updatedAt: stamp, comps: sales }] };
    const row: ListingSummary = { id: listingId, title: e.listing.title, currentPrice: price, url: e.listing.url, shipping: 0, images: photos,
        isGraded: false, buyingOption: "FIXED_PRICE", endTime: null, bids: 0, seller: null };
    const intent: SearchIntent = { cardName: "Venusaur", sets: [], cardNumber: null, printing: null, graded: null, titleWords: ["venusaur"], source: "rules" };
    const discovery = { searchId, savedAt: stamp, discovery: { total: 1, found: 1, skipped: 0, deferred: 0, retainedIds: [listingId] } };
    const snapshot = { version: 1 as const, contextKey: "gallery", evidenceKey: "photos", searchId, evaluation: e };
    const inventory = { filters: {}, intent, rows: [{ listing: row, assessable: false }] };
    return { e, row, discovery, snapshot, inventory };
}
const unexpected = async () => assert.fail("Unexpected provider call");
function harness(f: ReturnType<typeof fixture>, overrides: Parameters<typeof createBuyerListingReviewer>[0] = {}) {
    const cache = new Map<string, unknown>();
    return createBuyerListingReviewer({ discovery: async () => f.discovery, inventory: async () => f.inventory, snapshot: async () => f.snapshot,
        now: () => now, cached: async <T>(key: string) => cache.get(key) as T ?? null, save: async (key, val) => { cache.set(key, val); },
        restorePhotoReview: async e => e, evaluate: unexpected, deeper: unexpected, ...overrides });
}

test("a completed loss is immediately explained at the asking price without additional photo or pricing charges", async () => {
    const f = fixture();
    const result = await harness(f)(searchId, listingId, targets, true, true, signal());
    assert.equal(result.decision, "SKIP"); assert.equal(result.evidence, "saved");
    assert.match(result.reason, /\$[\d.]+ loss after purchase and resale costs/);
    assert.match(result.reason, /\$75\.00 resale estimate uses 3 photo-checked Lightly Played sales/);
});

test("a sold photo checked for another copy prices a saved loss even when eBay cannot refresh the listing", async () => {
    const f = fixture();
    const raw = structuredClone(f.e.rawPricing!);
    const comp = raw.prices![0].comps!;
    comp.count = 1;
    comp.sales = [comp.sales[1]];
    f.e.rawPricing = { ...raw, status: "PRICE_UNAVAILABLE", ebayComps: [], prices: [] };
    const lastChecked = new Date(now - 3600_000).toISOString();
    f.e.listing.termsCheckedAt = lastChecked;
    f.row.termsCheckedAt = lastChecked;
    const review = harness(f, { restoreRaw: async () => raw });
    const decision = await review(searchId, listingId, targets, false, true, signal());
    assert.equal(decision.decision, "SKIP");
    assert.match(decision.reason, /One photo-checked Lightly Played copy sold for \$75\.00/);
    assert.equal(decision.evaluation?.listing.termsCheckedAt, lastChecked);
    assert.equal(decision.evaluation?.rawPricing?.prices?.[0].comps?.count, 1);
});

test("every unsorted retained copy with missing sold screening can receive a bounded assessment; three matching sales can support a buy", async () => {
    const f = fixture(15);
    f.row.screen = { status: "UNSCREENED", reason: "No matched sale yet", card: null, bestCase: null, assumed: null,
        soldEvidence: { status: "UNAVAILABLE", exactScope: false, references: [], note: "" } };
    assert.equal(buyerReviewBlock(f.row, now), null);
    let count = 0;
    const review = harness(f, { snapshot: async () => null, evaluate: async (id, options) => {
        count++; assert.equal(getAiUsageContext().searchId, searchId); assert.equal(id, listingId);
        assert.equal(options?.automatic, true); assert.equal(options?.priceOnly, false);
        return f.e;
    } });
    const [one, two] = await Promise.all([1, 2].map(() => review(searchId, listingId, targets, true, true, signal())));
    assert.equal(count, 1); assert.deepEqual(one, two);
    assert.equal(one.decision, "BUY", one.reason); assert.equal(one.evidence, "photos");
    assert.match(one.reason, /3 observed matching Lightly Played raw sales in the last 60 days/);
});

test("unsupported stale prices use price-only research under the assessment's original allowance; a replay coalesces unresolved evidence", async () => {
    const f = fixture(), saved = { ...f.snapshot, searchId: otherSearch };
    f.e.rawPricing = { status: "PRICE_UNAVAILABLE", reason: "No sales at the assessed condition." };
    f.e.pricesCheckedAt = new Date(now - 8 * 3600000).toISOString();
    let count = 0;
    const review = harness(f, { snapshot: async () => saved, evaluate: async (_id, options) => {
        assert.equal(options?.priceOnly, true);
        assert.equal(options?.verifySoldCondition, true);
        assert.equal(getAiUsageContext().searchId, otherSearch); count++; return f.e;
    } });
    const first = await review(searchId, listingId, targets, false, true, signal());
    const repeated = await review(searchId, listingId, targets, false, true, signal());
    assert.equal(first.decision, "WAIT"); assert.equal(repeated.decision, "WAIT"); assert.equal(count, 1);
});

test("a new photo assessment with missing sales automatically leads to a separate price-only check in the same buyer decision", async () => {
    const f = fixture(15), photos = structuredClone(f.e);
    photos.rawPricing = null; delete photos.pricesCheckedAt;
    let snapshot: typeof f.snapshot | null = null;
    const calls: string[] = [];
    const review = harness(f, { snapshot: async () => snapshot, evaluate: async (_id, options) => {
        calls.push(options?.priceOnly ? "prices" : "photos");
        const evaluation = options?.priceOnly ? f.e : photos;
        snapshot = { ...f.snapshot, evaluation };
        return evaluation;
    } });
    const first = await review(searchId, listingId, targets, true, true, signal());
    assert.equal(first.decision, "BUY", first.reason); assert.equal(first.evidence, "prices");
    assert.deepEqual(calls, ["photos", "prices"]);
    assert.equal((await review(searchId, listingId, targets, true, true, signal())).decision, "BUY");
    assert.equal(calls.length, 2);
});

test("an unavailable sale source yields a concrete Wait and suppresses a second request during the provider cooldown", async () => {
    const f = fixture(); f.e.rawPricing = null; delete f.e.pricesCheckedAt;
    let count = 0;
    const review = harness(f, { evaluate: async () => { count++; throw new ProviderError("The matched-sales service timed out.", { retryAfterMs: 10000 }); } });
    for (let i = 0; i < 2; i++) {
        const result = await review(searchId, listingId, targets, true, true, signal());
        assert.equal(result.decision, "WAIT"); assert.equal(result.unavailable, true); assert.match(result.reason, /matched-sales service timed out/);
        assert.deepEqual(result.failure, { code: "PROVIDER_TEMPORARY", retryable: true });
        assert.equal(result.retryAt, now + 10000, "the cached receipt returns the same absolute provider cooldown");
    }
    assert.equal(count, 1);
});

function neutralRetryFixture() {
    const f = fixture(15);
    f.e.identity!.name = "Alakazam";
    f.e.identity!.cardNumber = "1/102";
    f.e.listing.title = f.row.title = "Alakazam Base Set 1/102 Unlimited Holo";
    f.inventory.intent.cardName = "Alakazam";
    f.inventory.intent.titleWords = ["alakazam"];
    for (const row of f.e.rawPricing!.prices!) for (const sale of row.comps!.sales) sale.title = f.row.title;
    return f;
}

test("temporary buyer-review retry resumes saved Alakazam evidence only after its cooldown under the original account", async () => {
    const f = neutralRetryFixture(), completed = structuredClone(f.e);
    f.e.rawPricing = null; delete f.e.pricesCheckedAt;
    let clock = now, calls = 0;
    const review = harness(f, { now: () => clock, restoreRaw: async () => null, restoreSales: async () => {}, evaluate: async (_id, options) => {
        calls++;
        assert.equal(getAiUsageContext().searchId, searchId);
        assert.equal(options.priceOnly, true);
        if (calls === 1) throw new ProviderError("Sold provider temporarily offline", { retryAfterMs: 10000 });
        return completed;
    } });
    const first = await review(searchId, listingId, targets, false, true, signal());
    assert.equal(first.retryAt, now + 10000);
    clock += 9999;
    const held = await review(searchId, listingId, targets, false, true, signal());
    assert.equal(held.retryAt, first.retryAt); assert.equal(calls, 1);
    clock++;
    const recovered = await review(searchId, listingId, targets, false, true, signal());
    assert.equal(calls, 2); assert.equal(recovered.decision, "BUY", recovered.reason);
    assert.equal(recovered.failure, undefined); assert.equal(recovered.retryAt, undefined);
});

test("Alakazam budget and unresolved-charge holds never advertise an automatic retry or re-open an unchanged receipt", async () => {
    for (const code of ["AI_BUDGET", "AI_EVIDENCE_HELD"] as const) {
        const f = neutralRetryFixture(); f.e.rawPricing = null; delete f.e.pricesCheckedAt;
        let calls = 0, clock = now;
        const review = harness(f, { now: () => clock, restoreRaw: async () => null, evaluate: async () => {
            calls++; throw new AiSpendingError(code, "The original account cannot authorize this work.");
        } });
        const held = await review(searchId, listingId, targets, false, true, signal());
        assert.deepEqual(held.failure, { code, retryable: false });
        assert.equal(held.retryAt, undefined); assert.equal(held.unavailable, true);
        clock += 60_000;
        const replayed = await review(searchId, listingId, targets, false, true, signal());
        assert.deepEqual(replayed.failure, held.failure); assert.equal(replayed.retryAt, undefined); assert.equal(calls, 1);
    }
});

test("historical ledger-write receipts and current search-wide AI authority failures do not poison a later manual retry", async () => {
    for (const code of ["AI_ACCOUNTING", "AI_INPUT_PREFLIGHT"] as const) {
        const f = neutralRetryFixture(), completed = structuredClone(f.e);
        f.e.rawPricing = null; delete f.e.pricesCheckedAt;
        const legacy = { listingId, decision: "WAIT", evidence: "listing", unavailable: true, failure: { code: "AI_BUDGET", retryable: false },
            reason: "Paid AI could not durably update its spending ledger. No new work is authorized. Cached results and screened candidates remain available." };
        let attempts = 0, saves = 0;
        const review = harness(f, {
            restoreRaw: async () => null, restoreSales: async () => {},
            cached: async <T>() => legacy as T,
            save: async () => { saves++; },
            evaluate: async (_id, options) => {
                assert.equal(getAiUsageContext().searchId, searchId);
                assert.equal(options.priceOnly, true, "verify missing prices using the accepted photos");
                if (++attempts === 1) throw new AiSpendingError(code, "The authority for this check is unavailable.", { scope: "search" });
                return completed;
            },
        });
        const stopped = await review(searchId, listingId, targets, false, true, signal());
        assert.deepEqual(stopped.failure, { code, retryable: false, scope: "search" });
        assert.equal(stopped.retryAt, undefined);
        assert.equal(saves, 0, "a search-wide denial is never a per-copy receipt");
        const recovered = await review(searchId, listingId, targets, false, true, signal());
        assert.equal(recovered.decision, "BUY", recovered.reason);
        assert.equal(attempts, 2);
        assert.ok(saves > 0, "the resumed review still writes accepted evidence");
    }
});

test("an explicitly repaired Alakazam pause can be rechecked without advertising an automatic retry", async () => {
    const f = neutralRetryFixture(), completed = structuredClone(f.e);
    f.e.rawPricing = null; delete f.e.pricesCheckedAt;
    let calls = 0, clock = now;
    const review = harness(f, { now: () => clock, restoreRaw: async () => null, restoreSales: async () => {}, evaluate: async () => {
        assert.equal(getAiUsageContext().searchId, searchId);
        if (++calls === 1) throw new AiSpendingError("AI_PAUSED", "Research is explicitly paused.");
        return completed;
    } });
    const held = await review(searchId, listingId, targets, false, true, signal());
    assert.deepEqual(held.failure, { code: "AI_PAUSED", retryable: false }); assert.equal(held.retryAt, undefined);
    clock += 30000;
    const resumed = await review(searchId, listingId, targets, false, true, signal());
    assert.equal(resumed.decision, "BUY", resumed.reason); assert.equal(calls, 2);
});

test("a historical request ceiling stops its current assessment but explicit retry can reprice without new photos", async () => {
    const f = fixture(30); f.e.rawPricing = null;
    const priced = fixture(30).e;
    f.e.pricingDeferred = { provider: "PKMNPRICES", note: "The original price-research allowance is exhausted." };
    let snapshot: typeof f.snapshot | null = null, calls = 0;
    const review = harness(f, { snapshot: async () => snapshot, evaluate: async (_id, options) => {
        assert.equal(options?.priceOnly, calls > 0); calls++;
        const evaluation = calls === 1 ? f.e : priced;
        snapshot = { ...f.snapshot, evaluation }; return evaluation;
    } });
    const stopped = await review(searchId, listingId, targets, true, true, signal());
    assert.equal(stopped.decision, "WAIT"); assert.equal(stopped.unavailable, true); assert.match(stopped.reason, /allowance is exhausted/);
    assert.deepEqual(stopped.failure, { code: "PRICE_RESEARCH_BUDGET", retryable: false, scope: "search" });
    assert.equal(stopped.retryAt, undefined); assert.equal(calls, 1);
    const resumed = await review(searchId, listingId, targets, true, true, signal());
    assert.equal(resumed.decision, "BUY", resumed.reason);
    assert.equal(calls, 2, "the second explicit check refreshes prices, never repeats the photo assessment");
});

test("an Unlimited seller claim and assessed wear explain why a buyer should wait when no matched raw resale is established", async () => {
    const f = fixture(66.19);
    f.e.listing.title = f.row.title = "Dark Alakazam Team Rocket Unlimited";
    f.e.listing.aspects = { Features: "Unlimited" };
    Object.assign(f.e.identity!, { status: "NEEDS_REVIEW", set: "Team Rocket", printing: "UNKNOWN", cardNumber: "1/82", reasons: ["The photos don't clearly show which printing this is."] });
    f.e.rawPricing = null;
    const result = await harness(f)(searchId, listingId, targets, true, false, signal());
    assert.equal(result.decision, "WAIT"); assert.match(result.reason, /\$71.65/);
    assert.equal(result.waitReason, "IDENTITY_UNRESOLVED");
    assert.match(result.reason, /seller lists Unlimited/); assert.match(result.reason, /Lightly Played/);
    assert.match(result.reason, /resale value after fees/); assert.doesNotMatch(result.reason, /don't clearly show|first edition/i);
});

test("reviews respect retained identity, paused research, changed galleries, and auctions outside their research window", async () => {
    const f = fixture();
    await assert.rejects(harness(f)(searchId, "different", targets, true, true, signal()), /does not belong/);
    const paused = await harness(f, { snapshot: async () => null })(searchId, listingId, targets, true, false, signal());
    assert.equal(paused.decision, "WAIT"); assert.equal(paused.evaluation, null);
    const changed: Evaluation = structuredClone(f.e); changed.listing.photos = ["other card"];
    const moved = await harness(f, { snapshot: async () => null, evaluate: async () => changed })(searchId, listingId, targets, true, true, signal());
    assert.equal(moved.decision, "WAIT"); assert.equal(moved.evaluation, null); assert.match(moved.reason, /gallery changed/);
    f.row.buyingOption = "AUCTION"; f.row.endTime = new Date(now + 23 * 3600000).toISOString();
    const auction = await harness(f, { snapshot: async () => null })(searchId, listingId, targets, true, true, signal());
    assert.equal(auction.decision, "WAIT"); assert.match(auction.reason, /10 hours/);
});

test("the app owns repairable photo work and preserves a specific provider stop as a Wait", async () => {
    const f = fixture(30);
    f.e.condition!.authenticity.concern = "POSSIBLE";
    f.e.photoReviewKey = "same-photo-set";
    let deeper = 0;
    const result = await harness(f, { deeper: async (id, key, active) => {
        deeper++; assert.equal(id, listingId); assert.equal(key, f.e.photoReviewKey);
        assert.ok(active); return { inputKey: key, reviewedAt: stamp, summary: "Print detail warrants caution.", photoNumbers: [1], requestedPhotos: [],
            findings: [{ area: "IDENTITY", impact: "NEW_CONCERN", observation: "The front print pattern is inconsistent.", photoNumbers: [1] }],
            usage: { inputTokens: 1, outputTokens: 1 } };
    } })(searchId, listingId, targets, true, true, signal());
    assert.equal(deeper, 1); assert.equal(result.decision, "WAIT");
    assert.match(result.reason, /front print pattern/);
    const stopped = await harness(f, { snapshot: async () => null, evaluate: async () => { throw new AiSpendingError("AI_BUDGET", "The original search has used its AI allowance."); } })(searchId, listingId, targets, true, true, signal());
    assert.equal(stopped.decision, "WAIT"); assert.match(stopped.reason, /AI allowance/);
});

test("a paper profit without photos or a shipping quote cannot become a Buy", async () => {
    const f = fixture(15);
    f.e.photoCheck = null; f.e.listing.photosAnalyzed = 0;
    const paused = await harness(f)(searchId, listingId, targets, true, false, signal());
    assert.equal(paused.decision, "WAIT"); assert.match(paused.reason, /0 of 4 listing photos/);
    assert.equal(paused.waitReason, "PHOTO_EVIDENCE_INCONSISTENT");
    const g = fixture(15); g.e.listing.shipping = null; g.row.shipping = null;
    const shipping = await harness(g)(searchId, listingId, targets, true, false, signal());
    assert.equal(shipping.decision, "WAIT"); assert.match(shipping.reason, /\$15.00 before shipping and tax/); assert.match(shipping.reason, /no shipping quote/);
    assert.equal(shipping.waitReason, "SHIPPING_UNCONFIRMED");
});

test("materially changed seller disclosures cannot inherit an old buy, even with the same gallery", async () => {
    const f = fixture(15);
    f.row.termsCheckedAt = new Date(now - 1000).toISOString();
    f.e.listing.termsCheckedAt = new Date(now - 60000).toISOString();
    f.row.conditionNotes = ["Heavy crease near the top edge."];
    const result = await harness(f)(searchId, listingId, targets, true, false, signal());
    assert.equal(result.decision, "WAIT"); assert.equal(result.evaluation, null);
    delete f.row.conditionNotes;
    f.row.cardCondition = "Damaged";
    const wearChanged = await harness(f)(searchId, listingId, targets, true, false, signal());
    assert.equal(wearChanged.decision, "WAIT"); assert.equal(wearChanged.evaluation, null);
});

test("the automatic buyer review accepts an inspectable auction in the 10-hour window even if originally outside it", async () => {
    const f = fixture(15);
    f.row.buyingOption = f.e.listing.buyingOption = "AUCTION";
    f.row.endTime = f.e.listing.endTime = new Date(now + 2 * 3600000).toISOString();
    let runs = 0;
    const review = harness(f, { inventory: async () => ({ ...f.inventory, rows: [{ listing: f.row, assessable: false, block: "OUTSIDE_AUCTION_WINDOW" }] }),
        snapshot: async () => null, evaluate: async () => { runs++; return f.e; } });
    const result = await review(searchId, listingId, targets, true, true, signal());
    assert.equal(runs, 1); assert.equal(result.decision, "WAIT"); assert.match(result.reason, /bid ceiling/);
});

test("a realistic Best Offer remains conditional and is priced against matching sales at both the opening and supported ceiling", async () => {
    const f = fixture();
    const walkAway = retargetEvaluation(f.e, targets).underwriting!.best!.maxBid;
    f.e.listing.price = f.row.currentPrice = Math.ceil(walkAway * 1.08);
    f.e.listing.bestOffer = f.row.bestOffer = true;
    const review = harness(f);
    const answer = await review(searchId, listingId, targets, true, true, signal());
    assert.equal(answer.decision, "WAIT", answer.reason);
    assert.ok(answer.offer, answer.reason);
    assert.doesNotMatch(answer.reason, /offer|highest supported/i, "controls use only the separately verified offer amounts");
    assert.ok(answer.offer.opening < f.row.currentPrice && answer.offer.opening <= answer.offer.maxItemPrice && answer.offer.maxItemPrice <= walkAway);
    assert.equal(answer.evaluation?.listing.price, f.row.currentPrice, "the actual asking price remains on the card");
    assert.equal(answer.offer.verifiedPurchase.itemPrice, answer.offer.opening);
    assert.equal(answer.offer.verifiedPurchase.maxItemPrice, answer.offer.maxItemPrice);
    for (const price of [answer.offer.opening, answer.offer.maxItemPrice]) {
        const profitable = retargetEvaluation({ ...f.e, listing: { ...f.e.listing, price } }, targets);
        assert.ok(profitable.underwriting!.best!.profit > 0);
    }
    assert.equal((await review(searchId, listingId, targets, false, true, signal())).offer, undefined);
    f.e.rawPricing!.prices![0].comps!.sales.pop();
    assert.ok((await review(searchId, listingId, targets, true, true, signal())).offer, "a supported estimate is not vetoed by a two-sale activity count");
    f.e.listing.termsCheckedAt = new Date(now - 180000).toISOString();
    assert.equal((await review(searchId, listingId, targets, true, false, signal())).offer, undefined);
});

test("a verified grading offer carries its own route when the asking-price model selected raw resale", async () => {
    const f = fixture(42);
    const offerTargets = { minProfit: 0, minRoi: 0.30 };
    f.row.bestOffer = f.e.listing.bestOffer = true;
    // A retained raw estimate can participate in the model without an
    // observed completed transaction sufficient to verify the offer.
    f.e.rawPricing!.prices![0].comps!.sales.forEach(sale => { delete sale.saleType; });
    const byGrade = [6, 7, 8].map(grade => {
        const summary = salesSummary("CGC", grade, [126, 126, 126]);
        summary.sales.forEach((sale, i) => Object.assign(sale, { saleType: "fixed_price",
            title: `Venusaur Base Set 15/102 Holo Unlimited CGC ${grade}`, url: `https://www.ebay.com/itm/${120000010000 + 10 * grade + i}` }));
        return summary;
    });
    f.e.gradedPricing = { CGC: { status: "PRICED", printing: "UNLIMITED", source: "pkmnprices", variant: "holo", byGrade } };
    const answer = await harness(f, { restoreSales: async () => {} })(searchId, listingId, offerTargets, true, false, signal());
    assert.equal(answer.decision, "WAIT");
    assert.equal(answer.evaluation?.underwriting?.best?.path, "RAW");
    assert.equal(answer.offer?.opening, 36);
    assert.equal(answer.offer?.maxItemPrice, 38.08);
    assert.equal(answer.offer?.verifiedPurchase.path.path, "GRADE");
    assert.equal(answer.offer?.verifiedPurchase.path.grader, "CGC");
    assert.equal(answer.offer?.verifiedPurchase.path.profit, 25.12);
});

test("a newly listed raw copy earns a grading alert through the normal buyer review using existing paid evidence", async () => {
    const f = fixture(55);
    const { e } = f;
    e.listing.listedAt = new Date(now - 15 * 60_000).toISOString();
    const byGrade = [6, 7, 8].map(grade => {
        const summary = salesSummary("PSA", grade, [grade * 42, grade * 42, grade * 42]);
        for (const [n, sale] of summary.sales.entries()) Object.assign(sale, {
            saleType: "fixed_price", title: `Venusaur Base Set 15/102 Holo Unlimited PSA ${grade}`,
            url: `https://www.ebay.com/itm/${120000010000 + 10 * grade + n}`,
        });
        return summary;
    });
    byGrade[1].sales[2].soldAt = new Date(now - 45 * 86_400_000).toISOString();
    e.gradedPricing = { PSA: { status: "PRICED", printing: "UNLIMITED", source: "pkmnprices", variant: "holo", byGrade } };
    e.rawPricing = null;
    const read = () => harness(f, { restoreSales: async () => {} })(searchId, listingId, targets, false, false, signal());
    const buy = await read();
    assert.equal(buy.decision, "BUY");
    const found = buy.gradingOpportunity;
    assert.ok(found);
    assert.equal(found.delivered, 59.54);
    assert.equal(found.likely.grade, 7);
    assert.equal(found.lower.grade, 6);
    assert.equal(found.likely.sales30, 2);
    assert.equal(found.likely.sales60, 3);
    assert.equal(found.lower.sales30, 3);
    assert.ok(found.gradingCosts > 0 && found.lower.profit > 0 && found.likely.profit > found.lower.profit);
    assert.match(buy.reason, /3 matching sales in the last 60 days\. One grade lower/);
    byGrade[1].sales[1].url = byGrade[1].sales[0].url;
    const sparse = (await read()).gradingOpportunity;
    assert.ok(sparse, "sparse activity does not veto supported grading profit");
    assert.equal(sparse.likely.sales60, 1, "a conflicting duplicate is excluded from the actual activity count");
    byGrade[1].sales[1].url = "https://www.ebay.com/itm/120000010071";
    byGrade[0].median = 15;
    assert.equal((await read()).gradingOpportunity, undefined, "a losing downside cannot raise a grading alert");
    byGrade[0].median = 252;
    e.listing.listedAt = new Date(now - 25 * 3600_000).toISOString();
    e.listing.createdAt = stamp;
    assert.equal((await read()).gradingOpportunity, undefined, "a refreshed creation date cannot override first availability");
    e.listing.listedAt = stamp;
    e.gradedPricing.PSA!.printing = "FIRST_EDITION";
    assert.equal((await read()).gradingOpportunity, undefined, "first edition comps cannot price an Unlimited copy");
});

test("saved-only buyer review recovers market references and reports the seller-described raw sale range and all-in limit", async () => {
    const f = fixture(150), e = f.e;
    e.photoCheck!.cardMatch = { verdict: "MATCH", problems: [] };
    e.identity!.recordId = 10;
    const seller = salesSummary("RAW", "LIGHTLY_PLAYED", [48, 55, 69]);
    seller.sales.forEach(s => Object.assign(s, { saleType: "fixed_price", sellerCondition: "LIGHTLY_PLAYED" }));
    e.rawPricing = { status: "PRICE_UNAVAILABLE", source: "pkmnprices", printing: "UNLIMITED", finish: "HOLO", variant: "Holofoil",
        conditionEvidence: "AI_PHOTOS", sellerConditionComps: seller, prices: [] };
    let reads = 0;
    const review = harness(f, { supplement: async (_e, options) => {
        reads++; assert.equal(options.cacheOnly, true);
        return { trackerRawReference: { source: "TCGPLAYER_MARKET", tcgPlayerId: 20, recordId: "10", updatedAt: stamp,
            printing: "UNLIMITED", finish: "HOLO", condition: "NEAR_MINT", priceUsd: 82 } };
    }, evaluate: async () => assert.fail("The saved-only reviewer attempted fresh research.") });
    const result = await review(searchId, listingId, targets, false, false, signal());
    assert.equal(reads, 1); assert.equal(result.decision, "WAIT");
    assert.match(result.reason, /PKMNPrices.*3 seller-described Lightly Played sales at \$48.00–\$69.00.*all-in/);
    assert.equal(result.evaluation?.trackerRawReference?.priceUsd, 82);
});

test("a blocked terms refresh keeps verified raw sale facts on the first response and on cooldown replay", async () => {
    const f = fixture(10), e = f.e;
    e.photoCheck!.cardMatch = { verdict: "MATCH", problems: [] };
    e.listing.termsCheckedAt = new Date(now - 3600000).toISOString();
    e.rawPricing!.finish = "HOLO";
    let attempts = 0;
    const review = harness(f, { evaluate: async (_id, opts) => {
        assert.equal(opts.priceOnly, false); attempts++;
        throw new ProviderError("The eBay Browse allowance is exhausted.");
    } });
    for (let i = 0; i < 2; i++) {
        const held = await review(searchId, listingId, targets, true, true, signal());
        assert.equal(held.decision, "WAIT"); assert.equal(held.unavailable, true); assert.equal(held.offer, undefined);
        assert.match(held.reason, /Last checked purchase total.*3 photo-checked Lightly Played sales at \$70.00–\$80.00.*Browse allowance/);
        assert.equal(held.reason.match(/Last checked/g)?.length, 1);
    }
    assert.equal(attempts, 1);
});

test("a blocked price refresh keeps recent seller-described sales distinct from exact photo evidence and honors the buyer's targets", async () => {
    const f = fixture(100), e = f.e;
    e.photoCheck!.cardMatch = { verdict: "MATCH", problems: [] };
    e.pricesCheckedAt = new Date(now - 8 * 3600000).toISOString();
    const seller = salesSummary("RAW", "LIGHTLY_PLAYED", [50, 55, 60]);
    seller.sales.forEach(s => Object.assign(s, { saleType: "fixed_price", sellerCondition: "LIGHTLY_PLAYED" }));
    e.rawPricing = { status: "PRICE_UNAVAILABLE", source: "pkmnprices", printing: "UNLIMITED", finish: "HOLO", variant: "Holofoil",
        conditionEvidence: "AI_PHOTOS", sellerConditionComps: seller, prices: [] };
    let attempts = 0;
    const review = harness(f, { restoreRaw: async () => null, evaluate: async (_id, opts) => {
        assert.equal(opts.priceOnly, true); attempts++;
        throw new ProviderError("The eBay Browse allowance is exhausted.");
    } });
    for (const [goals, ceiling] of [[targets, "$40.51"], [{ minProfit: 10, minRoi: 0 }, "$30.52"]] as const) {
        const held = await review(searchId, listingId, goals, true, true, signal());
        assert.equal(held.decision, "WAIT"); assert.equal(held.evidence, "saved"); assert.equal(held.unavailable, true);
        assert.match(held.reason, /3 seller-described Lightly Played sales at \$50.00–\$60.00/);
        assert.ok(held.reason.includes(ceiling), held.reason);
        assert.doesNotMatch(held.reason, /photo-checked/);
    }
    assert.equal(attempts, 2);
    e.rawPricing.printing = "FIRST_EDITION";
    const mismatched = await review(searchId, listingId, targets, true, true, signal());
    assert.equal(mismatched.reason, "The eBay Browse allowance is exhausted.");
});

test("the buyer reviewer returns a single auction opportunity with matched raw sales and a bid ceiling", async () => {
    const f = fixture(15), endTime = new Date(now + 55 * 60_000).toISOString();
    Object.assign(f.e.listing, { buyingOption: "AUCTION", bids: 1, endTime,
        auctionQuote: { currentBid: 15, minimumBid: 16, checkedAt: stamp } });
    Object.assign(f.row, { buyingOption: "AUCTION", bids: 1, endTime });
    const result = await harness(f)(searchId, listingId, targets, false, false, signal());
    const opportunity = result.auctionOpportunity;
    assert.equal(opportunity?.status, "BID", result.reason);
    assert.equal(opportunity.marketValue, 75);
    assert.equal(opportunity.nextTotal, 17.32);
    assert.equal(opportunity.sales30, 3);
    assert.match(result.reason, /Bid up to/);
    assert.notEqual(result.decision, "BUY");

    const withBudget = (maxPrice: number) => harness(f, { inventory: async () => ({ ...f.inventory, filters: { maxPrice } }) })
        (searchId, listingId, targets, false, false, signal());
    const exactBudget = await withBudget(17.32);
    assert.equal(exactBudget.auctionOpportunity?.status, "BID");
    assert.equal(exactBudget.auctionOpportunity?.maxBid, 16);
    const exceeded = await withBudget(17.31);
    assert.equal(exceeded.auctionOpportunity?.status, "PASS");
    assert.equal(exceeded.decision, "SKIP");
    assert.equal(exceeded.auctionOpportunity.maxBid, 15.99);
});
