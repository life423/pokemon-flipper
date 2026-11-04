import { test } from "node:test";
import assert from "node:assert/strict";
import { createBoundedEvaluator, boundedAssessmentKey, BOUNDED_ASSESSMENT_VERSION, type BoundedReading } from "../../server/analysis/bounded-evaluate.ts";
import { PriceResearchBudgetError, getPriceResearchSignal } from "../../server/pricing/research-budget.ts";
import { getAiUsageContext, withAiUsageContext } from "../../server/ai/usage-context.ts";
import { resultGroup } from "../../shared/analysis.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { seedRawSoldCopies } from "../fixtures/raw-sold-copies.ts";
import type { ListingDetails } from "../../server/ebay/listings.ts";
import type { CardRecord, Comp } from "../../server/pricing/types.ts";
import type { ListingSummary } from "../../shared/types.ts";

const NOW = Date.UTC(2026, 10, 3, 20);
const limit = () => new PriceResearchBudgetError("Offline request allowance reached", "LIMIT");
function subject() {
    const example = cardEvaluation();
    const reading: BoundedReading = { photoCheck: { ...structuredClone(example.photoCheck!), cardCount: "ONE",
        printedName: "Venusaur", printedNumber: "15/102", cardIdentity: { name: "Venusaur", set: "Base Set", cardNumber: "15/102",
            language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Readable name and collector number"] },
        images: example.photoCheck!.images.map(photo => ({ ...photo, obscuresCondition: false })),
        printingMarks: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT", reprintMark: "NONE_SEEN", evidence: ["Edition area and artwork shadow visible"] },
        cardMatch: { verdict: "MATCH", problems: [] }, slab: null }, condition: structuredClone(example.condition!) };
    reading.condition!.gradeRange = null;
    reading.condition!.authenticity = { concern: "NONE_SEEN", reasons: [], observations: [], limitations: [] };
    const listing: ListingDetails = { id: "v1|123456789012|0", title: "Venusaur Base Set 15/102 Unlimited Holo English",
        url: "https://www.ebay.com/itm/123456789012", price: 20, shipping: 0, buyingOption: "FIXED_PRICE", bids: 0, endTime: null,
        seller: null, availability: "ACTIVE", condition: "Ungraded", cardCondition: "Lightly Played", conditionNotes: [],
        images: ["front", "back", "front-detail", "back-detail"].map(view => `https://i.ebayimg.com/images/g/offline-${view}/s-l1600.jpg`),
        aspects: { "Card Name": "Venusaur", Set: "Base Set", "Card Number": "15/102", Language: "English", Finish: "Holo" } };
    const card: CardRecord = { source: "pkmnprices", id: 99, name: "Venusaur", setName: "Base Set", cardNumber: "15/102",
        variants: [{ name: "Holofoil", finish: "HOLO", printing: "UNLIMITED", prices: [{ condition: "LIGHTLY_PLAYED", price: 180, updatedAt: new Date(NOW).toISOString() }] }] };
    return { listing, card, reading };
}
function harness(changes: Parameters<typeof createBoundedEvaluator>[0] = {}, values = subject()) {
    const cache = new Map<string, unknown>();
    const calls = { available: 0, assessed: 0, lookup: 0, raw: 0, graded: [] as string[] };
    const evaluate = createBoundedEvaluator({ now: () => NOW,
        details: async () => structuredClone(values.listing), saved: async () => null,
        cached: async key => structuredClone(cache.get(key) ?? null) as any,
        save: async (key, value) => { cache.set(key, structuredClone(value)); },
        assertPriceAvailable: async () => { calls.available++; },
        assess: async () => { calls.assessed++; return { result: structuredClone(values.reading), usage: { inputTokens: 100, outputTokens: 100 } }; },
        lookup: async () => { calls.lookup++; return [structuredClone(values.card)]; },
        fetchRawComps: async () => { calls.raw++; return []; },
        fetchComps: async (_id, options) => { calls.graded.push(options.grader); return []; },
        compChecks: async () => new Map(), ...changes });
    const summary: ListingSummary = { ...values.listing, currentPrice: values.listing.price, isGraded: values.listing.condition === "Graded" };
    return { ...values, cache, calls, evaluate, summary };
}
function comps(grader: string, grade: string | number): Comp[] {
    return [0, 1, 2].map(index => ({ id: `${grader}-${grade}-${index}`, title: `Venusaur Base Set 15/102 Unlimited Holo ${grader} ${grade}`,
        price: 500, currency: "USD", sold_at: new Date(NOW - (index + 1) * 86400000).toISOString(),
        variant: "Holofoil", attribution: "exact", sale_type: "fixed_price", listing_url: null, grader, grade: String(grade), grade_qualifier: null }));
}

test("an exhausted or invalid price allowance prevents a new paid assessment", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("offline test must not dispatch providers"));
    for (const reason of ["LIMIT", "SCOPE", "ACCOUNT", "STORAGE", "LOCK", "STATE"] as const) {
        const h = harness({ assertPriceAvailable: async () => { throw new PriceResearchBudgetError("Offline guard", reason); } });
        await assert.rejects(h.evaluate(h.listing.id), error => error instanceof PriceResearchBudgetError && error.reason === reason);
        assert.equal(h.calls.assessed, 0); assert.equal(h.calls.lookup, 0); assert.equal(h.cache.size, 0);
    }
});

