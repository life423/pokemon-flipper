import { test } from "node:test";
import assert from "node:assert/strict";
import { createBoundedEvaluator, selectBoundedPhotos, boundedAssessmentKey, validateBoundedReading, BOUNDED_ASSESSMENT_VERSION, type BoundedReading } from "../../server/analysis/bounded-evaluate.ts";
import { ANALYSIS_VERSION, CONDITION_VERSION } from "../../server/analysis/legacy-evidence.ts";
import { photoFingerprint } from "../../server/analysis/store.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import { AiSpendingError } from "../../server/ai/spending.ts";
import { EnglishOnlyError } from "../../shared/card-language.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import { listingEvidenceKey } from "../../shared/listing-evidence.ts";
import { createPrivateEvaluationStore, PRIVATE_EVALUATION_PREFIX } from "../../server/analysis/private-evaluation.ts";
import { createShortlistStore } from "../../server/shortlist/store.ts";
import { createShortlistService } from "../../server/shortlist/service.ts";
import { photoReviewStatus } from "../../shared/photo-review.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ListingDetails } from "../../server/ebay/listings.ts";
import type { CardRecord } from "../../server/pricing/types.ts";
import type { SavedRecord } from "../../server/analysis/types.ts";

const now = Date.UTC(2026, 10, 2, 12);
const photo = (index: number, size = 1600) => `https://i.ebayimg.com/images/g/bounded-${index}/s-l${size}.jpg`;
const details = (extra: Partial<ListingDetails> = {}): ListingDetails => ({ id: "v1|bounded|0", title: "Venusaur Base Set 15/102 Holo English", url: "https://www.ebay.com/itm/123456789012",
    price: 25, shipping: 4, buyingOption: "FIXED_PRICE", bids: 0, endTime: null, seller: null,
    images: [photo(1), photo(2), photo(3), photo(4)], availability: "ACTIVE", condition: "Ungraded", cardCondition: "Lightly Played", conditionNotes: [],
    aspects: { "Card Name": "Venusaur", Set: "Base Set", "Card Number": "15/102", Language: "English", Finish: "Holo" }, ...extra });
const card: CardRecord = { source: "pkmnprices", id: 123, name: "Venusaur", setName: "Base Set", cardNumber: "15/102", tcgPlayerId: 3,
    variants: [{ name: "Holofoil", finish: "HOLO", printing: "UNLIMITED", prices: [{ condition: "LIGHTLY_PLAYED", price: 150, updatedAt: new Date(now).toISOString() }, { condition: "NEAR_MINT", price: 220, updatedAt: new Date(now).toISOString() }] }] };
