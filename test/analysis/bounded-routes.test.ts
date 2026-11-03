import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createBoundedEvaluator, boundedAssessmentKey, boundedAssessmentPlan, selectBoundedPhotos,
    BOUNDED_ASSESSMENT_VERSION, BOUNDED_SLAB_ASSESSMENT_VERSION, type BoundedReading } from "../../server/analysis/bounded-evaluate.ts";
import { ANALYSIS_VERSION } from "../../server/analysis/legacy-evidence.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import { photoFingerprint } from "../../server/analysis/store.ts";
import { currentPriceEvidence } from "../../shared/pricing-freshness.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import type { ListingDetails } from "../../server/ebay/listings.ts";
import type { CardRecord } from "../../server/pricing/types.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const photo = (index: number, size = 1600) => `https://i.ebayimg.com/images/g/route-${index}/s-l${size}.jpg`;
const listing = (extra: Partial<ListingDetails> = {}): ListingDetails => ({ id: "v1|bounded-route|0", title: "Venusaur Base Set 15/102 Holo English CGC 8.5", url: "https://www.ebay.com/itm/123456789012",
    price: 50, shipping: 5, buyingOption: "FIXED_PRICE", bids: 0, endTime: null, seller: null,
    images: Array.from({ length: 12 }, (_, index) => photo(index + 1)), availability: "ACTIVE", condition: "Graded", cardCondition: null, conditionNotes: [],
    aspects: { "Card Name": "Venusaur", Set: "Base Set", "Card Number": "15/102", Language: "English", Finish: "Holo", "Professional Grader": "CGC", Grade: "8.5" }, ...extra });
const card: CardRecord = { source: "pkmnprices", id: 123, name: "Venusaur", setName: "Base Set", cardNumber: "15/102", tcgPlayerId: 3,
    variants: [{ name: "Holofoil", finish: "HOLO", printing: "UNLIMITED", prices: [{ condition: "LIGHTLY_PLAYED", price: 150, updatedAt: new Date(NOW).toISOString() }] }] };