test("accepted shared photos are reused before the advisory check and catalog deferral stays Sorting", async () => {
    const h = harness({ assertPriceAvailable: async () => assert.fail("cached photos need no assessment admission"), lookup: async () => { throw limit(); } });
    h.cache.set(boundedAssessmentKey(h.listing), { ...h.reading, version: BOUNDED_ASSESSMENT_VERSION,
        answeredAt: new Date(NOW - 1000).toISOString(), usage: { inputTokens: 100, outputTokens: 100 } });
    const result = await h.evaluate(h.listing.id);
    assert.equal(h.calls.assessed, 0); assert.equal(result.listing.photosAnalyzed, 4);
    assert.equal(result.pricingDeferred?.identityLookupPending, true);
    assert.equal(result.underwriting?.verdict, "CANT_PRICE"); assert.equal(resultGroup(h.summary, result), "candidates");
    assert.ok([...h.cache.keys()].some(key => key.startsWith("private-evaluation:")), "the accepted reading and deferred checkpoint remain saved");
});

test("a raw sold-request limit cannot be swallowed into a profitable TCGplayer fallback", async () => {
    const h = harness({ fetchRawComps: async () => { throw limit(); } });
    const result = await h.evaluate(h.listing.id);
    assert.equal(result.condition?.rawCondition, "LIGHTLY_PLAYED"); assert.equal(result.rawPricing?.status, "PRICE_UNAVAILABLE");
    assert.equal(result.rawPricing?.prices, undefined); assert.equal(result.underwriting?.verdict, "CANT_PRICE");
    assert.equal(resultGroup(h.summary, result), "candidates"); assert.equal(h.calls.assessed, 1);
    assert.equal(getPriceResearchSignal(), undefined, "the evaluator does not leak its internal scope");
});

test("completed raw profit remains a Deal when a later grading route is deferred", async () => {
    const values = subject(); values.reading.condition!.gradeRange = { low: 7, likely: 7, high: 7 };
    let sales: Comp[] = [];
    const h = harness({ fetchComps: async () => { throw limit(); }, fetchRawComps: async () => sales }, values);
    sales = seedRawSoldCopies(h.cache, values.listing, "LIGHTLY_PLAYED", 180, NOW);
    const result = await h.evaluate(h.listing.id);
    assert.equal(result.rawPricing?.status, "PRICED"); assert.equal(result.underwriting?.verdict, "BUY_RAW");
    assert.ok(result.underwriting!.best!.profit > 50); assert.equal(resultGroup(h.summary, result), "deals");
    const retargeted = retargetEvaluation(result, { minProfit: 500, minRoi: 1 });
    assert.equal(retargeted.underwriting?.verdict, "CANT_PRICE", "unfinished grading cannot become a completed PASS after a local target change");
    assert.equal(resultGroup(h.summary, retargeted), "candidates");
});

test("completed PSA or CGC scenarios remain actionable when the other grader reaches its allowance", async () => {
    for (const supported of ["PSA", "CGC"] as const) {
        const values = subject(); values.card.variants[0].prices = [{ condition: "LIGHTLY_PLAYED", price: 25, updatedAt: new Date(NOW).toISOString() }];
        values.reading.condition!.gradeRange = { low: 7, likely: 7, high: 7 };
        const h = harness({ fetchComps: async (_id, options) => { if (options.grader !== supported) throw limit(); return comps(options.grader, options.grade); } }, values);
        const result = await h.evaluate(h.listing.id);
        assert.equal(result.gradedPricing?.[supported]?.status, "PRICED"); assert.equal(result.gradedPricing?.[supported]?.byGrade?.[0].count, 3);
        assert.equal(result.gradedPricing?.[supported === "PSA" ? "CGC" : "PSA"]?.status, "PRICE_UNAVAILABLE");
        assert.equal(result.underwriting?.verdict, "BUY_AND_GRADE");
        assert.equal(result.underwriting?.best?.grader, supported); assert.equal(resultGroup(h.summary, result), "deals");
    }
});