function reading(count = 4): BoundedReading {
    const condition = structuredClone(cardEvaluation().condition!);
    condition.gradeRange = { low: 6, likely: 7, high: 8 };
    condition.authenticity = { concern: "NONE_SEEN", reasons: [], limitations: [], observations: [] };
    return { photoCheck: { cardCount: "ONE", holder: "NONE", photoSufficiency: "SUFFICIENT", confidence: "HIGH", printedName: "Venusaur", printedNumber: "15/102",
        cardIdentity: { name: "Venusaur", set: "Base Set", cardNumber: "15/102", language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Legible name and collector number."] },
        images: Array.from({ length: count }, (_, index) => ({ number: index + 1, view: ["FRONT", "BACK", "FRONT_DETAIL", "BACK_DETAIL"][index % 4], usable: true, isStockImage: false, issues: [], obscuresCondition: false })),
        printingMarks: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT", reprintMark: "NONE_SEEN", evidence: ["Artwork shadow visible; no edition stamp."] },
        cardMatch: { verdict: "MATCH", problems: [] }, missingViews: [], problems: [], slab: null }, condition };
}
function harness(extra: Parameters<typeof createBoundedEvaluator>[0] = {}) {
    const cache = new Map<string, any>();
    const calls = { assessed: 0, details: [] as string[], comps: 0, raw: 0 };
    const evaluate = createBoundedEvaluator({ assertPriceAvailable: async () => {}, now: () => now, details: async id => { calls.details.push(id); return details({ id }); }, saved: async () => null,
        cached: async key => cache.get(key) ?? null, save: async (key, value) => { cache.set(key, structuredClone(value)); },
        assess: async (_listing, photos) => { calls.assessed++; return { result: reading(photos.length), usage: { inputTokens: 900, outputTokens: 700 } }; },
        lookup: async () => [structuredClone(card)],
        fetchRawComps: async () => { calls.raw++; return [{ id: "raw-sale", title: "Venusaur Base Set 15/102 Holo NM", price: 150, sold_at: new Date(now - 86400000).toISOString(),
            variant: "Holofoil", currency: "USD", attribution: "exact", sale_type: "fixed_price", listing_url: "https://www.ebay.com/itm/223456789012", grader: null, grade: null, grade_qualifier: null }]; },
        fetchComps: async (_id, options) => { calls.comps++; return [0, 1, 2, 3, 4].map(index => ({ id: `${options.grader}-${options.grade}-${index}`, title: `Venusaur Base Set 15/102 Holo ${options.grader} ${options.grade}`,
            price: 350 + Number(options.grade) * 10, sold_at: new Date(now - (index + 1) * 86400000).toISOString(), variant: "Holofoil", currency: "USD", attribution: "exact", sale_type: "fixed_price", listing_url: null,
            grader: options.grader, grade: String(options.grade), grade_qualifier: null })); },
        compChecks: async () => new Map(), ...extra });
    return { cache, calls, evaluate };
}

test("bounded photo selection samples the entire gallery and deduplicates eBay image-size aliases", () => {
    const images = Array.from({ length: 24 }, (_, index) => photo(index));
    const selected = selectBoundedPhotos([images[0], photo(0, 500), ...images.slice(1)]);
    assert.equal(selected.length, 6);
    assert.deepEqual(selected.map(item => item.number), [1, 3, 9, 14, 20, 25]);
    assert.equal(selected.at(-1)?.url, photo(23));
    const listing = details({ images });
    assert.equal(boundedAssessmentKey(listing), boundedAssessmentKey({ ...listing, id: "another-item", price: 900, shipping: 70, images: images.map(url => url.replace("1600", "500")) }));
    assert.notEqual(boundedAssessmentKey(listing), boundedAssessmentKey({ ...listing, title: listing.title + " Shadowless" }));
});

test("photo sampling covers the middle without spending more on a larger gallery", () => {
    for (let count = 7; count <= 40; count++) {
        const selected = selectBoundedPhotos(Array.from({ length: count }, (_, index) => photo(index)));
        const numbers = selected.map(item => item.number);
        assert.equal(selected.length, 6);
        assert.deepEqual(numbers.slice(0, 2), [1, 2]);
        assert.equal(numbers.at(-1), count);
        const gaps = numbers.slice(1).map((number, index) => number - numbers[index]);
        assert.ok(Math.max(...gaps) <= Math.ceil((count - 2) / 4));
    }
    // Full-back photographs often follow a run of front close-ups. The old
    // sampler skipped the gallery middle and selected both final close-ups.
    const sample = selectBoundedPhotos(Array.from({ length: 11 }, (_, index) => photo(index)));
    assert.deepEqual(sample.map(item => item.number), [1, 2, 4, 7, 9, 11]);
});

test("one bounded raw assessment produces priced outcomes without historical photo requests or later AI stages", async () => {
    const { evaluate, calls } = harness();
    const result = await evaluate("v1|bounded|0");
    assert.equal(calls.assessed, 1);
    assert.deepEqual(calls.details, ["v1|bounded|0"], "sold-copy photos must remain cache-only");
    assert.equal(result.assessmentVersion, BOUNDED_ASSESSMENT_VERSION);
    assert.equal(result.listing.photosAnalyzed, 4);
    assert.equal(result.identity?.status, "IDENTIFIED");
    assert.equal(result.rawPricing?.status, "PRICED");
    assert.equal(result.rawPricing?.prices?.[0].basis, "TCGPLAYER", "unverified raw sold conditions cannot become an eBay price");
    assert.equal(result.gradedPricing?.PSA?.status, "PRICED");
    assert.equal(result.gradedPricing?.CGC?.status, "PRICED");
    assert.ok(result.underwriting?.paths.some(path => path.status === "PRICED"));
    assert.equal(result.usage.length, 1);
    assert.equal(result.photoReviewKey, undefined, "a bounded answer cannot authorize the legacy full-record deeper endpoint");
});

test("insufficient numeric grading detail retains obvious raw damage for a completed priced rejection", async t => {
    t.mock.method(globalThis, "fetch", () => { assert.fail("bounded raw-condition regression must use mocked providers only"); });
    for (const range of [null, { low: 1, likely: 2, high: 3 }]) {
        const report = reading();
        report.photoCheck.photoSufficiency = "INSUFFICIENT";
        report.condition!.rawCondition = "DAMAGED";
        report.condition!.creases = "PRESENT";
        report.condition!.gradeRange = range;
        const { evaluate, calls, cache } = harness({
            details: async id => details({ id, price: 75.46, shipping: 0 }),
            assess: async () => { calls.assessed++; return { result: report, usage: { inputTokens: 700, outputTokens: 450 } }; },
            lookup: async () => [{ ...card, variants: [{ ...card.variants[0], prices: [{ condition: "DAMAGED", price: 15, updatedAt: new Date(now).toISOString() }] }] }],
        });
        const result = await evaluate("v1|damaged-raw-only|0");
        assert.equal(result.gradingMode, "BLOCKED", "numeric grading remains blocked");
        assert.equal(result.gradeStatus, "RAW_CONDITION_ONLY");
        assert.equal(result.condition?.rawCondition, "DAMAGED");
        assert.equal(result.condition?.gradeRange, null);
        assert.equal(result.underwriting?.verdict, "PASS");
        assert.equal(result.underwriting?.best?.path, "RAW");
        assert.equal(result.underwriting?.best?.profit, -75.29);
        assert.equal(photoReviewStatus(result).needsYourReview, false);
        assert.equal(calls.assessed, 1);
        assert.equal(calls.raw, 1);
        assert.equal(calls.comps, 0, "absent numeric grades cannot start grading-price research");
        const saved = [...cache.entries()].find(([key]) => key.startsWith("bounded-assessment:"))![1];
        assert.deepEqual(saved.condition.gradeRange, range, "the original accepted paid reading is retained unchanged");
    }
});

test("a supported near-mint raw resale can proceed without numeric grading detail", async () => {
    const report = reading(); report.photoCheck.photoSufficiency = "INSUFFICIENT";
    report.condition!.rawCondition = "NEAR_MINT";
    report.condition!.gradeRange = null;
    const { evaluate, calls } = harness({ assess: async () => ({ result: report, usage: { inputTokens: 700, outputTokens: 450 } }) });
    const result = await evaluate("v1|near-mint-raw-only|0");
    assert.equal(result.condition?.rawCondition, "NEAR_MINT");
    assert.equal(result.condition?.gradeRange, null);
    assert.equal(result.gradeStatus, "RAW_CONDITION_ONLY");
    assert.equal(result.underwriting?.verdict, "BUY_RAW");
    assert.equal(result.underwriting?.best?.path, "RAW");
    assert.equal(calls.raw, 1);
    assert.equal(calls.comps, 0);
});

test("raw-condition retention cannot bypass missing front, multiple-card or unknown-count blockers", async () => {
    for (const blocker of ["FRONT", "MULTIPLE", "UNKNOWN"] as const) {
        const report = reading(); report.photoCheck.photoSufficiency = "INSUFFICIENT";
        report.condition!.rawCondition = "DAMAGED"; report.condition!.gradeRange = null;
        if (blocker === "FRONT") report.photoCheck.images.filter(image => image.view === "FRONT").forEach(image => { image.view = "OTHER"; });
        else report.photoCheck.cardCount = blocker;
        const { evaluate, calls } = harness({
            assess: async () => { calls.assessed++; return { result: report, usage: { inputTokens: 700, outputTokens: 450 } }; },
            lookup: async () => { assert.fail("a structural photo blocker cannot start catalog or price research"); },
        });
        const result = await evaluate(`v1|blocked-${blocker}|0`);
        assert.equal(result.condition, null);
        assert.equal(result.identity, null);
        assert.equal(calls.raw, 0);
        assert.equal(calls.comps, 0);
        assert.ok(!result.underwriting?.verdict.startsWith("BUY"));
    }
});

test("known raw damage cannot bypass unresolved physical card identity", async () => {
    const report = reading(); report.photoCheck.photoSufficiency = "INSUFFICIENT";
    report.condition!.rawCondition = "DAMAGED"; report.condition!.gradeRange = null;
    report.photoCheck.cardIdentity!.confidence = "LOW";
    const { evaluate, calls } = harness({ assess: async () => ({ result: report, usage: { inputTokens: 700, outputTokens: 450 } }) });
    const result = await evaluate("v1|uncertain-damaged-identity|0");
    assert.equal(result.condition?.rawCondition, "DAMAGED", "condition evidence remains available without authorizing a purchase");
    assert.equal(result.identity?.status, "NEEDS_REVIEW");
    assert.equal(result.underwriting?.verdict, "NEEDS_REVIEW");
    assert.equal(calls.raw, 0);
    assert.equal(calls.comps, 0);
});

test("unchanged public evidence reuses its assessment across listing IDs and purchase prices", async () => {
    const { evaluate, calls } = harness();
    const a = await evaluate("v1|one|0", { current: { price: 20, shipping: 4, bids: 0, endTime: null } });
    const b = await evaluate("v1|two|0", { current: { price: 80, shipping: 4, bids: 0, endTime: null }, fresh: true });
    assert.equal(calls.assessed, 1);
    assert.equal(a.listing.price, 20); assert.equal(b.listing.price, 80);
    assert.ok(b.reusedSteps.includes("boundedPhotoAssessment"));
    assert.equal(b.usage.length, 0);
    assert.equal(a.answeredAt, b.answeredAt, "reuse must not make evidence look newer");
    assert.notEqual(a.underwriting?.best?.profit, b.underwriting?.best?.profit);
});

test("subset assessment reports original listing photo indices instead of claiming the complete gallery", async () => {
    const listing = details({ images: Array.from({ length: 12 }, (_, index) => photo(index)) });
    const { evaluate } = harness({ details: async () => listing });
    const result = await evaluate(listing.id);
    assert.equal(result.listing.photosInListing, 12);
    assert.equal(result.listing.photosAnalyzed, 6);
    assert.deepEqual(result.photoCheck?.images.map(image => image.number), selectBoundedPhotos(listing.images).map(photo => photo.number));
    assert.match(result.modeReasons.join(" "), /Unselected photos were not assessed/);
});

test("saved legacy full evidence is preferred without overwriting or repurchasing it", async () => {
    const listing = details(), full = reading();
    const { evaluate, calls, cache } = harness({ saved: async id => ({ itemId: id, version: ANALYSIS_VERSION, photoFingerprint: photoFingerprint(listing.images), answeredAt: new Date(now - 86400000).toISOString(),
        photoCheck: { result: full.photoCheck, usage: { inputTokens: 3000, outputTokens: 1000 } }, assessment: { version: CONDITION_VERSION, completedRuns: 2, mode: "FULL", photoNumbers: [1, 2, 3, 4], result: full.condition!, setAside: [] },
        reviewContext: { title: listing.title, photos: listing.images } }) });
    const result = await evaluate(listing.id);
    assert.equal(calls.assessed, 0);
    assert.equal([...cache.keys()].filter(key => key.startsWith("bounded-assessment:")).length, 0);
    assert.equal(result.assessmentVersion, ANALYSIS_VERSION);
    assert.deepEqual(result.reusedSteps, ["photoCheck", "condition"]);
});

test("legacy identity-pass corrections survive absent or expired valuation checkpoints without another assessment", async () => {
    for (const stale of [false, true]) {
        const listing = details(), full = reading();
        full.photoCheck.holder = "GRADED_SLAB";
        full.photoCheck.cardIdentity!.finish = "UNKNOWN";
        full.photoCheck.slab = { present: true, grader: "CGC", grade: null, gradeQualifier: null, labelText: null, certNumber: null,
            caseCondition: "INTACT", authenticity: "NONE_SEEN", concerns: [] };
        const pass = { cardCount: "ONE", cardIdentity: { ...full.photoCheck.cardIdentity!, finish: "HOLO" as const },
            printedName: "Venusaur", printedNumber: "15/102", printingMarks: full.photoCheck.printingMarks,
            slab: { ...full.photoCheck.slab, grade: "8.5", labelText: "1999 BASE SET VENUSAUR HOLO CGC 8.5", certNumber: "12345678" } };
        const oldEvaluation = cardEvaluation();
        oldEvaluation.assessmentVersion = ANALYSIS_VERSION; oldEvaluation.conditionVersion = CONDITION_VERSION;
        oldEvaluation.pricingVersion = PRICING_VERSION; oldEvaluation.pricesCheckedAt = new Date(now - 7 * 86400000).toISOString();
        const record: SavedRecord = { itemId: listing.id, version: ANALYSIS_VERSION, photoFingerprint: photoFingerprint(listing.images), answeredAt: new Date(now - 86400000).toISOString(),
            photoCheck: { result: full.photoCheck, usage: { inputTokens: 3000, outputTokens: 1000 } }, assessment: null,
            identityPasses: [pass, structuredClone(pass)].map(result => ({ result, usage: { inputTokens: 500, outputTokens: 100 } })),
            reviewContext: { title: listing.title, photos: listing.images },
            ...(stale ? { latestEvaluation: { evidenceKey: listingEvidenceKey(listing), evaluation: oldEvaluation } } : {}) };
        const original = structuredClone(record);
        const { evaluate, calls } = harness({ saved: async () => record });
        const result = await evaluate(listing.id);
        assert.equal(calls.assessed, 0); assert.equal(calls.raw, 0);
        assert.equal(result.photoCheck?.slab?.grade, "8.5"); assert.equal(result.photoCheck?.cardIdentity?.finish, "HOLO");
        assert.equal(result.identity?.finish, "HOLO"); assert.equal(result.slab?.grade, "8.5"); assert.equal(result.slab?.status, "OK");
        assert.ok(result.reusedSteps.includes("identityResolution"));
        assert.equal(result.slabPricing?.summary?.grade, "8.5");
        assert.deepEqual(record, original, "the paid original and independent passes remain unchanged");
    }
});

test("legacy identity-pass finish disagreements remain blocking without new assessments or pricing", async () => {
    const listing = details(), full = reading(); full.photoCheck.cardIdentity!.finish = "UNKNOWN";
    const pass = (finish: "HOLO" | "REVERSE_HOLO") => ({ result: { cardCount: "ONE", cardIdentity: { ...full.photoCheck.cardIdentity!, finish },
        printedName: "Venusaur", printedNumber: "15/102", printingMarks: full.photoCheck.printingMarks, slab: null }, usage: { inputTokens: 1, outputTokens: 1 } });
    const { evaluate, calls } = harness({ saved: async id => ({ itemId: id, version: ANALYSIS_VERSION, photoFingerprint: photoFingerprint(listing.images), answeredAt: new Date(now - 86400000).toISOString(),
        photoCheck: { result: full.photoCheck, usage: { inputTokens: 3000, outputTokens: 1000 } },
        assessment: { version: CONDITION_VERSION, completedRuns: 2, mode: "FULL", photoNumbers: [1, 2, 3, 4], result: full.condition!, setAside: [] },
        identityPasses: [pass("HOLO"), pass("REVERSE_HOLO")], reviewContext: { title: listing.title, photos: listing.images } }) });
    const result = await evaluate(listing.id);
    assert.equal(calls.assessed, 0); assert.equal(calls.comps, 0); assert.equal(calls.raw, 0);
    assert.equal(result.identity?.status, "NEEDS_REVIEW"); assert.equal(result.identity?.finish, "CONFLICTING");
    assert.doesNotMatch(result.underwriting?.verdict ?? "", /^BUY/);
});

test("an existing slab verifies and prices its exact grade without estimating raw condition", async () => {
    const full = reading();
    full.condition!.rawCondition = "DAMAGED";
    full.condition!.gradeRange = null;
    full.photoCheck.holder = "GRADED_SLAB";
    full.photoCheck.slab = { present: true, grader: "PSA", grade: "7", gradeQualifier: null, certNumber: "12345678", labelText: "1999 POKEMON GAME VENUSAUR HOLO #15 EX MT 7", caseCondition: "INTACT", authenticity: "NONE_SEEN", authenticityEvidence: [], concerns: [] };
    const { evaluate, calls } = harness({ assess: async () => { calls.assessed++; return { result: full, usage: { inputTokens: 700, outputTokens: 450 } }; } });
    const result = await evaluate("v1|slab|0");
    assert.equal(calls.assessed, 1); assert.equal(calls.comps, 1); assert.equal(calls.raw, 0);
    assert.equal(result.slab?.status, "OK"); assert.equal(result.slab?.grade, "7");
    assert.equal(result.slabPricing?.status, "PRICED");
    assert.equal(result.condition, null);
});

test("expired inventory and explicit non-English listings start no assessment", async () => {
    for (const extra of [{ availability: "UNAVAILABLE" as const }, { endTime: new Date(now - 1).toISOString() }]) {
        const { evaluate, calls } = harness({ details: async () => details(extra) });
        const result = await evaluate("v1|ended|0"); assert.equal(result.listing.availability, "UNAVAILABLE"); assert.equal(calls.assessed, 0);
    }
    const { evaluate, calls } = harness({ details: async () => details({ title: "Venusaur Japanese" }) });
    await assert.rejects(evaluate("v1|foreign|0"), EnglishOnlyError); assert.equal(calls.assessed, 0);
});

test("foreign photo findings save once and stop before market research on later requests too", async () => {
    const other = reading(); other.photoCheck.cardIdentity!.language = "Japanese";
    const { evaluate, calls, cache } = harness({ assess: async () => { calls.assessed++; return { result: other, usage: { inputTokens: 700, outputTokens: 450 } }; } });
    await assert.rejects(evaluate("v1|foreign-photo|0"), EnglishOnlyError);
    assert.equal(cache.size, 1);
    await assert.rejects(evaluate("v1|foreign-photo|0"), EnglishOnlyError);
    assert.equal(calls.assessed, 1); assert.equal(calls.comps, 0); assert.equal(calls.raw, 0);
});

test("seller metadata cannot turn an unknown photographed card language into a confirmed deal", async () => {
    const unknown = reading(); unknown.photoCheck.cardIdentity!.language = null;
    const { evaluate, calls } = harness({ assess: async () => { calls.assessed++; return { result: unknown, usage: { inputTokens: 700, outputTokens: 450 } }; } });
    const result = await evaluate("v1|unknown-language|0");
    assert.equal(result.identity?.status, "NEEDS_REVIEW");
    assert.equal(calls.raw, 0); assert.equal(calls.comps, 0);
    assert.ok(!result.underwriting?.verdict.startsWith("BUY"));
});

test("corrupt cached assessments and unsupported broad ranges fail closed without replacement AI", async () => {
    const invalid = reading(); invalid.condition!.gradeRange = { low: 3, likely: 6, high: 8 };
    assert.throws(() => validateBoundedReading(invalid, 4), StorageUnavailableError);
    const { evaluate, calls, cache } = harness();
    cache.set(boundedAssessmentKey(details()), { version: BOUNDED_ASSESSMENT_VERSION, answeredAt: new Date(now).toISOString(), ...invalid });
    await assert.rejects(evaluate("v1|bounded|0"), StorageUnavailableError); assert.equal(calls.assessed, 0);
});

test("budget and storage stops propagate instead of launching remaining research", async () => {
    for (const failure of [new AiSpendingError("AI_BUDGET", "Search budget exhausted."), new StorageUnavailableError()]) {
        const { evaluate, calls } = harness({ fetchComps: async () => { calls.comps++; throw failure; } });
        await assert.rejects(evaluate("v1|bounded|0"), error => error === failure);
        assert.equal(calls.comps, 1, "no other grade/grader research starts after a controlled stop");
    }
});

test("a fresh complete legacy evaluation retains preference over a newer bounded reading without new lookups", async () => {
    const listing = details(), full = reading(), oldEvaluation = cardEvaluation();
    oldEvaluation.assessmentVersion = ANALYSIS_VERSION; oldEvaluation.conditionVersion = CONDITION_VERSION;
    oldEvaluation.pricingVersion = PRICING_VERSION; oldEvaluation.pricesCheckedAt = new Date(now - 60000).toISOString();
    oldEvaluation.listing.photos = listing.images;
    const { evaluate, calls, cache } = harness({ lookup: async () => { throw new Error("Fresh saved prices must be reused"); }, saved: async id => ({
        itemId: id, version: ANALYSIS_VERSION, photoFingerprint: photoFingerprint(listing.images), answeredAt: new Date(now - 86400000).toISOString(),
        photoCheck: { result: full.photoCheck, usage: { inputTokens: 3000, outputTokens: 1000 } }, assessment: null,
        reviewContext: { title: listing.title, photos: listing.images }, latestEvaluation: { evidenceKey: listingEvidenceKey({ title: listing.title, images: listing.images }), evaluation: oldEvaluation },
    }) });
    const bounded = reading(); bounded.condition!.rawCondition = "UNKNOWN"; bounded.condition!.gradeRange = null;
    cache.set(boundedAssessmentKey(listing), { ...bounded, version: BOUNDED_ASSESSMENT_VERSION, answeredAt: new Date(now).toISOString() });
    const result = await evaluate(listing.id);
    assert.equal(calls.assessed, 0); assert.equal(calls.comps, 0); assert.equal(calls.raw, 0);
    assert.equal(result.listing.price, listing.price);
    assert.equal(result.pricesCheckedAt, oldEvaluation.pricesCheckedAt);
    assert.ok(result.reusedSteps.includes("savedEvaluation"));
});

test("Stop retains an accepted bounded answer and prevents downstream price work", async () => {
    let started!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const accepted = new Promise<void>(resolve => { release = resolve; });
    const { evaluate, calls, cache } = harness({ assess: async (_listing, photos) => {
        calls.assessed++; started(); await accepted;
        return { result: reading(photos.length), usage: { inputTokens: 900, outputTokens: 700 } };
    } });
    const stop = new AbortController();
    const pending = evaluate("v1|bounded|0", { signal: stop.signal });
    await began; stop.abort(); release();
    await assert.rejects(pending, { name: "AbortError" });
    for (let i = 0; !cache.size && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(cache.size, 1, "accepted evidence is saved after its browser consumer detaches");
    assert.equal(calls.comps, 0); assert.equal(calls.raw, 0);
    const next = await evaluate("v1|bounded|0");
    assert.equal(calls.assessed, 1);
    assert.ok(next.reusedSteps.includes("boundedPhotoAssessment"));
});

test("concurrent equivalent listings share one photo assessment while retaining separate purchase calculations", async () => {
    let started!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const accepted = new Promise<void>(resolve => { release = resolve; });
    const { evaluate, calls } = harness({ assess: async (_listing, photos) => {
        calls.assessed++; started(); await accepted;
        return { result: reading(photos.length), usage: { inputTokens: 900, outputTokens: 700 } };
    } });
    const a = evaluate("v1|concurrent-a|0", { current: { price: 20, shipping: 4, bids: 0, endTime: null } });
    const b = evaluate("v1|concurrent-b|0", { current: { price: 80, shipping: 4, bids: 0, endTime: null } });
    await began; await new Promise(resolve => setImmediate(resolve)); release();
    const [first, second] = await Promise.all([a, b]);
    assert.equal(calls.assessed, 1);
    assert.equal(first.listing.price, 20); assert.equal(second.listing.price, 80);
    assert.notEqual(first.underwriting?.best?.profit, second.underwriting?.best?.profit);
    assert.equal(first.usage.length + second.usage.length, 1);
    assert.notEqual(first.photoCheck, second.photoCheck, "mapping source indices cannot mutate another consumer's answer");
});

test("stopping one equivalent listing leaves a second consumer's shared assessment running", async () => {
    let started!: () => void, release!: () => void;
    let sharedSignal: AbortSignal | undefined;
    const began = new Promise<void>(resolve => { started = resolve; });
    const accepted = new Promise<void>(resolve => { release = resolve; });
    const { evaluate, calls, cache } = harness({ assess: async (_listing, photos, signal) => {
        calls.assessed++; sharedSignal = signal; started(); await accepted;
        return { result: reading(photos.length), usage: { inputTokens: 900, outputTokens: 700 } };
    } });
    const stop = new AbortController();
    const a = evaluate("v1|stopped-copy|0", { signal: stop.signal });
    const b = evaluate("v1|active-copy|0");
    await began; await new Promise(resolve => setImmediate(resolve)); stop.abort();
    await assert.rejects(a, { name: "AbortError" });
    assert.equal(sharedSignal?.aborted, false);
    release();
    assert.ok((await b).underwriting?.paths.some(path => path.status === "PRICED"));
    assert.equal(calls.assessed, 1); assert.equal([...cache.keys()].filter(key => key.startsWith("bounded-assessment:")).length, 1);
});

test("automatic auctions recheck the 12-hour window while explicit manual analysis remains available", async () => {
    const far = details({ buyingOption: "AUCTION", endTime: new Date(now + 24 * 3600000).toISOString() });
    const { evaluate, calls } = harness({ details: async id => ({ ...far, id }) });
    const deferred = await evaluate("v1|far-auction|0", { automatic: true });
    assert.equal(calls.assessed, 0);
    assert.equal(deferred.gradeStatus, "DEFERRED_AUCTION_WINDOW");
    assert.equal(deferred.gradingMode, "BLOCKED");
    await evaluate("v1|far-auction|0", { automatic: false });
    assert.equal(calls.assessed, 1);
    let clock = now;
    const expiring = harness({ now: () => clock, details: async () => details({ buyingOption: "AUCTION", endTime: new Date(now + 1000).toISOString() }),
        cached: async () => { clock = now + 2000; return null; } });
    const stale = await expiring.evaluate("v1|expired-before-dispatch|0", { automatic: true });
    assert.equal(expiring.calls.assessed, 0, "a slow cache lookup cannot authorize photos after the auction ends");
    assert.equal(stale.gradingMode, "BLOCKED");
});

test("missing photos and unknown card count cannot claim full assessment or start market lookups", async () => {
    const absent = harness({ details: async () => details({ images: [] }) });
    const empty = await absent.evaluate("v1|no-photos|0");
    assert.equal(empty.gradingMode, "BLOCKED"); assert.equal(empty.listing.photosAnalyzed, 0); assert.equal(absent.calls.assessed, 0);
    const unknown = reading(); unknown.photoCheck.cardCount = "UNKNOWN"; unknown.condition = null;
    const uncounted = harness({ assess: async () => ({ result: unknown, usage: { inputTokens: 900, outputTokens: 700 } }),
        lookup: async () => { throw new Error("An unknown card count cannot justify paid catalog work"); } });
    const result = await uncounted.evaluate("v1|unknown-count|0");
    assert.equal(result.gradingMode, "BLOCKED"); assert.equal(result.identity, null);
    assert.equal(uncounted.calls.raw, 0); assert.equal(uncounted.calls.comps, 0);
});

test("bounded evaluation persists privately for save-after-analysis and reload without another assessment or market lookup", async t => {
    const { evaluate, calls, cache } = harness();
    const listing = details();
    const current = { title: listing.title, images: [listing.images[0]], price: 20, shipping: 4, bids: 0, endTime: null };
    const initial = await evaluate(listing.id, { current });
    const marketCalls = calls.comps + calls.raw;
    const privateStore = createPrivateEvaluationStore({ cached: async key => cache.get(key) ?? null, save: async (key, value) => { cache.set(key, value); } });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-bounded-shortlist-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "shortlist.json");
    const store = createShortlistStore(file);
    const service = createShortlistService({ store, load: async () => null, latest: privateStore.load, cached: async () => listing, now: () => now });
    const snapshot = { id: listing.id, title: listing.title, url: listing.url, currentPrice: 20, shipping: 4, bids: 0, isGraded: false, buyingOption: "FIXED_PRICE" as const, endTime: null, images: current.images, seller: null };
    await service.save(snapshot);
    const reopened = (await createShortlistStore(file).list())[0];
    assert.equal(reopened.needsAnalysis, false);
    assert.equal(reopened.evaluation?.assessmentVersion, BOUNDED_ASSESSMENT_VERSION);
    assert.equal(reopened.evaluation?.photoReviewKey, undefined);
    assert.equal(reopened.evaluation?.listing.photosAnalyzed, initial.listing.photosAnalyzed);
    const again = await evaluate(listing.id, { current: { ...current, price: 80 } });
    assert.ok(again.reusedSteps.includes("savedEvaluation"));
    assert.equal(again.listing.price, 80);
    assert.notEqual(again.underwriting?.best?.profit, initial.underwriting?.best?.profit);
    assert.equal(calls.assessed, 1); assert.equal(calls.comps + calls.raw, marketCalls);
    const publicAnswer = [...cache.entries()].find(([key]) => key.startsWith("bounded-assessment:"))![1];
    assert.equal("underwriting" in publicAnswer, false);
    assert.equal([...cache.keys()].filter(key => key.startsWith(PRIVATE_EVALUATION_PREFIX)).length, 1);
});

test("changed seller label facts invalidate private financial reuse and the old claim-dependent assessment", async () => {
    let listing = details();
    const { evaluate, calls } = harness({ details: async () => listing });
    await evaluate(listing.id);
    const marketCalls = calls.comps + calls.raw;
    listing = { ...listing, aspects: { ...listing.aspects, Grade: "9" } };
    const next = await evaluate(listing.id);
    assert.equal(next.reusedSteps.includes("savedEvaluation"), false);
    assert.equal(calls.assessed, 2, "changed claims are new model inputs, unlike changed purchase prices");
    assert.ok(calls.comps + calls.raw > marketCalls);
});

test("a newer shared bounded correction supersedes fresh private financial evidence without another assessment", async () => {
    let clock = now;
    const { evaluate, calls, cache } = harness({ now: () => clock });
    const first = await evaluate("v1|new-shared-correction|0");
    const original = structuredClone(first);
    const marketCalls = calls.raw + calls.comps;
    const correction = reading();
    correction.photoCheck.printingMarks!.firstEditionStamp = "VISIBLE";
    correction.photoCheck.printingMarks!.evidence = ["The edition stamp is visible in the corrected reading."];
    correction.condition!.rawCondition = "UNKNOWN";
    correction.condition!.gradeRange = null;
    const saved = { ...correction, version: BOUNDED_ASSESSMENT_VERSION, answeredAt: new Date(now + 1000).toISOString(), usage: { inputTokens: 700, outputTokens: 450 } };
    const key = boundedAssessmentKey(details());
    cache.set(key, structuredClone(saved));
    clock = now + 2000;
    const updated = await evaluate(first.listing.id);
    assert.equal(calls.assessed, 1, "the new shared reading must not trigger replacement paid work");
    assert.ok(updated.reusedSteps.includes("boundedPhotoAssessment"));
    assert.equal(updated.reusedSteps.includes("savedEvaluation"), false);
    assert.equal(updated.photoCheck?.printingMarks?.firstEditionStamp, "VISIBLE");
    assert.equal(updated.condition?.rawCondition, "UNKNOWN");
    assert.equal(updated.condition?.gradeRange, null);
    assert.equal(updated.answeredAt, saved.answeredAt);
    assert.equal(updated.usage.length, 0);
    assert.ok(!updated.underwriting?.verdict.startsWith("BUY"));
    assert.equal(calls.raw + calls.comps, marketCalls, "unknown raw condition and grade cannot justify price-provider work");
    assert.deepEqual(cache.get(key), saved, "financial refresh does not rewrite the accepted shared photo record");
    assert.deepEqual(first, original, "the previously returned paid evidence is not mutated");
});

test("a newer bounded correction also supersedes a bounded evaluation stored in the legacy latest checkpoint", async () => {
    let clock = now;
    let checkpoint: SavedRecord | null = null;
    const { evaluate, calls, cache } = harness({ now: () => clock, saved: async () => checkpoint });
    const first = await evaluate("v1|bounded-in-legacy-latest|0");
    const listing = details({ id: first.listing.id });
    checkpoint = {
        itemId: first.listing.id, version: ANALYSIS_VERSION, photoFingerprint: photoFingerprint(listing.images), answeredAt: first.answeredAt,
        photoCheck: { result: reading().photoCheck, usage: { inputTokens: 700, outputTokens: 450 } }, assessment: null,
        reviewContext: { title: listing.title, photos: listing.images },
        latestEvaluation: { evidenceKey: listingEvidenceKey({ title: listing.title, images: listing.images }), evaluation: first },
    };
    const correction = reading(); correction.condition!.rawCondition = "UNKNOWN"; correction.condition!.gradeRange = null;
    cache.set(boundedAssessmentKey(listing), { ...correction, version: BOUNDED_ASSESSMENT_VERSION, answeredAt: new Date(now + 1000).toISOString() });
    const marketCalls = calls.raw + calls.comps;
    clock = now + 2000;
    const next = await evaluate(first.listing.id);
    assert.equal(next.reusedSteps.includes("savedEvaluation"), false);
    assert.ok(next.reusedSteps.includes("boundedPhotoAssessment"));
    assert.equal(next.condition?.rawCondition, "UNKNOWN");
    assert.equal(calls.assessed, 1);
    assert.equal(calls.raw + calls.comps, marketCalls);
});

test("an older or equivalent shared reading preserves the fresh private-price fast path", async () => {
    for (const answeredAt of [now - 1000, now]) {
        const { evaluate, calls, cache } = harness();
        const first = await evaluate("v1|equal-or-older-shared|0");
        const marketCalls = calls.raw + calls.comps;
        const key = boundedAssessmentKey(details());
        const saved = cache.get(key);
        saved.answeredAt = new Date(answeredAt).toISOString();
        const next = await evaluate(first.listing.id);
        assert.ok(next.reusedSteps.includes("savedEvaluation"));
        assert.equal(calls.assessed, 1);
        assert.equal(calls.raw + calls.comps, marketCalls);
    }
});

test("corrupt shared evidence cannot be hidden by fresh private evidence or turn into replacement AI", async () => {
    for (const corrupt of [{ answeredAt: null }, { answeredAt: "invalid" }, { photoCheck: null }]) {
        const { evaluate, calls, cache } = harness();
        const first = await evaluate("v1|corrupt-shared-private|0");
        const marketCalls = calls.raw + calls.comps;
        const key = boundedAssessmentKey(details());
        cache.set(key, { ...cache.get(key), ...corrupt });
        await assert.rejects(evaluate(first.listing.id), StorageUnavailableError);
        assert.equal(calls.assessed, 1);
        assert.equal(calls.raw + calls.comps, marketCalls);
        assert.deepEqual(Object.fromEntries(Object.entries(cache.get(key)).filter(([field]) => field in corrupt)), corrupt);
    }
});

test("a known card without a usable raw condition or numeric grade starts no price research", async () => {
    const unknown = reading(); unknown.condition!.rawCondition = "UNKNOWN"; unknown.condition!.gradeRange = null;
    const { evaluate, calls } = harness({ assess: async () => ({ result: unknown, usage: { inputTokens: 700, outputTokens: 450 } }) });
    const result = await evaluate("v1|unknown-condition-no-prices|0");
    assert.equal(result.identity?.status, "IDENTIFIED");
    assert.equal(result.condition?.rawCondition, "UNKNOWN");
    assert.equal(result.underwriting?.verdict, "CANT_PRICE");
    assert.equal(calls.raw, 0);
    assert.equal(calls.comps, 0);
});

test("an applicable numeric grading range can still be priced when the raw category is unknown", async () => {
    const unknown = reading(); unknown.condition!.rawCondition = "UNKNOWN";
    const { evaluate, calls } = harness({ assess: async () => ({ result: unknown, usage: { inputTokens: 700, outputTokens: 450 } }) });
    const result = await evaluate("v1|grade-only-condition|0");
    assert.equal(result.condition?.rawCondition, "UNKNOWN");
    assert.equal(result.rawPricing, null);
    assert.equal(calls.raw, 0);
    assert.ok(calls.comps > 0);
    assert.ok(result.underwriting?.paths.some(path => path.path === "GRADE" && path.status === "PRICED"));
});

test("expired private prices refresh market evidence while retaining the paid photo assessment", async () => {
    let clock = now;
    const { evaluate, calls } = harness({ now: () => clock });
    const first = await evaluate("v1|price-expiry|0");
    const marketCalls = calls.comps + calls.raw;
    clock += 6 * 3600000 + 1;
    const next = await evaluate("v1|price-expiry|0");
    assert.equal(calls.assessed, 1);
    assert.ok(next.reusedSteps.includes("boundedPhotoAssessment"));
    assert.ok(calls.comps + calls.raw > marketCalls);
    assert.equal(next.answeredAt, first.answeredAt);
    assert.notEqual(next.pricesCheckedAt, first.pricesCheckedAt);
});

test("readable cached slab labels resolve seller-certificate-only holds without buying another photo assessment", async () => {
    for (const pricesAlreadySaved of [false, true]) {
        const full = reading(); full.condition = null; full.photoCheck.holder = "GRADED_SLAB";
        full.photoCheck.slab = { present: true, grader: "PSA", grade: "5", gradeQualifier: null, certNumber: "102800436", labelText: "1999 POKEMON GAME VENUSAUR HOLO #15 EX 5", caseCondition: "INTACT", authenticity: "NONE_SEEN", authenticityEvidence: [], concerns: ["Seller certificate differs from the label."] };
        full.photoCheck.problems = ["The seller's certificate number does not match the photographed label."];
        const listing = details({ aspects: { ...details().aspects, "Professional Grader": "PSA", Grade: "5", "Certification Number": "145363878" } });
        const { evaluate, calls, cache } = harness({ details: async () => listing,
            assess: async () => { calls.assessed++; return { result: full, usage: { inputTokens: 700, outputTokens: 450 } }; } });
        await evaluate(listing.id);
        const old = [...cache.entries()].find(([key]) => key.startsWith(PRIVATE_EVALUATION_PREFIX))![1];
        old.evaluation.slab.status = "NEEDS_REVIEW";
        old.evaluation.slab.reasons = ["The cert number in the item details doesn't match the label."];
        old.evaluation.underwriting.verdict = "NEEDS_REVIEW";
        if (!pricesAlreadySaved) old.evaluation.slabPricing = null;
        const originalQuotes = calls.comps;
        const revised = await evaluate(listing.id);
        assert.equal(calls.assessed, 1);
        assert.equal(calls.comps, originalQuotes + (pricesAlreadySaved ? 0 : 1));
        assert.equal(revised.slab?.status, "OK");
        assert.equal(revised.slab?.certNumber, "102800436");
        assert.equal(revised.slab?.certUrl, "https://www.psacard.com/cert/102800436");
        assert.match(revised.slab?.concerns.join(" ") ?? "", /seller-entered certificate/i);
        assert.equal(revised.slabPricing?.grade, "5");
        assert.equal(revised.underwriting?.verdict, "BUY_GRADED");
        assert.equal(photoReviewStatus(revised).needsYourReview, false, "generic certificate notes must not reintroduce a manual hold");
    }
});