function slabReading(count: number, grade = "8.5"): BoundedReading {
    return { photoCheck: { cardCount: "ONE", holder: "GRADED_SLAB", photoSufficiency: "SUFFICIENT", confidence: "HIGH", printedName: "Venusaur", printedNumber: "15/102",
        cardIdentity: { name: "Venusaur", set: "Base Set", cardNumber: "15/102", language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Readable label and collector number."] },
        images: Array.from({ length: count }, (_, index) => ({ number: index + 1, view: index === 0 ? "FRONT" : "BACK", usable: true, isStockImage: false, issues: [], obscuresCondition: false })),
        printingMarks: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT", reprintMark: "NONE_SEEN", evidence: ["Artwork shadow visible; no edition stamp."] },
        cardMatch: { verdict: "MATCH", problems: [] }, missingViews: [], problems: [],
        slab: { present: true, grader: "CGC", grade, gradeQualifier: null, certNumber: "12345678", labelText: `1999 POKEMON VENUSAUR BASE SET HOLO #15 CGC ${grade}`, caseCondition: "INTACT", authenticity: "NONE_SEEN", authenticityEvidence: [], concerns: [] } }, condition: null };
}
function rawReading(count: number): BoundedReading {
    const report = slabReading(count);
    report.photoCheck.holder = "NONE"; report.photoCheck.slab = null;
    const condition = structuredClone(cardEvaluation().condition!);
    condition.authenticity = { concern: "NONE_SEEN", reasons: [], limitations: [], observations: [] };
    report.condition = condition;
    return report;
}
function harness(subject = listing(), overrides: Parameters<typeof createBoundedEvaluator>[0] = {}) {
    const cache = new Map<string, any>();
    const calls = { assessed: [] as { mode: unknown; photos: { number: number; url: string }[] }[], lookup: 0,
        comps: [] as { grader: string; grade: number | string; variant?: string }[], raw: 0 };
    const evaluate = createBoundedEvaluator({ now: () => NOW,
        details: async id => ({ ...structuredClone(subject), id }), saved: async () => null,
        cached: async key => cache.get(key) ?? null, save: async (key, value) => { cache.set(key, structuredClone(value)); },
        assess: async (_listing, photos, _signal, mode) => { calls.assessed.push({ mode, photos: structuredClone(photos) }); return { result: slabReading(photos.length), usage: { inputTokens: 500, outputTokens: 300 } }; },
        lookup: async () => { calls.lookup++; return [structuredClone(card)]; },
        fetchComps: async (_id, options) => { calls.comps.push(options); return [90, 100, 110].map((price, index) => ({ id: `${options.grader}-${options.grade}-${index}`, title: `Venusaur Base Set 15/102 Holo ${options.grader} ${options.grade}`, price,
            sold_at: new Date(NOW - (index + 1) * 86_400_000).toISOString(), variant: "Holofoil", currency: "USD", attribution: "exact", sale_type: "fixed_price", listing_url: null,
            grader: options.grader, grade: String(options.grade), grade_qualifier: null })); },
        fetchRawComps: async () => { calls.raw++; return []; }, compChecks: async () => new Map(), ...overrides });
    return { cache, calls, evaluate };
}
const saved = (reading: BoundedReading, version: string, answeredAt = NOW - 1000) => ({ ...reading, version, answeredAt: new Date(answeredAt).toISOString(), usage: { inputTokens: 500, outputTokens: 300 } });

test("routing changes the cold-work plan while the combined cache key remains independently reusable", () => {
    const subject = listing();
    const compact = boundedAssessmentPlan(subject);
    assert.equal(compact.mode, "SLAB_LABEL"); assert.equal(compact.version, BOUNDED_SLAB_ASSESSMENT_VERSION); assert.equal(compact.photos.length, 2);
    assert.notEqual(compact.key, boundedAssessmentKey(subject));
    const raw = boundedAssessmentPlan(listing({ condition: "Ungraded", title: "Venusaur Base Set 15/102 Holo English", aspects: { ...subject.aspects, "Professional Grader": "", Grade: "" } }));
    assert.equal(raw.mode, "RAW"); assert.equal(raw.version, BOUNDED_ASSESSMENT_VERSION); assert.equal(raw.photos.length, 6);
    const fromLabel = boundedAssessmentPlan({ ...subject, condition: "Used" });
    assert.equal(fromLabel.mode, "SLAB_LABEL", "an unambiguous listed grader and grade can route compact work without proving it is a slab");
});

test("a cold slab uses one compact request and exact certified-grade pricing only", async () => {
    const { evaluate, calls, cache } = harness();
    const result = await evaluate(listing().id);
    assert.equal(calls.assessed.length, 1); assert.equal(calls.assessed[0].mode, "SLAB_LABEL"); assert.equal(calls.assessed[0].photos.length, 2);
    assert.equal(result.assessmentVersion, BOUNDED_SLAB_ASSESSMENT_VERSION); assert.equal(result.listing.photosAnalyzed, 2);
    assert.equal(result.condition, null); assert.equal(result.gradedPricing, null); assert.equal(result.rawPricing, null);
    assert.equal(calls.raw, 0); assert.deepEqual(calls.comps.map(({ grader, grade }) => [grader, String(grade)]), [["CGC", "8.5"]]);
    assert.equal(result.slab?.status, "OK"); assert.equal(currentPriceEvidence(result, NOW), true);
    assert.ok(cache.has(boundedAssessmentPlan(listing()).key)); assert.equal(cache.has(boundedAssessmentKey(listing())), false);
});

test("compact photo mapping preserves original indices after duplicate thumbnail sizes", async () => {
    const subject = listing({ images: [photo(1), photo(1, 500), photo(2), photo(3)] });
    const { evaluate, cache, calls } = harness(subject);
    const result = await evaluate(subject.id);
    assert.deepEqual(calls.assessed[0].photos.map(item => item.number), [1, 3]);
    assert.deepEqual(result.photoCheck?.images.map(item => item.number), [1, 3]);
    const stored = cache.get(boundedAssessmentPlan(subject).key);
    assert.deepEqual(stored.photoCheck.images.map((item: { number: number }) => item.number), [1, 2]);
});

test("old combined slab evidence keeps its six-photo mapping and causes no compact replacement purchase", async () => {
    const subject = listing({ images: [photo(1), photo(1, 500), ...Array.from({ length: 12 }, (_, index) => photo(index + 2))] });
    const oldPhotos = selectBoundedPhotos(subject.images);
    const { evaluate, cache, calls } = harness(subject);
    const old = saved(slabReading(oldPhotos.length), BOUNDED_ASSESSMENT_VERSION);
    cache.set(boundedAssessmentKey(subject), structuredClone(old));
    const result = await evaluate(subject.id);
    assert.equal(calls.assessed.length, 0); assert.equal(result.assessmentVersion, BOUNDED_ASSESSMENT_VERSION);
    assert.equal(result.listing.photosAnalyzed, oldPhotos.length);
    assert.deepEqual(result.photoCheck?.images.map(image => image.number), oldPhotos.map(photo => photo.number));
    assert.deepEqual(cache.get(boundedAssessmentKey(subject)), old, "reusing a six-photo answer must not rewrite its original local numbering");
    assert.equal(cache.has(boundedAssessmentPlan(subject).key), false);
});

test("a fresh compact private result reuses both its photos and exact sold-price research", async () => {
    const { evaluate, calls } = harness();
    const first = await evaluate(listing().id);
    const count = { lookup: calls.lookup, comps: calls.comps.length };
    const second = await evaluate(listing().id, { current: { price: 70, shipping: 5, bids: 0, endTime: null } });
    assert.equal(calls.assessed.length, 1); assert.equal(calls.lookup, count.lookup); assert.equal(calls.comps.length, count.comps);
    assert.ok(second.reusedSteps.includes("savedEvaluation")); assert.equal(second.answeredAt, first.answeredAt); assert.equal(second.usage.length, 0);
    assert.equal(second.listing.price, 70);
});

test("a changed seller routing hint cannot repurchase a slab already verified by compact shared evidence", async () => {
    const subject = listing({ condition: "Ungraded" });
    const { evaluate, calls, cache } = harness(subject);
    const previousPlan = boundedAssessmentPlan(listing());
    const original = saved(slabReading(previousPlan.photos.length), previousPlan.version);
    cache.set(previousPlan.key, structuredClone(original));
    assert.equal(boundedAssessmentPlan(subject).mode, "RAW", "the seller's condition metadata changed without changing the photo/claim inputs");
    const result = await evaluate(subject.id);
    assert.equal(calls.assessed.length, 0); assert.equal(result.assessmentVersion, BOUNDED_SLAB_ASSESSMENT_VERSION);
    assert.equal(result.condition, null); assert.equal(result.listing.photosAnalyzed, 2);
    assert.equal(result.slab?.status, "OK"); assert.equal(calls.raw, 0); assert.equal(calls.comps.length, 1);
    assert.deepEqual(cache.get(previousPlan.key), original);
});

test("a cached compact raw finding cannot replace the full raw condition assessment requested later", async () => {
    const subject = listing({ condition: "Ungraded" });
    const { evaluate, calls, cache } = harness(subject, { assess: async (_listing, photos, _signal, mode) => {
        calls.assessed.push({ mode, photos }); return { result: rawReading(photos.length), usage: { inputTokens: 900, outputTokens: 700 } };
    } });
    const previousPlan = boundedAssessmentPlan(listing());
    const compact = rawReading(previousPlan.photos.length); compact.condition = null;
    const original = saved(compact, previousPlan.version);
    cache.set(previousPlan.key, structuredClone(original));
    const result = await evaluate(subject.id);
    assert.deepEqual(calls.assessed.map(call => [call.mode, call.photos.length]), [["RAW", 6]]);
    assert.equal(result.assessmentVersion, BOUNDED_ASSESSMENT_VERSION); assert.ok(result.condition);
    assert.equal(calls.raw, 1); assert.deepEqual(cache.get(previousPlan.key), original);
    await evaluate(subject.id); assert.equal(calls.assessed.length, 1);
});

test("a raw card inside a graded routing claim stops without a hidden paid raw-condition fallback", async () => {
    const { evaluate, calls } = harness(listing(), { assess: async (_listing, photos, _signal, mode) => {
        calls.assessed.push({ mode, photos }); const reading = rawReading(photos.length); reading.condition = null;
        return { result: reading, usage: { inputTokens: 500, outputTokens: 300 } };
    } });
    const result = await evaluate(listing().id);
    assert.deepEqual(calls.assessed.map(call => call.mode), ["SLAB_LABEL"]);
    assert.equal(result.condition, null); assert.equal(calls.raw, 0); assert.equal(calls.comps.length, 0);
    assert.ok(!result.underwriting?.verdict.startsWith("BUY"));
    await evaluate(listing().id);
    assert.equal(calls.assessed.length, 1, "reopening the compact mismatch must not silently purchase a raw replacement");
});

test("slab routing cannot accept an accidental numeric raw assessment as compact evidence", async () => {
    const { evaluate, calls, cache } = harness(listing(), { assess: async (_listing, photos, _signal, mode) => {
        calls.assessed.push({ mode, photos }); return { result: rawReading(photos.length), usage: { inputTokens: 500, outputTokens: 300 } };
    } });
    await assert.rejects(evaluate(listing().id), StorageUnavailableError);
    assert.equal(calls.assessed.length, 1); assert.equal(calls.raw, 0); assert.equal(calls.comps.length, 0);
    assert.equal(cache.has(boundedAssessmentKey(listing())), false);
});

test("newer compact evidence overrides old combined private prices without buying another answer", async () => {
    const { evaluate, calls, cache } = harness();
    cache.set(boundedAssessmentKey(listing()), saved(slabReading(6), BOUNDED_ASSESSMENT_VERSION, NOW - 2000));
    const first = await evaluate(listing().id);
    assert.equal(first.assessmentVersion, BOUNDED_ASSESSMENT_VERSION);
    const plan = boundedAssessmentPlan(listing());
    const correction = slabReading(plan.photos.length); correction.photoCheck.slab!.certNumber = "87654321";
    cache.set(plan.key, saved(correction, plan.version, NOW - 1000));
    const updated = await evaluate(listing().id);
    assert.equal(calls.assessed.length, 0); assert.equal(updated.assessmentVersion, BOUNDED_SLAB_ASSESSMENT_VERSION);
    assert.equal(updated.slab?.certNumber, "87654321"); assert.equal(updated.listing.photosAnalyzed, 2);
    assert.equal(updated.reusedSteps.includes("savedEvaluation"), false);
    assert.deepEqual(calls.comps.map(({ grade }) => String(grade)), ["8.5", "8.5"]);
});

test("newer combined correction overrides compact private prices using the combined photo mapping", async () => {
    const { evaluate, calls, cache } = harness();
    const plan = boundedAssessmentPlan(listing());
    cache.set(plan.key, saved(slabReading(plan.photos.length), plan.version, NOW - 2000));
    await evaluate(listing().id);
    const correction = slabReading(6); correction.photoCheck.slab!.certNumber = "87654321";
    cache.set(boundedAssessmentKey(listing()), saved(correction, BOUNDED_ASSESSMENT_VERSION, NOW - 1000));
    const updated = await evaluate(listing().id);
    assert.equal(calls.assessed.length, 0); assert.equal(updated.assessmentVersion, BOUNDED_ASSESSMENT_VERSION);
    assert.equal(updated.slab?.certNumber, "87654321"); assert.equal(updated.listing.photosAnalyzed, 6);
    assert.deepEqual(updated.photoCheck?.images.map(image => image.number), selectBoundedPhotos(listing().images).map(photo => photo.number));
});

test("corrupt compatible cache entries stop before replacement work even when the other route has valid older evidence", async () => {
    for (const brokenCompact of [false, true]) {
        const { evaluate, calls, cache } = harness();
        const plan = boundedAssessmentPlan(listing());
        cache.set(boundedAssessmentKey(listing()), saved(slabReading(6), BOUNDED_ASSESSMENT_VERSION, NOW - 2000));
        cache.set(plan.key, saved(slabReading(plan.photos.length), plan.version, NOW - 1000));
        const key = brokenCompact ? plan.key : boundedAssessmentKey(listing());
        cache.set(key, { ...cache.get(key), photoCheck: null });
        await assert.rejects(evaluate(listing().id), StorageUnavailableError);
        assert.equal(calls.assessed.length, 0); assert.equal(calls.lookup, 0); assert.equal(calls.comps.length, 0);
    }
});

test("strong full legacy slab evidence remains preferred over compact route caches", async () => {
    const subject = listing();
    const full = slabReading(subject.images.length);
    const { evaluate, cache, calls } = harness(subject, { saved: async id => ({ itemId: id, version: ANALYSIS_VERSION,
        photoFingerprint: photoFingerprint(subject.images), answeredAt: new Date(NOW - 10_000).toISOString(),
        photoCheck: { result: full.photoCheck, usage: { inputTokens: 3000, outputTokens: 1000 } }, assessment: null,
        reviewContext: { title: subject.title, photos: subject.images } }) });
    const plan = boundedAssessmentPlan(subject);
    cache.set(plan.key, saved(slabReading(plan.photos.length, "9"), plan.version, NOW - 1000));
    const result = await evaluate(subject.id);
    assert.equal(calls.assessed.length, 0); assert.equal(result.assessmentVersion, ANALYSIS_VERSION);
    assert.equal(result.slab?.grade, "8.5"); assert.equal(result.listing.photosAnalyzed, subject.images.length);
});

test("stopping compact work saves its accepted answer and blocks later pricing stages", async () => {
    let started!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { evaluate, calls, cache } = harness(listing(), { assess: async (_listing, photos, _signal, mode) => {
        calls.assessed.push({ mode, photos }); started(); await gate;
        return { result: slabReading(photos.length), usage: { inputTokens: 500, outputTokens: 300 } };
    } });
    const controller = new AbortController();
    const pending = evaluate(listing().id, { signal: controller.signal });
    const rejection = assert.rejects(pending, { name: "AbortError" });
    await began; controller.abort(); release(); await rejection;
    for (let i = 0; i < 30 && !cache.has(boundedAssessmentPlan(listing()).key); i++) await setImmediate();
    assert.ok(cache.has(boundedAssessmentPlan(listing()).key)); assert.equal(calls.lookup, 0); assert.equal(calls.comps.length, 0);
    await evaluate(listing().id);
    assert.equal(calls.assessed.length, 1); assert.equal(calls.comps.length, 1);
});