test("a verified slab with unfinished exact-grade research stays Sorting, not a zero-price rejection", async () => {
    const values = subject(); values.listing.condition = "Graded"; values.listing.images = values.listing.images.slice(0, 2);
    values.listing.aspects = { ...values.listing.aspects, "Professional Grader": "PSA", Grade: "7" };
    values.reading.condition = null; values.reading.photoCheck.images = values.reading.photoCheck.images.slice(0, 2);
    values.reading.photoCheck.holder = "GRADED_SLAB";
    values.reading.photoCheck.slab = { present: true, grader: "PSA", grade: "7", gradeQualifier: null, certNumber: "12345678",
        labelText: "1999 POKEMON GAME VENUSAUR HOLO 15 PSA 7", caseCondition: "INTACT", authenticity: "NONE_SEEN", authenticityEvidence: [], concerns: [] };
    const h = harness({ fetchComps: async () => { throw limit(); } }, values);
    const result = await h.evaluate(h.listing.id);
    assert.equal(result.slab?.status, "OK"); assert.equal(result.slabPricing?.status, "PRICE_UNAVAILABLE");
    assert.equal(result.underwriting?.verdict, "CANT_PRICE"); assert.equal(result.underwriting?.best, null);
    assert.equal(resultGroup(h.summary, result), "candidates");
    const catalog = harness({ lookup: async () => { throw limit(); } }, values);
    const pending = await catalog.evaluate(catalog.listing.id);
    assert.equal(pending.slab?.status, "OK", "readable slab facts survive an unfinished catalog lookup");
    assert.equal(pending.underwriting?.verdict, "CANT_PRICE"); assert.equal(resultGroup(catalog.summary, pending), "candidates");
});

test("real photo identity and authenticity concerns remain review despite an independent allowance limit", async () => {
    for (const risk of ["identity", "authenticity"] as const) {
        const values = subject();
        if (risk === "identity") values.reading.photoCheck.cardMatch = { verdict: "MISMATCH", problems: ["The photograph differs from the advertised card"] };
        else values.reading.condition!.authenticity = { concern: "POSSIBLE", reasons: ["Printed text has inconsistent spacing"], observations: [{
            photoNumber: 1, feature: "FONTS", observation: "The printed name is misspelled in a readable front view", expected: "Correctly spelled card name", judgment: "SUSPICIOUS",
        }], limitations: [] };
        const h = harness({ lookup: async () => { throw limit(); } }, values);
        const result = await h.evaluate(h.listing.id);
        assert.equal(resultGroup(h.summary, result), "review");
    }
});

test("non-limit accounting failures remain hard stops even through helpers with outage fallback", async () => {
    for (const phase of ["catalog", "raw", "graded"] as const) {
        const values = subject(); values.reading.condition!.gradeRange = { low: 7, likely: 7, high: 7 };
        const stopped = () => { throw new PriceResearchBudgetError("Offline invalid ledger", "STATE"); };
        const h = harness(phase === "catalog" ? { lookup: stopped } : phase === "raw" ? { fetchRawComps: stopped } : { fetchComps: stopped }, values);
        await assert.rejects(h.evaluate(h.listing.id), error => error instanceof PriceResearchBudgetError && error.reason === "STATE");
        assert.ok(h.cache.has(boundedAssessmentKey(h.listing)), "a successful photo answer survives the later accounting failure");
    }
});

test("shared evaluator work supplies its own signal so one cancelled consumer cannot cancel another", async () => {
    let finish: (() => void) | undefined;
    let inherited: AbortSignal | undefined;
    const h = harness({ lookup: async () => { inherited = getPriceResearchSignal(); await new Promise<void>(resolve => { finish = resolve; }); return [subject().card]; } });
    const one = new AbortController(), two = new AbortController();
    const first = h.evaluate(h.listing.id, { signal: one.signal }), second = h.evaluate(h.listing.id, { signal: two.signal });
    while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
    one.abort(); await assert.rejects(first, error => (error as Error).name === "AbortError");
    assert.ok(inherited); assert.equal(inherited.aborted, false);
    finish(); assert.equal((await second).rawPricing?.status, "PRICED"); assert.equal(h.calls.assessed, 1);
});

test("stopping the final evaluator consumer cancels pending price work and retains accepted photos", async () => {
    let started: (() => void) | undefined;
    const begun = new Promise<void>(resolve => { started = resolve; });
    let inherited: AbortSignal | undefined;
    const h = harness({ lookup: async () => {
        inherited = getPriceResearchSignal(); assert.ok(inherited); started!();
        await new Promise<void>((_resolve, reject) => inherited!.addEventListener("abort", () => reject(inherited!.reason), { once: true }));
        return [];
    } });
    const stopped = new AbortController();
    const work = h.evaluate(h.listing.id, { signal: stopped.signal });
    await begun; stopped.abort();
    await assert.rejects(work, error => (error as Error).name === "AbortError");
    assert.equal(inherited!.aborted, true); assert.equal(h.calls.raw, 0); assert.equal(h.calls.graded.length, 0);
    assert.ok(h.cache.has(boundedAssessmentKey(h.listing)));
});

test("a later search resumes deferred pricing from accepted photos instead of reusing the unfinished verdict", async () => {
    let exhausted = true;
    const h = harness({ fetchRawComps: async () => { if (exhausted) throw limit(); return []; } });
    const first = await withAiUsageContext({ searchId: "12345678-1234-4234-8234-123456789012" }, () => h.evaluate(h.listing.id));
    assert.equal(first.underwriting?.verdict, "CANT_PRICE"); assert.ok(first.pricesCheckedAt);
    exhausted = false;
    const completed = await withAiUsageContext({ searchId: "12345678-1234-4234-8234-123456789013" }, () => h.evaluate(h.listing.id));
    assert.equal(completed.pricingDeferred, undefined); assert.equal(completed.underwriting?.verdict, "CANT_PRICE", "completed requests still need matched sold evidence");
    assert.equal(resultGroup(h.summary, completed), "candidates"); assert.equal(h.calls.assessed, 1); assert.equal(h.calls.available, 1);
});

test("different searches keep independent pricing context when one stops after their shared photo answer", async () => {
    const firstId = "12345678-1234-4234-8234-123456789012", secondId = "12345678-1234-4234-8234-123456789013";
    const seen = new Map<string, AbortSignal>();
    const rawOwners: string[] = [];
    let bothStarted: (() => void) | undefined, releaseSecond: (() => void) | undefined;
    const begun = new Promise<void>(resolve => { bothStarted = resolve; });
    const h = harness({ lookup: async () => {
        const owner = getAiUsageContext().searchId!;
        const signal = getPriceResearchSignal()!; seen.set(owner, signal);
        if (seen.size === 2) bothStarted!();
        await new Promise<void>((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            if (owner === secondId) releaseSecond = resolve;
        });
        return [subject().card];
    }, fetchRawComps: async () => { rawOwners.push(getAiUsageContext().searchId!); return []; } });
    const stopped = new AbortController();
    const first = withAiUsageContext({ searchId: firstId }, () => h.evaluate(h.listing.id, { signal: stopped.signal }));
    const second = withAiUsageContext({ searchId: secondId }, () => h.evaluate(h.listing.id));
    await begun; stopped.abort();
    await assert.rejects(first, error => (error as Error).name === "AbortError");
    assert.equal(seen.get(firstId)!.aborted, true); assert.equal(seen.get(secondId)!.aborted, false);
    releaseSecond!(); assert.equal((await second).underwriting?.verdict, "CANT_PRICE");
    assert.deepEqual(rawOwners, [secondId]); assert.equal(h.calls.assessed, 1, "immutable photo work remains shared");
});

test("shared photo work selects the surviving search after its first sponsor stops during admission", async () => {
    const firstId = "12345678-1234-4234-8234-123456789012", secondId = "12345678-1234-4234-8234-123456789013";
    let entered: (() => void) | undefined, release: (() => void) | undefined;
    const begun = new Promise<void>(resolve => { entered = resolve; });
    const admissions: string[] = [], assessed: string[] = [];
    const values = subject();
    const h = harness({ assertPriceAvailable: async () => {
        const id = getAiUsageContext().searchId!; admissions.push(id);
        if (id === firstId) { entered!(); await new Promise<void>(resolve => { release = resolve; }); }
    }, assess: async () => { assessed.push(getAiUsageContext().searchId!); return { result: structuredClone(values.reading), usage: { inputTokens: 100, outputTokens: 100 } }; } }, values);
    const stopped = new AbortController();
    const first = withAiUsageContext({ searchId: firstId }, () => h.evaluate(h.listing.id, { signal: stopped.signal }));
    await begun;
    const second = withAiUsageContext({ searchId: secondId }, () => h.evaluate(h.listing.id));
    await new Promise(resolve => setImmediate(resolve));
    stopped.abort(); await assert.rejects(first, error => (error as Error).name === "AbortError");
    release!(); assert.equal((await second).underwriting?.verdict, "CANT_PRICE");
    assert.deepEqual(admissions, [firstId, secondId]); assert.deepEqual(assessed, [secondId]);
});
