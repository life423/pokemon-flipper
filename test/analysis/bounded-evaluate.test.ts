import { test } from "node:test";
import sharp from "sharp";
import { matchesFrontBackComposite } from "../../server/analysis/front-back-composite.ts";
import assert from "node:assert/strict";
import { createBoundedEvaluator, selectBoundedPhotos, boundedAssessmentKey, boundedAssessmentPlan, validateBoundedReading, BOUNDED_ASSESSMENT_VERSION, PriceOnlyEvidenceError, type BoundedReading } from "../../server/analysis/bounded-evaluate.ts";
import { compatibleBoundedPlans, stagedPhotoPlan } from "../../server/analysis/bounded-plan.ts";
import { ANALYSIS_VERSION, CONDITION_VERSION } from "../../server/analysis/legacy-evidence.ts";
import { createDeeperPhotoReviewer } from "../../server/analysis/deeper-review.ts";
import { photoFingerprint } from "../../server/analysis/store.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import { evaluationFailure, RejectedPhotoAssessmentError } from "../../server/analysis/failure.ts";
import { AiSearchAllowanceError, AiSpendingError } from "../../server/ai/spending.ts";
import { applyFrameReading } from "../../server/analysis/base-set-frame.ts";
import { getAiUsageContext, withAiUsageContext } from "../../server/ai/usage-context.ts";
import { PriceResearchBudgetError } from "../../server/pricing/research-budget.ts";
import { EnglishOnlyError } from "../../shared/card-language.ts";
import { cardEvaluation, salesSummary, clearReleaseFixture } from "../fixtures/card-evaluation.ts";
import { currentPriceEvidence, PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import { listingEvidenceKey } from "../../shared/listing-evidence.ts";
import { createPrivateEvaluationStore, evaluationContextKey, PRIVATE_EVALUATION_PREFIX } from "../../server/analysis/private-evaluation.ts";
import { createShortlistStore } from "../../server/shortlist/store.ts";
import { createShortlistService } from "../../server/shortlist/service.ts";
import { displayedRawGrade } from "../../shared/photo-evidence.ts";
import { legendaryCharizardLabelFinish } from "../../shared/psa-legendary-charizard.ts";
import { photoReviewStatus } from "../../shared/photo-review.ts";
import { canAutoAnalyze, resultGroup } from "../../shared/analysis.ts";
import { filterSearchResults, groupSearchResults } from "../../client/src/search/results.ts";
import { searchDiagnosticRows } from "../../client/src/search/diagnostic.ts";
import type { AnalysisState } from "../../client/src/analysis-state.ts";
import { findDeals } from "../../server/deals/find-deals.ts";
import { readSearchLocally } from "../../server/search/intent.ts";
import { readTitleByRules } from "../../server/ai/title-reader.ts";
import { createSoldScreening } from "../../server/pricing/screening-sales.ts";
import type { ListingSummary } from "../../shared/types.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { seedRawSoldCopies } from "../fixtures/raw-sold-copies.ts";
import { createSoldConditionAcquirer, type SoldConditionReading } from "../../server/ai/sold-condition.ts";
import { drainSharedWork } from "../../server/lib/shared-work.ts";
import { createCacheStore } from "../../server/lib/cache.ts";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ListingDetails } from "../../server/ebay/listings.ts";
import type { CardRecord, Comp } from "../../server/pricing/types.ts";
import type { SavedRecord } from "../../server/analysis/types.ts";

const now = Date.UTC(2026, 10, 2, 12);
const photo = (index: number, size = 1600) => `https://i.ebayimg.com/images/g/bounded-${index}/s-l${size}.jpg`;
const details = (extra: Partial<ListingDetails> = {}): ListingDetails => ({ id: "v1|bounded|0", title: "Venusaur Base Set 15/102 Holo English", url: "https://www.ebay.com/itm/123456789012",
    price: 25, shipping: 4, buyingOption: "FIXED_PRICE", bids: 0, endTime: null, seller: null,
    images: [photo(1), photo(2), photo(3), photo(4)], availability: "ACTIVE", condition: "Ungraded", cardCondition: "Lightly Played", conditionNotes: [],
    aspects: { "Card Name": "Venusaur", Set: "Base Set", "Card Number": "15/102", Language: "English", Finish: "Holo" }, ...extra });
const card: CardRecord = { source: "pkmnprices", id: 123, name: "Venusaur", setName: "Base Set", cardNumber: "15/102",
    variants: [{ name: "Holofoil", finish: "HOLO", printing: "UNLIMITED" }] };
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
function gradedSales({ grader, grade }: { grader: string; grade: string | number }): Comp[] {
    return [0, 1, 2, 3, 4].map(index => ({ id: `${grader}-${grade}-${index}`, title: `Venusaur Base Set 15/102 Holo ${grader} ${grade}`,
        price: 350 + Number(grade) * 10, sold_at: new Date(now - (index + 1) * 86400000).toISOString(), variant: "Holofoil", currency: "USD",
        attribution: "exact", sale_type: "fixed_price", listing_url: null, grader, grade: String(grade), grade_qualifier: null }));
}
function harness(extra: Parameters<typeof createBoundedEvaluator>[0] = {}) {
    const cache = new Map<string, any>();
    const calls = { assessed: 0, details: [] as string[], comps: 0, raw: 0 };
    const evaluate = createBoundedEvaluator({ release: async e => clearReleaseFixture(e), assertPriceAvailable: async () => {}, now: () => now, details: async id => { calls.details.push(id); return details({ id }); }, saved: async () => null,
        cached: async key => cache.get(key) ?? null, save: async (key, value) => { cache.set(key, structuredClone(value)); },
        assess: async (_listing, photos) => { calls.assessed++; return { result: reading(photos.length), usage: { inputTokens: 900, outputTokens: 700 } }; },
        lookup: async () => [structuredClone(card)],
        fetchRawComps: async () => { calls.raw++; return [{ id: "raw-sale", title: "Venusaur Base Set 15/102 Holo NM", price: 150, sold_at: new Date(now - 86400000).toISOString(),
            variant: "Holofoil", currency: "USD", attribution: "exact", sale_type: "fixed_price", listing_url: "https://www.ebay.com/itm/223456789012", grader: null, grade: null, grade_qualifier: null }]; },
        fetchComps: async (_id, options) => { calls.comps++; return gradedSales(options); },
        fetchCachedComps: async () => [],
        compChecks: async () => new Map(), ...extra });
    return { cache, calls, evaluate };
}

test("accepted Jungle No Symbol labels remain reusable and unpriced without ordinary sold requests or replacement photo analysis", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("No Symbol regression must use saved/mocked evidence only"));
    for (const source of ["title", "label"] as const) {
        const listing = details({ id: `v1|jungle-no-symbol-${source}|0`, title: `Jolteon Jungle 4/64 Holo PSA 8${source === "title" ? " No Symbol" : ""}`,
            condition: "Graded", cardCondition: null, images: [photo(1), photo(2)],
            aspects: { "Card Name": "Jolteon", Set: "Jungle", "Card Number": "4/64", Language: "English", Finish: "Holo", "Professional Grader": "PSA", Grade: "8" } });
        const accepted = reading(2); accepted.condition = null; accepted.photoCheck.holder = "GRADED_SLAB";
        accepted.photoCheck.cardIdentity = { name: "Jolteon", set: "Jungle", cardNumber: "4/64", language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Name, number and Jungle label are clear."] };
        accepted.photoCheck.printedName = "Jolteon"; accepted.photoCheck.printedNumber = "4/64";
        accepted.photoCheck.slab = { present: true, grader: "PSA", grade: "8", gradeQualifier: null, certNumber: "12345678",
            labelText: `1999 POKEMON JUNGLE JOLTEON-HOLO #4 NM-MT 8${source === "label" ? " NO SYMBOL" : ""}`,
            caseCondition: "INTACT", authenticity: "NONE_SEEN", authenticityEvidence: [], concerns: [] };
        if (source === "label") accepted.photoCheck.printingMarks = { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT",
            reprintMark: "Label explicitly reads NO SYMBOL.", evidence: ["The card and label indicate the Jungle no-symbol printing."] };
        const { evaluate, cache, calls } = harness({ details: async () => listing,
            assess: async () => assert.fail("accepted compact slab reading must remain reusable"),
            lookup: async () => [{ ...card, name: "Jolteon", setName: "Jungle", cardNumber: "4/64" }],
            fetchComps: async () => assert.fail("ordinary Jungle comps must not price the No Symbol variant"),
            fetchRawComps: async () => assert.fail("No Symbol cannot borrow ordinary raw comps") });
        const plan = boundedAssessmentPlan(listing), stored = { ...accepted, version: plan.version, answeredAt: new Date(now).toISOString() };
        cache.set(plan.key, structuredClone(stored));
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = await evaluate(listing.id);
            assert.equal(result.identity?.status, "IDENTIFIED");
            assert.equal(result.slab?.status, "OK");
            assert.equal(result.slab?.labelText, accepted.photoCheck.slab.labelText);
            assert.deepEqual(result.photoCheck?.printingMarks, accepted.photoCheck.printingMarks);
            assert.equal(result.underwriting?.verdict, "CANT_PRICE");
            assert.equal(result.slabPricing?.status, "PRICE_UNAVAILABLE");
            assert.equal(result.slabPricing?.summary, undefined);
            assert.equal(result.rating, null);
            assert.equal(photoReviewStatus(result).needsYourReview, false);
            assert.equal(resultGroup({ ...listing, currentPrice: listing.price, isGraded: true }, result), "candidates");
            assert.deepEqual(result.usage, []);
        }
        assert.deepEqual(cache.get(plan.key), stored, "the accepted paid answer and its key/version remain intact");
        assert.equal(calls.assessed, 0); assert.equal(calls.comps, 0); assert.equal(calls.raw, 0);
    }
});

test("a missing-texture slab skips automatic review and an explicit review keeps photos without ordinary prices", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("missing-texture regression must remain offline"));
    const listing = details({ title: "POKEMON AERODACTYL V ALT #180/196 LOST ORIGIN PSA 10 MISSING TEXTURE ERROR POP 2",
        condition: "Graded", cardCondition: null, images: [photo(1), photo(2)],
        aspects: { "Card Name": "Aerodactyl V", Set: "Lost Origin", "Card Number": "180/196", Language: "English", Finish: "Holo", "Professional Grader": "PSA", Grade: "10" } });
    const accepted = reading(2);
    accepted.condition = null;
    Object.assign(accepted.photoCheck, { holder: "GRADED_SLAB", printedName: "Aerodactyl V", printedNumber: "180/196",
        cardIdentity: { name: "Aerodactyl V", set: "Lost Origin", cardNumber: "180/196", language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Name and number are visible."] },
        slab: { present: true, grader: "PSA", grade: "10", gradeQualifier: null, certNumber: "12345678", labelText: "AERODACTYL V #180 GEM MT 10",
            caseCondition: "INTACT", authenticity: "NONE_SEEN", authenticityEvidence: [], concerns: [] } });
    let assessments = 0;
    const { evaluate, cache } = harness({ details: async () => listing,
        lookup: async () => [{ ...card, name: "Aerodactyl V (Alternate Full Art)", setName: "Lost Origin", cardNumber: "180/196" }],
        assess: async () => { assessments++; return { result: accepted, usage: { inputTokens: 900, outputTokens: 350 } }; },
        fetchComps: async () => assert.fail("explicit review cannot borrow ordinary PSA 10 prices") });
    const automatic = await evaluate(listing.id, { automatic: true });
    assert.equal(automatic.photoCheck, null);
    assert.equal(assessments, 0);

    const reviewed = await evaluate(listing.id);
    assert.equal(reviewed.slab?.status, "OK");
    assert.equal(reviewed.underwriting?.verdict, "CANT_PRICE");
    assert.equal(reviewed.slabPricing?.status, "PRICE_UNAVAILABLE");
    assert.match(reviewed.slabPricing?.reason ?? "", /missing.texture/i);

    // Simulate a previously saved financial snapshot with ordinary resale prices.
    const key = [...cache.keys()].find(value => value.startsWith(PRIVATE_EVALUATION_PREFIX))!;
    const saved = cache.get(key);
    saved.evaluation.pricesCheckedAt = new Date(now).toISOString();
    saved.evaluation.slabPricing = { ...reviewed.slabPricing, status: "PRICED", summary: salesSummary("PSA", "10", [300, 310, 320]) };
    const replay = await evaluate(listing.id);
    assert.equal(replay.slabPricing?.status, "PRICE_UNAVAILABLE");
    assert.equal(replay.slabPricing?.summary, undefined);
    assert.equal(replay.underwriting?.verdict, "CANT_PRICE");
    assert.deepEqual(replay.photoCheck, reviewed.photoCheck);
    assert.equal(assessments, 1, "the original photo assessment remains reusable");
});

test("raw BIN discovery reaches Blastoise titles missing the year and edition, then prices physical condition before showing a Deal", async t => {
    const transport = t.mock.method(globalThis, "fetch", () => assert.fail("this replay uses fixture providers only"));
    const query = "1999 Base Set Blastoise 2/102 Unlimited Holo";
    const intent = readSearchLocally(query);
    const targets = { minProfit: 0, minRoi: 0 };
    const filters = { typeFilter: "FIXED_PRICE", kindFilter: "raw" } as const;
    // The $75 title and terms reproduced the discovery gap. Condition and comparable
    // sales here are controlled fixtures, so this does not appraise that actual card.
    const titles = ["Blastoise Base Set Holo 2/102 Moderate Play Free Shipping",
        "Blastoise Base Set 2/102 Holo", "Blastoise Base Set 2/102 Holo First Edition"];
    const source: ListingSummary[] = titles.map((title, index) => ({
        id: `offline-blastoise-${index}`, title, images: [photo(20 + index * 2), photo(21 + index * 2)],
        currentPrice: index === 0 ? 75 : 50, shipping: index === 0 ? 0 : 5, seller: null,
        buyingOption: "FIXED_PRICE", isGraded: false, bids: 0, endTime: null, url: "#",
    }));
    const catalog: CardRecord = { ...card, name: "Blastoise", cardNumber: "2/102" };
    const sales: Comp[] = [["MP", 122], ["HP", 70]].map(([claim, price], index) => ({
        id: String(index), title: `Blastoise Base Set 2/102 Unlimited Holo ${claim}`, price: Number(price),
        variant: "Holofoil", grader: null, grade: null, currency: "USD", attribution: "exact",
        sale_type: "fixed_price", sold_at: new Date(now - (index + 1) * 86400000).toISOString(),
    }));
    const market = { lookupCards: async () => [catalog], fetchRawComps: async () => sales, fetchComps: async () => [] };
    const checked: string[] = [];
    const { evaluate } = harness({ lookup: market.lookupCards, fetchRawComps: market.fetchRawComps, fetchComps: market.fetchComps,
        details: async id => {
            const row = source.find(value => value.id === id)!;
            return details({ id, title: row.title, price: row.currentPrice, shipping: row.shipping, images: row.images,
                aspects: { "Card Name": "Blastoise", Set: "Base Set", "Card Number": "2/102", Language: "English", Finish: "Holo" } });
        },
        assess: async (item, photos) => {
            checked.push(item.id);
            const answer = reading(photos.length);
            answer.photoCheck.printedName = "Blastoise"; answer.photoCheck.printedNumber = "2/102";
            Object.assign(answer.photoCheck.cardIdentity!, { name: "Blastoise", cardNumber: "2/102" });
            answer.condition!.rawCondition = item.id === source[0].id ? "HEAVILY_PLAYED" : "LIGHTLY_PLAYED";
            answer.condition!.gradeRange = null;
            return { result: answer, usage: { inputTokens: 500, outputTokens: 250 } };
        },
        soldCondition: () => ({ usage: [], status: () => "REVIEWED", acquire: async () => assert.fail("saved sold photos are sufficient"),
            read: async sale => ({ condition: sale.id === "0" ? "MODERATELY_PLAYED" : "HEAVILY_PLAYED",
                evidence: ["Front and back show wear consistent with the saved physical assessment."], photoCount: 2 }),
        }),
    });
    const run = async () => {
        const rejected: string[] = [];
        const rows = await findDeals(query, { filters, targets, asOf: now, automaticPhotos: true,
            onSourceDisposition: row => rejected.push(row.reason) }, {
            readIntent: async () => intent, readTitle: async title => readTitleByRules(title),
            soldScreening: options => createSoldScreening({ ...options, source: market }),
            search: async keywords => {
                const words = keywords.toLowerCase().split(/\s+/);
                const listings = source.filter(row => words.every(word => row.title.toLowerCase().includes(word)));
                return { listings, total: listings.length, rejections: [], skipped: 0 };
            },
        });
        assert.deepEqual(rejected, ["OTHER_PRINTING"]);
        assert.deepEqual(new Set(rows.filter(canAutoAnalyze).map(row => row.id)), new Set(source.slice(0, 2).map(row => row.id)));
        const analyses: Record<string, AnalysisState> = {};
        for (const row of rows.filter(canAutoAnalyze)) {
            const evaluation = await evaluate(row.id, { automatic: true, targets });
            analyses[row.id] = { status: "done", evaluation, evidenceKey: listingEvidenceKey(row) };
        }
        const visible = filterSearchResults({ listings: rows, analyses, page: "search", intent, now,
            filters: { ...filters, minPrice: "", maxPrice: "", minGrade: 0 } });
        const grouped = groupSearchResults(visible, analyses, false, new Set());
        assert.deepEqual(grouped.deals.map(row => row.id), [source[1].id]);
        assert.deepEqual(grouped.losses.map(row => row.id), [source[0].id]);
        const win = analyses[source[1].id].evaluation.underwriting!.best!;
        assert.equal(win.priceCondition, "MODERATELY_PLAYED");
        assert.equal(win.salePrice, 122);
        assert.equal(win.profit, 38.14);
        assert.equal(analyses[source[0].id].evaluation.underwriting!.best!.profit, -27.87);
        return Object.values(analyses).flatMap(value => value.evaluation.usage);
    };
    assert.ok((await run()).length > 0);
    assert.deepEqual(await run(), []);
    assert.equal(checked.length, 2);
    assert.equal(transport.mock.callCount(), 0);
});

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
    assert.equal(result.rawPricing?.status, "PRICE_UNAVAILABLE");
    assert.equal(result.rawPricing?.prices?.length ?? 0, 0, "unverified raw sold conditions cannot become an eBay price");
    assert.equal(result.gradedPricing?.PSA?.status, "PRICED");
    assert.equal(result.gradedPricing?.CGC?.status, "PRICED");
    assert.ok(result.underwriting?.paths.some(path => path.status === "PRICED"));
    assert.equal(result.usage.length, 1);
    assert.equal(result.photoReviewKey, undefined, "a bounded answer cannot authorize the legacy full-record deeper endpoint");
});

test("a focused release mark overrides a confident original-set reading before buying comparisons", async () => {
    for (const mark of ["PIKACHU_25", "OTHER_MARK", "UNCLEAR"] as const) {
        const { evaluate, calls } = harness({ release: async e => {
            clearReleaseFixture(e);
            return { ...e, releaseMark: { ...e.releaseMark!, mark, observation: "Focused observation from the original front." } };
        } });
        const e = await evaluate("v1|release-fixture|0");
        assert.equal(e.identity?.status, "NEEDS_REVIEW");
        assert.equal(e.underwriting?.best, null);
        assert.equal(e.rawPricing, null);
        assert.equal(calls.raw + calls.comps, 0);
        if (mark === "PIKACHU_25") {
            assert.equal(e.identity?.set, "Celebrations: Classic Collection");
            assert.equal(e.photoCheck?.printingMarks?.reprintMark, "CELEBRATIONS_25TH");
            assert.match(e.identity?.notThisCard ?? "", /Photo 1.*2021 Celebrations/);
        }
        if (mark === "UNCLEAR") assert.ok(!e.identity?.notThisCard);
    }
});

test("a corroborated wrong collector number stops after the first photographed front and keeps the search exclusion", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("this mismatch replay must be offline"));
    const item = details({ title: "Pikachu ex 238/191 Surging Sparks Special Illustration Rare", bestOffer: false, images: [photo(1), photo(2)],
        aspects: { "Card Name": "Pikachu ex", Set: "Surging Sparks", "Card Number": "238/191", Language: "English" } });
    const first = reading(1);
    const check = first.photoCheck;
    check.cardIdentity = { name: "Pikachu ex", set: "Perfect Order", cardNumber: "150/128", language: "English",
        confidence: "HIGH", finish: "HOLO", evidence: ["The printed number 150/128 is legible."] };
    Object.assign(check, { printedName: "Pikachu ex", printedNumber: "150/128", holder: "SLEEVE",
        cardMatch: { verdict: "MISMATCH", problems: ["The card shows 150/128 but the listing claims 238/191."] } });
    check.images[0].obscuresCondition = true;
    for (const label of ["corroborated", "low confidence", "partial printed number", "partial seller number", "ambiguous title", "unnumbered title",
        "wrong seller field", "stock image", "multiple cards", "additional listing photos"]) {
        const listing = structuredClone(item), front = structuredClone(first);
        if (label === "low confidence") front.photoCheck.cardIdentity!.confidence = "LOW";
        if (label === "partial printed number") front.photoCheck.printedNumber = "150";
        if (label === "partial seller number") listing.aspects["Card Number"] = "238";
        if (label === "ambiguous title") listing.title += " or #150/128";
        if (label === "unnumbered title") listing.title = "Pikachu ex Surging Sparks";
        if (label === "wrong seller field") listing.aspects["Card Number"] = "150/128";
        if (label === "stock image") front.photoCheck.images[0].isStockImage = true;
        if (label === "multiple cards") { front.photoCheck.cardCount = "MULTIPLE"; front.condition = null; }
        if (label === "additional listing photos") listing.images.push(photo(3));
        const stages: string[] = [];
        const { evaluate } = harness({ details: async () => listing, assess: async (_listing, photos, _signal, _mode, stage) => {
            stages.push(stage?.kind ?? "gallery");
            const result = structuredClone(front);
            if (stage?.kind !== "front") result.photoCheck.images = photos.map((_, index) => ({ ...front.photoCheck.images[0], number: index + 1, view: "BACK" }));
            return { result, usage: { inputTokens: 500, outputTokens: 300 } };
        } });
        const result = await evaluate(listing.id, { automatic: true });
        if (label !== "corroborated") { assert.deepEqual(stages, ["front", "remainder"], label); continue; }
        assert.deepEqual(stages, ["front"]);
        assert.equal(result.listing.photosAnalyzed, 1);
        assert.ok(result.identity?.notThisCard?.includes("150/128"));
        assert.equal(result.underwriting?.best, null);
        const summary = { ...listing, currentPrice: listing.price, isGraded: false };
        const analyses = { [listing.id]: { status: "done" as const, evaluation: result, evidenceKey: listingEvidenceKey(summary) } };
        const groups = groupSearchResults([], analyses, false, new Set());
        assert.equal(searchDiagnosticRows([summary], analyses, groups, () => null, "NOT_ASSESSED")[0].reason, "CRITERIA_MISMATCH");
        await evaluate(listing.id, { automatic: true });
        assert.deepEqual(stages, ["front"], "a replay reuses accepted first-photo evidence");
    }
});

test("an exact overpriced slab stops after its front photo and reuses that reading after a price drop", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("staged assessment regression must use mocked providers only"));
    const listing = details({ price: 450, shipping: 4, bestOffer: false, condition: "Graded",
        retrievedAt: new Date(now - 1000).toISOString(),
        aspects: { ...details().aspects, "Professional Grader": "PSA", Grade: "8" } });
    const batches: number[][] = [];
    const { evaluate } = harness({ details: async () => ({ ...listing }), assess: async (_listing, photos, _signal, _mode, stage) => {
        batches.push(photos.map(photo => photo.number));
        assert.equal(stage?.kind, photos[0].number === 1 ? "front" : "remainder");
        const answer = reading(photos.length);
        answer.condition = null;
        answer.photoCheck.holder = "GRADED_SLAB";
        answer.photoCheck.slab = { present: true, grader: "PSA", grade: "8", gradeQualifier: null, certNumber: "12345678",
            labelText: "1999 POKEMON GAME VENUSAUR-HOLO #15 NM-MT 8", caseCondition: "INTACT", authenticity: "NONE_SEEN",
            authenticityEvidence: [], concerns: [] };
        answer.photoCheck.images.forEach((image, index) => { image.view = photos[index].number === 1 ? "FRONT" : "BACK"; });
        return { result: answer, usage: { inputTokens: 500, outputTokens: 300 } };
    }, fetchRawComps: async () => assert.fail("a verified slab never needs raw resale research"),
    fetchComps: async (_id, { grader, grade }) => [260, 275, 280, 650, 1200].map((price, index) => ({
        id: `slab-${index}`, title: `Venusaur Base Set 15/102 Holo ${grader} ${grade}`,
        price, sold_at: new Date(now - (index + 1) * 86400000).toISOString(), variant: "Holofoil", currency: "USD",
        attribution: "exact", sale_type: "fixed_price", listing_url: null, grader, grade: String(grade), grade_qualifier: null,
    })) });
    const targets = { minProfit: 0, minRoi: 0 };
    const expensive = await evaluate(listing.id, { automatic: true, targets });
    assert.deepEqual(batches, [[1]], "a single high sale cannot justify another photo");
    assert.equal(expensive.slabPricing?.summary?.high, 650, "the highest retained amount would have made it look viable");
    assert.equal(expensive.slabPricing?.summary?.dropped["price far from the other sales"], 1);
    assert.deepEqual(expensive.photoCheck?.images.map(image => image.number), [1]);
    assert.equal(expensive.listing.photosAnalyzed, 1);
    assert.equal(expensive.frontPhotoStop, "SLAB_PRICE");
    assert.equal(expensive.underwriting?.verdict, "PASS");
    assert.ok((expensive.underwriting?.best?.profit ?? 0) < 0);
    assert.equal(resultGroup({ ...listing, currentPrice: listing.price, isGraded: true }, retargetEvaluation(expensive, targets)), null);
    assert.equal(photoReviewStatus(expensive).title, "Assessment stopped after the front photo");
    assert.equal(photoReviewStatus(expensive).needsYourReview, false);
    assert.deepEqual(expensive.usage.map(usage => usage.step), ["frontPhotoAssessment"]);

    listing.price = 25;
    const locallyRepriced = retargetEvaluation({ ...expensive, listing: { ...expensive.listing, price: listing.price } }, targets);
    assert.equal(locallyRepriced.underwriting?.verdict, "CANT_PRICE", "lower terms cannot make a front-only report a Deal");
    const cheaper = await evaluate(listing.id, { automatic: true, targets });
    assert.deepEqual(batches, [[1], [2]], "a price change can make a back photo useful without repeating the front");
    assert.deepEqual(cheaper.photoCheck?.images.map(image => image.number), [1, 2]);
    assert.equal(cheaper.underwriting?.verdict, "BUY_GRADED");
    assert.deepEqual(cheaper.usage.map(usage => usage.step), ["remainingPhotoAssessment"]);
});

test("visible wear on a raw front keeps remaining photos eligible when grading value is unresolved", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("staged assessment regression must use mocked providers only"));
    const listing = details({ bestOffer: false, retrievedAt: new Date(now - 1000).toISOString() });
    const batches: number[][] = [];
    const { evaluate } = harness({ details: async () => ({ ...listing }), assess: async (_listing, photos, _signal, _mode, stage) => {
        batches.push(photos.map(photo => photo.number));
        if (stage?.kind === "remainder") {
            assert.equal(stage.front.photoCheck.images.length, 1);
            assert.equal(stage.front.condition?.surface.observations[0], "Visible holo scratches on the front.");
        }
        const answer = reading(photos.length);
        answer.condition!.rawCondition = "LIGHTLY_PLAYED";
        answer.condition!.surface.severity = "MINOR";
        answer.condition!.surface.observations = ["Visible holo scratches on the front."];
        if (photos.length === 1) answer.condition!.gradeRange = null;
        const views = ["FRONT", "BACK", "FRONT_DETAIL", "BACK_DETAIL"] as const;
        answer.photoCheck.images.forEach((image, index) => { image.view = views[photos[index].number - 1]; });
        return { result: answer, usage: { inputTokens: 500, outputTokens: 300 } };
    } });
    const result = await evaluate(listing.id, { automatic: true });
    assert.deepEqual(batches, [[1], [2, 3, 4]]);
    assert.deepEqual(result.photoCheck?.images.map(image => image.number), [1, 2, 3, 4]);
    assert.equal(result.listing.photosAnalyzed, 4);
    assert.equal(result.identity?.status, "IDENTIFIED");
    assert.equal(result.underwriting?.verdict, "BUY_AND_GRADE");
    assert.deepEqual(result.usage.map(usage => usage.step), ["frontPhotoAssessment", "remainingPhotoAssessment"]);
    const reused = await evaluate(listing.id, { automatic: true });
    assert.equal(reused.usage.length, 0);
    assert.deepEqual(batches, [[1], [2, 3, 4]], "the completed assessment is reused before dispatching either stage");
});

test("an uncertain front cannot erase a visible reprint in a saved later photo", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("reprint regression must remain offline"));
    const listing = details({ bestOffer: false, images: [photo(1), photo(2)], retrievedAt: new Date(now - 1000).toISOString() });
    const front = reading(1), rest = reading(1);
    front.photoCheck.printingMarks!.reprintMark = "Possible set symbol, but this area is cropped.";
    rest.photoCheck.printingMarks!.reprintMark = "Base Set 2 symbol visible under the artwork";
    rest.photoCheck.images[0].view = "FRONT_DETAIL";
    const plan = boundedAssessmentPlan(listing);
    const stages = [[stagedPhotoPlan(listing, plan, "front"), front], [stagedPhotoPlan(listing, plan, "remainder", front), rest]] as const;
    const { evaluate, cache, calls } = harness({ details: async () => listing,
        assess: async () => assert.fail("both original photo stages have accepted evidence"),
        fetchComps: async () => assert.fail("a visible reprint must not request original graded prices"),
        fetchRawComps: async () => assert.fail("a visible reprint must not request original raw prices") });
    for (const [stage, answer] of stages) cache.set(stage.key, { ...structuredClone(answer), version: stage.version, answeredAt: new Date(now).toISOString() });
    const result = await evaluate(listing.id, { automatic: true });
    assert.equal(result.photoCheck?.printingMarks?.reprintMark, rest.photoCheck.printingMarks!.reprintMark);
    assert.match(result.identity?.notThisCard ?? "", /Base Set 2/);
    assert.equal(result.underwriting?.verdict, "NEEDS_REVIEW");
    assert.deepEqual(result.usage, []);
    assert.equal(calls.assessed, 0);
    for (const [stage, answer] of stages) assert.deepEqual(cache.get(stage.key).photoCheck, answer.photoCheck);
});

test("a fresh saved Deal with a clear reprint observation is corrected without repurchasing evidence", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("checkpoint correction must remain offline"));
    const listing = details();
    const { evaluate, cache, calls } = harness({ details: async () => listing });
    const before = await evaluate(listing.id);
    assert.equal(before.underwriting?.verdict, "BUY_AND_GRADE");
    const checkpoint = [...cache.entries()].find(([key]) => key.startsWith(PRIVATE_EVALUATION_PREFIX))![1];
    const observation = "A Pikachu 25th anniversary logo is visible below the artwork.";
    checkpoint.evaluation.photoCheck.printingMarks.reprintMark = observation;
    const counts = [calls.assessed, calls.comps, calls.raw];
    const result = await evaluate(listing.id);
    assert.equal(result.photoCheck?.printingMarks?.reprintMark, observation);
    assert.match(result.identity?.notThisCard ?? "", /Celebrations/);
    assert.equal(result.underwriting?.verdict, "NEEDS_REVIEW");
    assert.equal(result.rawPricing, null);
    assert.equal(result.gradedPricing, null);
    assert.equal(result.slabPricing, null);
    assert.equal(result.reusedSteps.includes("savedEvaluation"), true);
    assert.deepEqual(result.usage, []);
    assert.deepEqual([calls.assessed, calls.comps, calls.raw], counts);
});

test("a single card in a later photo cannot override multiple cards seen in the first photo", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("staged photo regression must remain offline"));
    for (const firstView of ["FRONT", "OTHER"] as const) {
        const listing = details({ bestOffer: false, images: [photo(1), photo(2)] });
        const batches: number[][] = [];
        const { evaluate } = harness({ details: async () => listing,
            assess: async (_listing, photos, _signal, _mode, stage) => {
                batches.push(photos.map(photo => photo.number));
                const answer = reading(photos.length);
                if (stage?.kind === "front") {
                    answer.photoCheck.cardCount = "MULTIPLE";
                    answer.photoCheck.images[0].view = firstView;
                } else answer.photoCheck.images[0].view = "BACK";
                return { result: answer, usage: { inputTokens: 500, outputTokens: 300 } };
            },
            lookup: async () => assert.fail("a listing showing multiple cards must not start single-card market research"),
        });
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = await evaluate(listing.id, { automatic: true });
            assert.equal(result.photoCheck?.cardCount, "MULTIPLE");
            assert.equal(result.condition, null);
            assert.equal(result.identity, null);
            assert.equal(result.underwriting?.verdict, "NEEDS_REVIEW");
        }
        assert.deepEqual(batches, [[1], [2]], "a repeat evaluation reuses both paid stages");
    }
});

test("a front/back composite can recover a cached multiple-card decision while a lot stays blocked", async () => {
    // JPEG panels are resized versions of the separate seller photos. Fine lines
    // make inconsistent decoder downsampling visible, as on the real Mewtwo.
    const side = async (offset: number) => {
        const pixels = Buffer.alloc(375 * 500 * 3);
        for (let y = 0; y < 500; y++) for (let x = 0; x < 375; x++) {
            const value = (Math.floor(x / 8) + Math.floor(y / 8) + offset) % 2 ? 50 : 210;
            pixels.fill(value, (y * 375 + x) * 3, (y * 375 + x + 1) * 3);
        }
        return sharp(pixels, { raw: { width: 375, height: 500, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
    };
    const [front, back] = await Promise.all([side(0), side(1)]);
    const panels = await Promise.all([front, back].map(image => sharp(image).resize(250, 333, { fit: "fill" }).toBuffer()));
    const overview = await sharp({ create: { width: 500, height: 333, channels: 3, background: "black" } })
        .composite(panels.map((input, i) => ({ input, left: i * 250, top: 0 }))).jpeg({ quality: 92 }).toBuffer();
    assert.equal(await matchesFrontBackComposite([overview, front, back]), true);
    assert.equal(await matchesFrontBackComposite([overview, front, front]), false);
    const listing = details({ bestOffer: false, images: [photo(1), photo(2), photo(3)] });
    let compared = 0, paid = 0;
    const { evaluate } = harness({ details: async () => listing,
        assess: async (_listing, photos, _signal, _mode, stage) => {
            paid++;
            const answer = reading(photos.length);
            if (stage?.kind === "front") {
                answer.photoCheck.cardCount = "MULTIPLE";
                answer.photoCheck.images[0].view = "OTHER";
            }
            return { result: answer, usage: { inputTokens: 500, outputTokens: 300 } };
        },
        checkComposite: async () => ++compared === 1 ? null : matchesFrontBackComposite([overview, back, front]),
    });
    assert.equal((await evaluate(listing.id)).photoCheck?.cardCount, "MULTIPLE");
    assert.equal((await evaluate(listing.id)).photoCheck?.cardCount, "ONE");
    assert.equal(compared, 2);
    assert.equal(paid, 2, "recovering a previously blocked overview reuses the same two assessments");
    listing.title += " lot of 2 cards";
    assert.equal((await evaluate(listing.id)).photoCheck?.cardCount, "MULTIPLE");
    assert.equal(compared, 2, "seller's explicit lot is ineligible for composite recovery");
});

test("direct evaluation cannot price a seller's reverse holo when a clear front shows non-holo", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("finish mismatch regression must remain offline"));
    const listing = details({ id: "v1|conflicting-finish|0", title: "Primeape Aquapolis 29/147 Reverse Holo English",
        aspects: { "Card Name": "Primeape", Set: "Aquapolis", "Card Number": "29/147", Language: "English", Finish: "Reverse Holo" } });
    const answer = reading();
    answer.photoCheck.printedName = "Primeape";
    answer.photoCheck.printedNumber = "29/147";
    answer.photoCheck.cardIdentity = { name: "Primeape", set: "Aquapolis", cardNumber: "29/147", finish: "NON_HOLO",
        language: "English", confidence: "HIGH", evidence: ["The front is readable and shows the regular finish."] };
    const { evaluate } = harness({ details: async () => listing,
        assess: async () => ({ result: answer, usage: { inputTokens: 500, outputTokens: 300 } }),
        lookup: async () => [{ ...card, name: "Primeape", setName: "Aquapolis", cardNumber: "29/147", variants: [
            { name: "Reverse Holofoil", finish: "REVERSE_HOLO", printing: "UNLIMITED" },
            { name: "Normal", finish: "NON_HOLO", printing: "UNLIMITED" },
        ] }],
        fetchComps: async () => assert.fail("the contradicted finish must not request graded prices"),
        fetchRawComps: async () => assert.fail("the contradicted finish must not request raw prices"),
    });
    const result = await evaluate(listing.id);
    assert.equal(result.photoCheck?.cardIdentity?.finish, "NON_HOLO");
    assert.equal(result.listing.aspects.Finish, "Reverse Holo");
    assert.equal(result.identity?.finish, "CONFLICTING");
    assert.equal(result.underwriting?.verdict, "NEEDS_REVIEW");
    assert.match(result.underwriting?.reasons.join(" ") ?? "", /photo shows non holo\. the listing title says reverse holo/i);
    assert.doesNotMatch(result.underwriting!.reasons.join(" "), /slab label/i);
    assert.equal(result.rawPricing, null);
    assert.equal(result.gradedPricing, null);

    const saved = { ...result, pricesCheckedAt: new Date(now).toISOString(), rawPricing: cardEvaluation().rawPricing,
        identity: { ...result.identity!, status: "IDENTIFIED" as const, printing: "UNLIMITED" as const, finish: "REVERSE_HOLO" } };
    assert.equal(currentPriceEvidence(saved, now), false);
    assert.equal(retargetEvaluation(saved, { minProfit: 0, minRoi: 0 }).underwriting?.verdict, "NEEDS_REVIEW");
    saved.identity.finish = "NON_HOLO";
    assert.equal(currentPriceEvidence(saved, now), true, "the photo safeguard does not expire otherwise current matching evidence");
});

test("exact structured photo identity can reject a wrongly matched listing without replacing saved photos", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("identity consistency regression must remain offline"));
    for (const change of [{ name: "Charizard", cardNumber: "4/102" }, { set: "Base Set 2" }, { cardNumber: "15/130" }]) {
        const listing = details(), answer = reading();
        answer.photoCheck.printedNumber = null;
        Object.assign(answer.photoCheck.cardIdentity!, change);
        const { evaluate, cache } = harness({ details: async () => listing,
            assess: async () => assert.fail("the saved photos are sufficient to reject the claimed identity"),
            lookup: async () => assert.fail("a definite photo mismatch needs no catalog or sold research"),
        });
        const plan = boundedAssessmentPlan(listing), checkedAt = new Date(now - 1000).toISOString();
        cache.set(plan.key, { ...answer, version: plan.version, answeredAt: checkedAt });
        const previous = cardEvaluation();
        Object.assign(previous, { photoCheck: answer.photoCheck, assessmentVersion: plan.version, conditionVersion: plan.conditionVersion,
            pricingVersion: PRICING_VERSION, pricesCheckedAt: checkedAt, answeredAt: checkedAt });
        previous.listing = { ...previous.listing, ...listing, photos: listing.images };
        const store = createPrivateEvaluationStore({ cached: async key => cache.get(key) ?? null, save: async (key, value) => { cache.set(key, value); } });
        await store.save(previous, { evidenceKey: listingEvidenceKey(listing), contextKey: evaluationContextKey(listing) });
        assert.equal(currentPriceEvidence(previous, now), true);
        const result = await evaluate(listing.id);
        assert.match(result.identity?.notThisCard ?? "", /the photos show/);
        assert.equal(result.identity?.status, "NEEDS_REVIEW");
        assert.equal(result.rawPricing, null);
        assert.equal(result.gradedPricing, null);
        assert.deepEqual(result.usage, []);
    }
});

test("a completed previous photo pair survives the new grading request without a paid reread", async () => {
    const listing = details({ bestOffer: false, images: [photo(1), photo(2)] });
    const previous = compatibleBoundedPlans(listing).find(plan => plan.version.endsWith("/bounded-prompts-2"))!;
    const front = reading(1);
    front.condition!.gradeRange = null;
    const remainder = reading(1);
    remainder.photoCheck.images[0].view = "BACK";
    remainder.condition!.gradeRange = null;
    const { evaluate, cache } = harness({ details: async () => listing,
        assess: async () => assert.fail("both previously purchased photo stages must be reused") });
    const answeredAt = new Date(now).toISOString();
    const stages = [[stagedPhotoPlan(listing, previous, "front"), front],
        [stagedPhotoPlan(listing, previous, "remainder", front), remainder]] as const;
    for (const [plan, answer] of stages) cache.set(plan.key, { ...answer, version: plan.version, answeredAt });

    const result = await evaluate(listing.id);
    assert.equal(result.assessmentVersion, previous.version);
    assert.deepEqual(result.reusedSteps, ["frontPhotoAssessment", "remainingPhotoAssessment"]);
    assert.equal(displayedRawGrade(result)?.source, "WEAR");
});

test("a clean rear cannot erase a severe front mark or supply a conflicting high grade", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("staged assessment regression must use mocked providers only"));
    const listing = details({ price: 150, bestOffer: false, images: [photo(1), photo(2)],
        retrievedAt: new Date(now - 1000).toISOString() });
    const batches: number[][] = [];
    const observation = "Permanent black marker covers part of the holo artwork.";
    let sales: Comp[] = [];
    const { evaluate, cache, calls } = harness({ details: async () => listing, fetchRawComps: async () => sales,
        assess: async (_listing, photos) => {
            batches.push(photos.map(photo => photo.number));
            const answer = reading(1);
            if (photos[0].number === 1) {
                answer.condition!.rawCondition = "DAMAGED";
                answer.condition!.gradeRange = null;
                answer.condition!.surface = { visibility: "CLEAR", severity: "SEVERE", observations: [observation] };
            } else {
                answer.photoCheck.images[0].view = "BACK";
                answer.condition!.rawCondition = "NEAR_MINT";
                answer.condition!.gradeRange = { low: 8, likely: 9, high: 10 };
            }
            return { result: answer, usage: { inputTokens: 500, outputTokens: 300 } };
        },
    });
    sales = seedRawSoldCopies(cache, listing, "DAMAGED", 45, now);
    const result = await evaluate(listing.id, { automatic: true });
    assert.deepEqual(batches, [[1], [2]]);
    assert.equal(result.condition?.rawCondition, "DAMAGED");
    assert.equal(result.condition?.gradeRange, null);
    assert.deepEqual(result.condition?.surface.observations, [observation]);
    assert.equal(calls.comps, 1, "the first plausible grade reference is enough to inspect the back; the contradictory rear range is never priced");
    assert.equal(result.underwriting?.verdict, "PASS");
    assert.equal(result.underwriting?.best?.priceCondition, "DAMAGED");
});

test("visible material front wear with losing matched markets skips the remaining photos", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("staged assessment regression must use mocked providers only"));
    for (const defect of ["crease", "black marker", "holo scratches"] as const) {
        const listing = details({ price: 750, bestOffer: true, images: [photo(1), photo(2)],
            retrievedAt: new Date(now - 1000).toISOString() });
        const category = defect === "holo scratches" ? "HEAVILY_PLAYED" : "DAMAGED";
        const batches: number[][] = [];
        let sales: Comp[] = [];
        const { evaluate, cache, calls } = harness({ details: async () => listing, fetchRawComps: async () => sales,
            assess: async (_listing, photos) => {
                batches.push(photos.map(photo => photo.number));
                const answer = reading(1);
                if (photos[0].number === 1) {
                    answer.condition!.rawCondition = defect === "crease" ? "MODERATELY_PLAYED" : category;
                    answer.condition!.creases = defect === "crease" ? "PRESENT" : "NONE_SEEN";
                    answer.condition!.surface = { visibility: "CLEAR", severity: "SEVERE", observations: [`Visible ${defect} on the lower front artwork.`] };
                } else {
                    answer.photoCheck.images[0].view = "BACK";
                    answer.condition!.rawCondition = category;
                    answer.condition!.gradeRange = null;
                }
                return { result: answer, usage: { inputTokens: 500, outputTokens: 300 } };
            },
        });
        sales = seedRawSoldCopies(cache, listing, category, 45, now);
        const targets = { minProfit: 0, minRoi: 0 };
        const loss = await evaluate(listing.id, { automatic: true, targets });
        assert.deepEqual(batches, [[1]], defect);
        assert.equal(calls.comps, 2);
        assert.equal(loss.frontPhotoStop, "RAW_PRICE");
        assert.equal(loss.underwriting?.verdict, "PASS");
        assert.ok((loss.underwriting?.best?.profit ?? 0) < 0);
        assert.equal(loss.underwriting?.best?.priceCondition, category);
        assert.equal(photoReviewStatus(loss).needsYourReview, false);
        assert.equal(loss.condition?.gradeRange, null);
        const summary = { ...listing, currentPrice: listing.price, isGraded: false };
        const groups = groupSearchResults([summary], { [listing.id]: { status: "done", evaluation: loss, evidenceKey: "" } }, true, new Set());
        assert.deepEqual(groups.losses, [summary]);
        assert.equal(groups.offers.length + groups.deals.length + groups.review.length, 0);
        listing.price = 350;
        const repriced = retargetEvaluation({ ...loss, listing: { ...loss.listing, price: listing.price } }, targets);
        assert.equal(repriced.underwriting?.verdict, "CANT_PRICE", "a realistic offer reopens a front-only loss");
        await evaluate(listing.id, { automatic: true, targets });
        assert.deepEqual(batches, [[1], [2]], "reopens without sending the first photo again");
    }
});

test("a denied optional front comparison cannot discredit the later complete raw valuation", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("staged assessment regression must use mocked providers only"));
    const listing = details({ price: 750, bestOffer: false, images: [photo(1), photo(2)], retrievedAt: new Date(now - 1000).toISOString() });
    const answer = reading(1);
    answer.condition!.rawCondition = "DAMAGED";
    answer.condition!.creases = "PRESENT";
    answer.condition!.gradeRange = null;
    let rawReads = 0, sold: Comp[] = [];
    const { evaluate, cache } = harness({
        details: async () => listing,
        assess: async (_listing, photos) => {
            const result = structuredClone(answer);
            if (photos[0].number === 2) result.photoCheck.images[0].view = "BACK";
            return { result, usage: { inputTokens: 500, outputTokens: 300 } };
        },
        fetchRawComps: async () => { rawReads++; return sold; },
        fetchComps: async () => { throw new PriceResearchBudgetError("Optional reference not available.", "LIMIT"); },
    });
    sold = seedRawSoldCopies(cache, listing, "DAMAGED", 45, now);
    const evaluated = await evaluate(listing.id, { automatic: true });
    assert.equal(evaluated.listing.photosAnalyzed, 2);
    assert.equal(rawReads, 1, "reuse the already verified exact raw market");
    assert.equal(evaluated.pricingDeferred, undefined);
    assert.equal(evaluated.underwriting?.verdict, "PASS");
});

test("a saved combined assessment bypasses both photo stages", async () => {
    const listing = details({ bestOffer: false, retrievedAt: new Date(now - 1000).toISOString() });
    const { evaluate, cache } = harness({ details: async () => listing,
        assess: async () => assert.fail("accepted photos must bypass both paid stages") });
    cache.set(boundedAssessmentKey(listing), { ...reading(), version: BOUNDED_ASSESSMENT_VERSION,
        answeredAt: new Date(now - 2000).toISOString(), usage: { inputTokens: 700, outputTokens: 500 } });
    const result = await evaluate(listing.id, { automatic: true });
    assert.equal(result.listing.photosAnalyzed, 4);
    assert.ok(result.reusedSteps.includes("boundedPhotoAssessment"));
    assert.deepEqual(result.usage, []);
});

test("Stop keeps the accepted front photo and prevents the remaining paid review", async () => {
    const listing = details({ bestOffer: false, retrievedAt: new Date(now - 1000).toISOString() });
    let started!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const accepted = new Promise<void>(resolve => { release = resolve; });
    const batches: number[][] = [];
    const { evaluate, calls } = harness({ details: async () => ({ ...listing }), assess: async (_listing, photos) => {
        batches.push(photos.map(photo => photo.number));
        if (batches.length === 1) { started(); await accepted; }
        const answer = reading(photos.length);
        const views = ["FRONT", "BACK", "FRONT_DETAIL", "BACK_DETAIL"] as const;
        answer.photoCheck.images.forEach((image, index) => { image.view = views[photos[index].number - 1]; });
        return { result: answer, usage: { inputTokens: 500, outputTokens: 300 } };
    } });
    const stopped = new AbortController();
    const pending = evaluate(listing.id, { automatic: true, signal: stopped.signal });
    await began; stopped.abort(); release();
    await assert.rejects(pending, { name: "AbortError" });
    assert.deepEqual(await drainSharedWork(), { complete: true, pending: 0 });
    assert.deepEqual(batches, [[1]]);
    assert.equal(calls.raw + calls.comps, 0);

    const resumed = await evaluate(listing.id, { automatic: true });
    assert.deepEqual(batches, [[1], [2, 3, 4]]);
    assert.equal(resumed.listing.photosAnalyzed, 4);
    assert.equal(resumed.usage.length, 1);
});

test("insufficient numeric grading detail retains obvious raw damage without inventing a resale price", async t => {
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
        });
        const result = await evaluate("v1|damaged-raw-only|0");
        assert.equal(result.gradingMode, "BLOCKED", "numeric grading remains blocked");
        assert.equal(result.gradeStatus, "RAW_CONDITION_ONLY");
        assert.equal(result.condition?.rawCondition, "DAMAGED");
        assert.equal(result.condition?.gradeRange, null);
        assert.equal(result.underwriting?.verdict, "CANT_PRICE");
        assert.equal(result.underwriting?.best, null);
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
    let sales: Comp[] = [];
    const { evaluate, calls, cache } = harness({ assess: async () => ({ result: report, usage: { inputTokens: 700, outputTokens: 450 } }),
        fetchRawComps: async () => { calls.raw++; return sales; } });
    sales = seedRawSoldCopies(cache, details(), "NEAR_MINT", 220, now);
    const result = await evaluate("v1|near-mint-raw-only|0");
    assert.equal(result.condition?.rawCondition, "NEAR_MINT");
    assert.equal(result.condition?.gradeRange, null);
    assert.equal(result.gradeStatus, "RAW_CONDITION_ONLY");
    assert.equal(result.underwriting?.verdict, "BUY_RAW");
    assert.deepEqual(displayedRawGrade(result), { range: { low: 7, likely: 8, high: 9 }, confidence: "LOW", source: "WEAR" });
    assert.equal(result.rawPricing?.prices?.find(quote => quote.condition === "NEAR_MINT")?.basis, "EBAY_SOLD");
    assert.equal(result.underwriting?.best?.path, "RAW");
    assert.equal(calls.raw, 1);
    assert.equal(calls.comps, 0);
});

for (const limit of ["model", "missing back"]) test(`a low-confidence grade from ${limit} remains visible without grading-price research`, async () => {
    const report = reading();
    if (limit === "model") report.condition!.confidence = "LOW";
    else report.photoCheck.images[1].usable = false;
    const { evaluate, calls } = harness({ assess: async () => ({ result: report, usage: { inputTokens: 700, outputTokens: 450 } }) });
    const result = await evaluate(details().id);
    assert.equal(result.identity?.status, "IDENTIFIED");
    assert.equal(result.condition?.gradeRange, null);
    assert.deepEqual(displayedRawGrade(result), { range: { low: 6, likely: 7, high: 8 }, confidence: "LOW", source: "PROVISIONAL" });
    assert.equal(calls.comps, 0);
    assert.notEqual(result.underwriting?.verdict, "BUY_AND_GRADE");
});

for (const [claim, observed] of [["LP", "LIGHTLY_PLAYED"], ["MP", "MODERATELY_PLAYED"]] as const) test(`a fresh raw resale acquires one ${claim} sold copy and reuses its photo evidence across live listings`, async () => {
    const live = reading(); live.condition!.rawCondition = "LIGHTLY_PLAYED"; live.condition!.gradeRange = null;
    let reviews = 0;
    const { evaluate, calls, cache } = harness({
        assess: async () => { calls.assessed++; return { result: structuredClone(live), usage: { inputTokens: 700, outputTokens: 450 } }; },
        fetchRawComps: async () => [{ id: "sold-venusaur", title: `Venusaur Base Set 15/102 Unlimited Holo ${claim}`, price: 150,
            sold_at: new Date(now - 86400000).toISOString(), variant: "Holofoil", currency: "USD", attribution: "exact",
            sale_type: "fixed_price", listing_url: "https://www.ebay.com/itm/223456789012", grader: null, grade: null, grade_qualifier: null },
            { id: "wrong-newer", title: "Charizard Base Set 4/102 Unlimited Holo LP", price: 999,
                sold_at: new Date(now - 1000).toISOString(), variant: "Holofoil", currency: "USD", attribution: "exact",
                sale_type: "fixed_price", listing_url: "https://www.ebay.com/itm/223456789013", grader: null, grade: null, grade_qualifier: null }],
        soldCondition: options => createSoldConditionAcquirer({ ...options, assess: async ({ identity }) => {
            reviews++;
            const result: SoldConditionReading = { card: { name: identity.name, set: identity.set, cardNumber: identity.cardNumber,
                language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Readable name, number and set artwork"] },
                printing: "UNLIMITED", condition: observed, confidence: "HIGH", oneRawCard: true, frontVisible: true,
                backVisible: true, closeUps: true, structuralDamage: false, evidence: [claim === "LP" ? "Minor whitening on one corner" : "Distinct whitening across several edges and corners"], limitations: [] };
            return { result, usage: { inputTokens: 800, outputTokens: 300 } };
        } }),
    });
    const first = await evaluate("v1|fresh-raw|0");
    assert.equal(first.underwriting?.verdict, "BUY_RAW");
    assert.equal(first.underwriting?.best?.priceCondition, observed);
    assert.equal(first.underwriting?.best?.salePrice, 150);
    const quote = first.rawPricing?.prices?.find(value => value.condition === observed);
    assert.equal(quote?.basis, "EBAY_SOLD"); assert.equal(quote?.comps?.count, 1); assert.equal(quote?.comps?.confidence, "LOW");
    assert.equal(reviews, 1); assert.equal(calls.assessed, 1);
    assert.ok(first.usage.some(value => value.step === "soldConditionAssessment" && value.outputTokens === 300));
    assert.ok([...cache.keys()].some(key => key.startsWith("sold-condition:") && key.includes("bounded-1")));
    const repeated = await evaluate("v1|fresh-raw|0");
    assert.equal(reviews, 1); assert.equal(repeated.usage.length, 0);
    const another = await evaluate("v1|another-raw|0");
    assert.equal(another.underwriting?.verdict, "BUY_RAW");
    assert.equal(reviews, 1, "another live listing must reuse the sold copy's accepted evidence");
    assert.equal(calls.assessed, 1, "equivalent live photos also remain reusable");
});

test("raw sold research gates condition cohorts but selects by recency independently of profit and attempts only one copy", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("sold-research ordering must use mocked providers only"));
    const sale = (id: string, claim: string, price: number, daysAgo: number, name = "Venusaur", number = "15/102"): Comp => ({
        id, title: `${name} Base Set ${number} Unlimited Holo ${claim}`.trim(), price,
        sold_at: new Date(now - daysAgo * 86400000).toISOString(), variant: "Holofoil", currency: "USD", attribution: "exact",
        sale_type: "fixed_price", listing_url: null, grader: null, grade: null, grade_qualifier: null,
    });
    const scenarios: { name: string; sales: Comp[]; expected: string | null; reviewed?: string[]; profitable?: boolean;
        finding: "LIGHTLY_PLAYED" | "MODERATELY_PLAYED" | "NEAR_MINT" | null }[] = [
        { name: "prefer an economically relevant unspecified sale over a lower-condition clue",
            sales: [sale("cheap-lp", "LP", 70, 1), sale("unspecified", "", 200, 2), sale("mp", "MP", 250, 1)], expected: "unspecified", finding: "LIGHTLY_PLAYED" },
        { name: "prefer the newest LP clue over newer unspecified, lower-condition or wrong-card sales",
            sales: [sale("older-lp", "LP", 180, 4), sale("newer-lp", "LP", 190, 3), sale("unspecified", "", 250, 2),
                sale("mp", "MP", 250, 1), sale("wrong-card", "LP", 999, 1, "Charizard", "4/102")], expected: "newer-lp", finding: null },
        { name: "an older profitable LP sale cannot displace a newer losing LP sale",
            sales: [sale("older-lp", "LP", 200, 4), sale("newer-lp", "LP", 70, 3), sale("unspecified", "", 250, 2)],
            expected: "newer-lp", finding: "LIGHTLY_PLAYED", profitable: false },
        { name: "an unspecified cohort also retains its newest losing sale",
            sales: [sale("cheap-lp", "LP", 70, 1), sale("older-unspecified", "", 200, 4), sale("newer-unspecified", "", 70, 3)],
            expected: "newer-unspecified", finding: "LIGHTLY_PLAYED", profitable: false },
        { name: "reviewed LP evidence cannot block the newest unreviewed unspecified candidate",
            sales: [sale("reviewed-lp", "LP", 250, 1), sale("older-unspecified", "", 220, 3), sale("newer-unspecified", "", 200, 2)],
            reviewed: ["reviewed-lp"], expected: "newer-unspecified", finding: "LIGHTLY_PLAYED" },
        { name: "shipping and fees leave no economically relevant candidate",
            sales: [sale("lp", "LP", 70, 1), sale("unspecified", "", 120, 2), sale("mp", "MP", 115, 3)], expected: null, finding: null },
        { name: "a worse sold copy can establish a profitable floor after its photos confirm the condition",
            sales: [sale("mp", "MP", 200, 2), sale("hp", "HP", 250, 1)], expected: "mp", finding: "MODERATELY_PLAYED" },
        { name: "the closest relevant lower condition retains its newest sale even if it loses money",
            sales: [sale("older-mp", "MP", 200, 4), sale("newer-mp", "MP", 70, 3), sale("hp", "HP", 250, 1)],
            expected: "newer-mp", finding: "MODERATELY_PLAYED", profitable: false },
        { name: "a seller condition above the live copy cannot trigger a paid floor comparison",
            sales: [sale("nm", "NM", 300, 1)], expected: null, finding: null },
        { name: "a lower seller claim cannot establish a floor if photos show a better copy than the listing",
            sales: [sale("overstated-wear", "MP", 200, 1)], expected: "overstated-wear", finding: "NEAR_MINT" },
        { name: "physical MP evidence overrides the selected LP clue without trying the next copy",
            sales: [sale("seller-lp", "LP", 200, 1), sale("unspecified", "", 220, 2)], expected: "seller-lp", finding: "MODERATELY_PLAYED" },
    ];
    for (const scenario of scenarios) await t.test(scenario.name, async () => {
        const live = reading(); live.condition!.rawCondition = "LIGHTLY_PLAYED"; live.condition!.gradeRange = null;
        const attempted: (string | undefined)[] = [], read: (string | undefined)[] = [];
        const { evaluate } = harness({
            details: async id => details({ id, price: 100, shipping: 5.96 }),
            assess: async () => ({ result: live, usage: { inputTokens: 700, outputTokens: 450 } }),
            fetchRawComps: async () => scenario.sales,
            soldCondition: () => ({ usage: [],
                read: async source => { read.push(source.id); return null; },
                status: source => scenario.reviewed?.includes(source.id ?? "") ? "REVIEWED" : "UNREVIEWED",
                acquire: async source => {
                    assert.equal(read.length, scenario.sales.length, "all saved sold-copy evidence is read before acquiring a copy");
                    attempted.push(source.id);
                    return scenario.finding ? { condition: scenario.finding, evidence: ["Accepted physical wear evidence."], photoCount: 4 } : null;
                },
            }),
        });
        const result = await evaluate("v1|raw-ordering|0");
        assert.deepEqual(attempted, scenario.expected ? [scenario.expected] : []);
        assert.equal(result.condition?.rawCondition, "LIGHTLY_PLAYED", "sold research never changes the live copy's physical condition");
        const lp = result.rawPricing?.prices?.find(quote => quote.condition === "LIGHTLY_PLAYED");
        assert.equal(lp?.basis, scenario.finding === "LIGHTLY_PLAYED" ? "EBAY_SOLD" : undefined,
            "only accepted physical LP evidence establishes an LP sold price");
        if (scenario.finding === "LIGHTLY_PLAYED") {
            assert.equal(lp?.price, scenario.sales.find(source => source.id === scenario.expected)!.price, "the selected sale's actual amount must survive pricing");
            assert.equal(lp?.comps?.confidence, "LOW");
            assert.equal((result.underwriting?.best?.profit ?? 0) > 0, scenario.profitable ?? true);
            if (scenario.profitable === false) {
                assert.equal(result.underwriting?.verdict, "PASS", "accepted losing evidence completes valuation rather than seeking a favorable replacement");
                assert.equal(resultGroup({ ...details(), currentPrice: 100, isGraded: false }, result), null);
            }
        }
        else if (scenario.finding === "MODERATELY_PLAYED") {
            const raw = result.underwriting?.paths.find(path => path.path === "RAW");
            assert.equal(raw?.priceCondition, "MODERATELY_PLAYED");
            assert.equal(raw?.salePrice, scenario.sales.find(source => source.id === scenario.expected)!.price);
            assert.equal(result.underwriting?.verdict, scenario.profitable === false ? "CANT_PRICE" : "BUY_RAW");
            assert.equal(resultGroup({ ...details(), currentPrice: 100, isGraded: false }, result) === "deals", scenario.profitable ?? true);
        } else assert.equal(result.underwriting?.verdict, "CANT_PRICE");
    });
});

for (const conclusive of [true, false]) test(`a fresh legacy raw price gap reopens once when the new sold-photo check is ${conclusive ? "conclusive" : "inconclusive"}`, async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("saved-price migration must remain offline"));
    const item = details(), answer = reading();
    answer.condition!.rawCondition = "LIGHTLY_PLAYED";
    answer.condition!.gradeRange = null;
    const sale: Comp = { id: "lower-copy", title: "Venusaur Base Set 15/102 Unlimited Holo MP", price: 150,
        sold_at: new Date(now - 86400000).toISOString(), variant: "Holofoil", currency: "USD", attribution: "exact",
        sale_type: "fixed_price", listing_url: null, grader: null, grade: null, grade_qualifier: null };
    let candidateAvailable = false, soldReviews = 0, saleLookups = 0;
    const { evaluate, cache } = harness({
        assess: async () => assert.fail("the original listing photos have already been assessed"),
        fetchRawComps: async () => { saleLookups++; return [sale]; },
        soldCondition: () => ({ usage: [], read: async () => null, status: () => candidateAvailable ? "UNREVIEWED" : "REVIEWED",
            acquire: async () => { soldReviews++; return conclusive ? { condition: "MODERATELY_PLAYED", evidence: ["Visible edge wear."], photoCount: 2 } : null; } }),
    });
    const plan = boundedAssessmentPlan(item);
    cache.set(plan.key, { ...answer, version: plan.version, answeredAt: new Date(now).toISOString() });
    const gap = await evaluate(item.id);
    gap.pricingVersion = "ebay-resale-17";
    assert.equal(gap.underwriting?.verdict, "CANT_PRICE");
    assert.equal(gap.rawPricing?.sampledSoldCopies, 1);
    assert.equal(soldReviews, 0);
    const store = createPrivateEvaluationStore({ cached: async key => cache.get(key) ?? null, save: async (key, value) => { cache.set(key, value); } });
    await store.save(gap, { evidenceKey: listingEvidenceKey(item), contextKey: evaluationContextKey(item) });
    assert.equal(currentPriceEvidence(gap, now), false, "the normal search also releases this old cached result");

    candidateAvailable = true;
    const termsOnly = await withAiUsageContext({ searchId: randomUUID() }, () => evaluate(item.id, { priceOnly: true }));
    assert.equal(soldReviews, 0, "a price-only refresh cannot buy the sold photos");
    assert.equal(currentPriceEvidence(termsOnly, now), false, "the next full assessment still needs the sold comparison");
    const fresh = await evaluate(item.id);
    assert.equal(fresh.underwriting?.verdict, conclusive ? "BUY_RAW" : "CANT_PRICE");
    if (conclusive) {
        assert.equal(fresh.underwriting?.best?.priceCondition, "MODERATELY_PLAYED");
        assert.equal(currentPriceEvidence({ ...fresh, pricingVersion: "ebay-resale-17" }, now), true, "already priced raw copies keep their normal lifetime");
    }
    assert.equal(fresh.answeredAt, gap.answeredAt);
    assert.equal(currentPriceEvidence(fresh, now), true);
    const replay = await evaluate(item.id);
    assert.deepEqual(replay.usage, []);
    assert.ok(replay.reusedSteps.includes("savedEvaluation"));
    assert.equal(soldReviews, 1);
    assert.equal(saleLookups, 3, "replaying the full result needs no further sale lookups");
});

test("raw sold-photo work stops when no remaining comp can meet targets and resumes with looser terms", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("target deferral should use mocked providers only"));
    const live = reading();
    live.condition!.rawCondition = "LIGHTLY_PLAYED";
    live.condition!.gradeRange = null;
    let liveReads = 0, soldReads = 0;
    const sale: Comp = { id: "lp", title: "Venusaur Base Set 15/102 Unlimited Holo LP", price: 175,
        sold_at: new Date(now - 86400000).toISOString(), variant: "Holofoil", currency: "USD", attribution: "exact",
        sale_type: "fixed_price", listing_url: null, grader: null, grade: null, grade_qualifier: null };
    const { evaluate } = harness({
        details: async id => details({ id, price: 100, shipping: 5.96 }),
        assess: async () => { liveReads++; return { result: live, usage: { inputTokens: 700, outputTokens: 450 } }; },
        fetchRawComps: async () => [sale],
        fetchCachedComps: async (_id, target) => {
            assert.deepEqual([target.grader, target.grade], ["PSA", 6]);
            return gradedSales(target);
        },
        soldCondition: () => ({ usage: [], read: async () => null, status: () => "UNREVIEWED",
            acquire: async () => { soldReads++; return { condition: "LIGHTLY_PLAYED", evidence: ["Accepted physical wear evidence."], photoCount: 4 }; } }),
    });
    const id = "v1|raw-target-deferral|0", targets = { minProfit: 0, minRoi: 0.5 };
    const blocked = await evaluate(id, { targets });
    assert.equal(blocked.underwriting?.verdict, "CANT_PRICE");
    assert.equal(blocked.rawPricing?.sellerConditionComps?.marketEstimate?.price, 175);
    assert.equal(blocked.gradedPricing?.PSA?.referenceGradeComps?.grade, 6);
    assert.equal(blocked.gradedPricing?.PSA?.byGrade, undefined);
    assert.match(blocked.rawPricing?.evidenceNote ?? "", /skipped because none/);
    assert.equal(soldReads, 0);
    const repeated = await evaluate(id, { targets });
    assert.ok(repeated.reusedSteps.includes("savedEvaluation"));
    assert.equal(soldReads, 0);
    const relaxed = await evaluate(id, { targets: { minProfit: 0, minRoi: 0 } });
    assert.equal(relaxed.underwriting?.verdict, "BUY_RAW");
    assert.equal(relaxed.rawPricing?.soldPhotoDeferred, undefined);
    assert.equal(soldReads, 1);
    assert.equal(liveReads, 1, "reconsidering the price evidence reuses the live copy's photo reading");
});

test("an explicit crease prices the damaged raw resale and skips grading research the verdict would discard", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("use only the saved listing and sold fixtures"));
    const item = details({ price: 12, shipping: 3, conditionNotes: ["Seller description: Card is in played condition heavy scratches creases edge wear"] });
    const soldChecks: string[] = [];
    const sale: Comp = { id: "damaged", title: "Venusaur Base Set 15/102 Unlimited Holo Damaged", price: 125,
        sold_at: new Date(now - 86400000).toISOString(), variant: "Holofoil", currency: "USD", attribution: "exact",
        sale_type: "fixed_price", listing_url: null, grader: null, grade: null, grade_qualifier: null };
    const { evaluate, calls } = harness({ details: async () => item,
        fetchRawComps: async () => [{ ...sale, id: "clean", title: sale.title.replace("Damaged", "NM") }, sale],
        soldCondition: ({ condition }) => {
            assert.equal(condition, "DAMAGED");
            return { usage: [], read: async () => null, status: () => "UNREVIEWED", acquire: async copy => {
                soldChecks.push(copy.id);
                return { condition: "DAMAGED", photoCount: 2, evidence: ["A crease crosses the artwork."] };
            } };
        },
    });
    const result = await evaluate(item.id, { automatic: true });
    assert.notEqual(result.condition?.rawCondition, "DAMAGED", "preserve the independent photo observation");
    assert.deepEqual(soldChecks, ["damaged"]);
    assert.equal(calls.comps, 0);
    assert.equal(result.gradedPricing, null);
    assert.equal(result.underwriting?.verdict, "BUY_RAW");
    assert.equal(result.underwriting?.best?.priceCondition, "DAMAGED");
    const summary = { ...item, currentPrice: item.price, isGraded: false };
    assert.equal(resultGroup(summary, result), "deals");
    const replay = await evaluate(item.id, { automatic: true });
    assert.ok(replay.reusedSteps.includes("savedEvaluation"));
    assert.deepEqual(soldChecks, ["damaged"]);
    assert.equal(calls.assessed, 1);
    assert.equal(currentPriceEvidence({ ...result, gradedPricing: {}, rawPricing: { ...result.rawPricing!, prices: [] } }, now), false);
});

test("a newly verified Best Offer reopens an economically relevant raw sold-photo check", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("offer deferral should use mocked providers only"));
    const listing = details({ price: 100, shipping: 5.96, retrievedAt: new Date(now - 1000).toISOString() });
    const live = reading();
    live.condition!.rawCondition = "LIGHTLY_PLAYED";
    live.condition!.gradeRange = null;
    let liveReads = 0, soldReads = 0;
    const sale: Comp = { id: "lp", title: "Venusaur Base Set 15/102 Unlimited Holo LP", price: 125,
        sold_at: new Date(now - 86400000).toISOString(), variant: "Holofoil", currency: "USD", attribution: "exact",
        sale_type: "fixed_price", listing_url: null, grader: null, grade: null, grade_qualifier: null };
    const { evaluate } = harness({
        details: async () => ({ ...listing }),
        assess: async () => { liveReads++; return { result: live, usage: { inputTokens: 700, outputTokens: 450 } }; },
        fetchRawComps: async () => [sale],
        soldCondition: () => ({ usage: [], read: async () => null, status: () => "UNREVIEWED",
            acquire: async () => { soldReads++; return { condition: "LIGHTLY_PLAYED", evidence: ["Accepted physical wear evidence."], photoCount: 4 }; } }),
    });
    const blocked = await evaluate(listing.id);
    assert.equal(blocked.rawPricing?.soldPhotoDeferred?.price, 100);
    assert.equal(soldReads, 0);
    listing.bestOffer = true;
    const offersDisabled = await evaluate(listing.id, { includeOffers: false });
    assert.equal(offersDisabled.rawPricing?.soldPhotoDeferred?.price, 100);
    assert.equal(soldReads, 0);
    const checked = await evaluate(listing.id);
    assert.equal(checked.rawPricing?.status, "PRICED");
    assert.equal(checked.underwriting?.verdict, "PASS", "the actual asking price still loses money");
    assert.equal(soldReads, 1);
    assert.equal(liveReads, 1);
});

test("catalog-corroborated photos correct stale seller fields without repurchasing the accepted reading or restoring a generic mismatch hold", async () => {
    const listing = details({ aspects: { ...details().aspects, "Card Number": "14/102", Finish: "Regular" } });
    const accepted = reading(); accepted.condition!.rawCondition = "LIGHTLY_PLAYED"; accepted.condition!.gradeRange = null;
    accepted.photoCheck.cardMatch = { verdict: "MISMATCH", problems: [
        "The visible collector number is 15/102, not seller aspects 14/102.",
        "The visible finish is holo, not seller aspects Regular.",
    ] };
    let sales: Comp[] = [];
    const { evaluate, cache, calls } = harness({ details: async () => listing,
        assess: async () => assert.fail("accepted photo reading must be reused"),
        fetchRawComps: async () => { calls.raw++; return sales; } });
    sales = seedRawSoldCopies(cache, listing, "LIGHTLY_PLAYED", 150, now);
    const plan = boundedAssessmentPlan(listing);
    const stored = { ...accepted, version: plan.version, answeredAt: new Date(now).toISOString() };
    cache.set(plan.key, structuredClone(stored));
    const result = await evaluate(listing.id);
    assert.equal(result.identity?.status, "IDENTIFIED");
    assert.equal(result.identity?.cardNumber, "15/102");
    assert.equal(result.identity?.finish, "HOLO");
    assert.equal(result.underwriting?.verdict, "BUY_RAW");
    assert.equal(resultGroup({ ...listing, currentPrice: listing.price, isGraded: false }, result), "deals");
    assert.equal(photoReviewStatus(result).needsYourReview, false);
    assert.equal(calls.assessed, 0);
    assert.deepEqual(result.usage, []);
    assert.deepEqual(result.photoCheck?.cardMatch, accepted.photoCheck.cardMatch, "original mismatch observations stay visible");
    assert.deepEqual(cache.get(plan.key), stored);
    assert.equal(listing.aspects["Card Number"], "14/102");
    assert.equal(listing.aspects.Finish, "Regular");
});

test("a stale generic finish disagreement is repriced from saved photo evidence", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("this replay must remain offline"));
    const listing = details({ title: "Venusaur 15/102 Base Set Rare 1999 Wizards of the Coast Eng HP 100",
        aspects: { ...details().aspects, Finish: "Regular" } });
    const { evaluate, cache } = harness({ details: async () => listing,
        assess: async () => assert.fail("the original photo reading must be reused"), fetchRawComps: async () => [] });
    const plan = boundedAssessmentPlan(listing);
    cache.set(plan.key, { ...reading(), version: plan.version, answeredAt: new Date(now).toISOString() });
    const first = await evaluate(listing.id);
    assert.equal(first.identity?.status, "IDENTIFIED");
    const store = createPrivateEvaluationStore({ cached: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, structuredClone(value)); } });
    const saved = (await store.load(listing.id))!;
    const stale = { ...first, identity: { ...first.identity!, status: "NEEDS_REVIEW" as const, finish: "CONFLICTING",
        reasons: ["The photographed finish disagrees with the listing or slab label."] } };
    await store.save(stale, saved);
    assert.equal(currentPriceEvidence(stale, now), false);
    const replay = await evaluate(listing.id);
    assert.equal(replay.identity?.status, "IDENTIFIED");
    assert.equal(replay.identity?.finish, "HOLO");
    assert.equal(replay.listing.aspects.Finish, "Regular");
    assert.match(replay.identity!.reasons.join(" "), /seller lists the finish as Regular.*front photo shows holo/i);
    assert.doesNotMatch(replay.underwriting!.reasons.join(" "), /photographed finish|slab label/);
    assert.deepEqual(replay.usage, []);
});

test("a seller set typo with matching title, saved photos and exact sales can reach Deals", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("seller set replay must stay offline"));
    const listing = details({ aspects: { ...details().aspects, Set: "Base Set 2", "Card Number": "15/130" } });
    const accepted = reading(); accepted.condition!.gradeRange = null;
    accepted.photoCheck.cardMatch = { verdict: "MISMATCH", problems: [
        "The seller item specifics say Base Set 2, but the photographed set is Base Set.",
        "The visible collector number is 15/102, not seller aspects 15/130.",
    ] };
    let sales: Comp[] = [];
    const { evaluate, cache, calls } = harness({ details: async () => listing,
        assess: async () => assert.fail("accepted photos remain reusable"),
        lookup: async query => {
            assert.equal(query.set, "Base Set"); assert.equal(query.cardNumber, "15/102");
            return [card, { ...card, setName: "Base Set 2", cardNumber: "15/130" }];
        },
        fetchRawComps: async () => sales,
    });
    sales = seedRawSoldCopies(cache, details(), "LIGHTLY_PLAYED", 150, now);
    const plan = boundedAssessmentPlan(listing);
    const stored = { ...accepted, version: plan.version, answeredAt: new Date(now).toISOString() };
    cache.set(plan.key, structuredClone(stored));

    const result = await evaluate(listing.id);
    assert.equal(result.identity?.set, "Base Set");
    assert.equal(result.identity?.cardNumber, "15/102");
    assert.equal(result.underwriting?.verdict, "BUY_RAW");
    assert.equal(resultGroup({ ...listing, currentPrice: listing.price, isGraded: false }, result), "deals");
    assert.equal(calls.assessed, 0);
    assert.deepEqual(result.usage, []);
    assert.deepEqual(cache.get(plan.key), stored);
    assert.equal(result.listing.aspects.Set, "Base Set 2");
});

test("a sold-copy AI allowance denial preserves a supported grading deal", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("the allowance regression must remain offline"));
    const item = details();
    const live = reading(); live.condition!.rawCondition = "NEAR_MINT";
    let soldPhotoAttempts = 0;
    const { evaluate, calls, cache } = harness({
        assess: async () => assert.fail("the accepted listing assessment must be reused"),
        soldCondition: options => createSoldConditionAcquirer({ ...options, assess: async () => {
            soldPhotoAttempts++;
            throw new AiSearchAllowanceError("This request would exceed the search's remaining AI budget.");
        } }),
    });
    const plan = boundedAssessmentPlan(item);
    const saved = { ...live, version: plan.version, answeredAt: new Date(now).toISOString() };
    cache.set(plan.key, saved);

    const result = await evaluate(item.id);
    assert.equal(soldPhotoAttempts, 1);
    assert.equal(result.rawPricing?.status, "PRICE_UNAVAILABLE");
    assert.match(result.rawPricing?.reason ?? "", /remaining AI allowance/);
    assert.equal(result.rawPricing?.prices, undefined);
    assert.equal(calls.comps, 6);
    assert.equal(result.underwriting?.verdict, "BUY_AND_GRADE");
    assert.equal(currentPriceEvidence({ ...result, pricingVersion: "ebay-resale-17" }, now), true, "a supported grading deal needs no raw-floor migration");
    assert.equal(resultGroup({ ...item, currentPrice: item.price, isGraded: false }, result), "deals");
    assert.deepEqual(cache.get(plan.key), saved);
    assert.deepEqual(result.usage, []);

    const replay = await evaluate(item.id);
    assert.equal(replay.underwriting?.verdict, "BUY_AND_GRADE");
    assert.equal(soldPhotoAttempts, 1);
    assert.equal(calls.comps, 6);
});

test("a sold-copy accounting, pause, or storage failure stops the evaluation", async () => {
    for (const failure of [new AiSpendingError("AI_BUDGET", "The saved ledger is invalid."), new AiSpendingError("AI_PAUSED", "Paid AI is paused."), new AiSpendingError("AI_EVIDENCE_HELD", "Previous assessment unresolved."), new StorageUnavailableError()]) {
        const live = reading(); live.condition!.rawCondition = "NEAR_MINT"; live.condition!.gradeRange = null;
        const { evaluate, calls } = harness({ assess: async () => ({ result: live, usage: { inputTokens: 700, outputTokens: 450 } }),
            soldCondition: options => createSoldConditionAcquirer({ ...options, assess: async () => { throw failure; } }) });
        await assert.rejects(evaluate("v1|raw-stop|0"), error => error === failure);
        assert.equal(calls.comps, 0);
    }
});

test("price-only retry uses current terms and saved photos under the original search", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("the price refresh regression must remain offline"));
    const searchId = randomUUID(), wrongSearchId = randomUUID();
    const initialListing = details();
    let listing = initialListing;
    let saleState: "empty" | "priced" | "failure" = "empty";
    let gradedLookups = 0, soldPhotoAttempts = 0;
    const detailAges: (number | undefined)[] = [];
    const failure = new Error("Pricing provider unavailable.");
    const live = reading(); live.condition!.rawCondition = "NEAR_MINT";
    const { evaluate, cache } = harness({ details: async (_id, options) => { detailAges.push(options?.maxAgeHours); return listing; },
        assess: async () => assert.fail("repricing must use the accepted listing photos"),
        stamp: async () => assert.fail("repricing must not start an edition crop"),
        soldCondition: () => ({ read: async () => null, status: () => "UNREVIEWED", acquire: async () => { soldPhotoAttempts++; return null; }, usage: [] }),
        fetchComps: async (_id, options) => {
            gradedLookups++;
            assert.equal(getAiUsageContext().searchId, searchId);
            if (saleState === "failure") throw failure;
            return saleState === "priced" ? gradedSales(options) : [];
        },
    });
    const plan = boundedAssessmentPlan(listing);
    cache.set(plan.key, { ...live, version: plan.version, answeredAt: new Date(now).toISOString() });
    const snapshot = createPrivateEvaluationStore({ cached: async key => cache.get(key) ?? null, save: async (key, value) => { cache.set(key, structuredClone(value)); } });
    const refresh = () => withAiUsageContext({ searchId }, () => evaluate(listing.id, { priceOnly: true }));
    const initial = await withAiUsageContext({ searchId }, () => evaluate(listing.id));
    const initialSnapshot = await snapshot.load(listing.id);
    assert.equal(initialSnapshot?.searchId, searchId);
    assert.equal(initial.underwriting?.verdict, "CANT_PRICE");
    assert.equal(soldPhotoAttempts, 1);

    await assert.rejects(withAiUsageContext({ searchId: wrongSearchId }, () => evaluate(listing.id, { priceOnly: true })), PriceOnlyEvidenceError);
    assert.deepEqual(detailAges, [0], "an unrelated search must not start an eBay call");
    const initialLookups = gradedLookups;
    listing = { ...initialListing, images: [...initialListing.images.slice(0, -1), photo(5)] };
    await assert.rejects(refresh(), PriceOnlyEvidenceError);
    assert.equal(gradedLookups, initialLookups);

    listing = { ...initialListing, price: 40, shipping: 6 };
    saleState = "failure";
    await assert.rejects(refresh(), error => error === failure);
    assert.deepEqual(await snapshot.load(listing.id), initialSnapshot, "a provider error leaves the previous accepted result intact");

    saleState = "priced";
    const refreshed = await refresh();
    assert.deepEqual(detailAges, [0, 0, 0, 0]);
    assert.deepEqual(refreshed.photoCheck, initial.photoCheck);
    assert.deepEqual(refreshed.condition, initial.condition);
    assert.equal(refreshed.answeredAt, initial.answeredAt);
    assert.equal(refreshed.listing.price, 40);
    assert.equal(refreshed.listing.shipping, 6);
    assert.equal(refreshed.underwriting?.verdict, "BUY_AND_GRADE");
    assert.deepEqual(refreshed.usage, []);
    assert.equal(soldPhotoAttempts, 1);
    assert.equal((await snapshot.load(listing.id))?.searchId, searchId);

    assert.ok(refreshed.photoReviewKey);
    const review = createDeeperPhotoReviewer({ loadPrivate: snapshot.load, cached: async key => cache.get(key) ?? null,
        cache: async (key, value) => { cache.set(key, structuredClone(value)); },
        review: async () => ({ result: { summary: "A crease is visible.", requestedPhotos: [],
            findings: [{ area: "SURFACE", impact: "NEW_CONCERN", observation: "A crease crosses the lower card border.", photoNumbers: [1] }] },
            usage: { inputTokens: 10, outputTokens: 5 } }),
    });
    const acceptedReview = await review(listing.id, refreshed.photoReviewKey);
    const afterReview = await refresh();
    assert.deepEqual(afterReview.deeperPhotoReview, acceptedReview);
    assert.equal(afterReview.underwriting?.verdict, "NEEDS_REVIEW");
    assert.equal(soldPhotoAttempts, 1);
});

test("material uncertainty in the live copy cannot buy an unrelated historical condition assessment", async () => {
    for (const concern of ["CREASE", "AUTHENTICITY"] as const) {
        const live = reading(); live.condition!.gradeRange = null;
        if (concern === "CREASE") live.condition!.creases = "SUSPECTED";
        else live.condition!.authenticity = { concern: "POSSIBLE", reasons: ["The readable card name has inconsistent print spacing."],
            limitations: [], observations: [{ photoNumber: 1, feature: "FONTS", observation: "The readable card name has inconsistent print spacing.",
                expected: "Consistent printed letter spacing.", judgment: "SUSPICIOUS" }] };
        const { evaluate } = harness({ assess: async () => ({ result: live, usage: { inputTokens: 700, outputTokens: 450 } }),
            soldCondition: options => createSoldConditionAcquirer({ ...options, assess: async () => assert.fail("another copy cannot resolve this copy's uncertainty") }) });
        const result = await evaluate(`v1|uncertain-raw-${concern}|0`);
        assert.ok(!result.underwriting?.verdict.startsWith("BUY"));
        assert.equal(result.condition?.rawCondition, live.condition!.rawCondition);
        assert.equal(result.condition?.creases, live.condition!.creases);
    }
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

test("a missing full back in an accepted sample checks only unseen gallery photos and reuses the answer", async () => {
    const listing = details({ images: Array.from({ length: 8 }, (_, index) => photo(index)) });
    const sampled = boundedAssessmentPlan(listing);
    const prior = reading(6);
    for (const image of prior.photoCheck.images) if (image.view === "BACK") image.view = "BACK_DETAIL";
    prior.photoCheck.missingViews = ["FULL_BACK"];
    prior.condition!.rawCondition = "LIGHTLY_PLAYED";
    const paid: number[][] = [];
    const { cache, evaluate } = harness({
        details: async () => listing,
        assess: async (_listing, photos, _signal, _mode, stage) => {
            assert.equal(stage?.kind, "gallery");
            assert.equal(stage.prior.photoCheck.images.length, 6);
            paid.push(photos.map(p => p.number));
            const result = reading(2);
            result.photoCheck.images[0].view = "BACK";
            result.photoCheck.images[1].view = "BACK_DETAIL";
            result.photoCheck.cardIdentity!.finish = "NON_HOLO";
            result.photoCheck.cardMatch!.verdict = "CANT_TELL";
            result.condition!.rawCondition = "UNKNOWN";
            result.condition!.gradeRange = { low: 4, likely: 5, high: 6 };
            return { result, usage: { inputTokens: 700, outputTokens: 450 } };
        },
    });
    cache.set(sampled.key, { ...prior, version: sampled.version, answeredAt: new Date(now - 60000).toISOString() });
    for (let run = 0; run < 2; run++) {
        const result = await evaluate(listing.id);
        assert.deepEqual(paid, [[3, 6]]);
        assert.equal(result.listing.photosAnalyzed, 8);
        assert.equal(result.photoCheck?.images.find(photo => photo.number === 3)?.view, "BACK");
        assert.equal(result.photoCheck?.cardIdentity?.finish, "HOLO");
        assert.equal(result.condition?.rawCondition, "LIGHTLY_PLAYED");
        assert.equal(result.provisionalGradeRange?.likely, 5);
        assert.equal(result.usage.length, run === 0 ? 1 : 0);
    }
    assert.equal(cache.get(sampled.key).photoCheck.missingViews[0], "FULL_BACK");
});

test("a seller adds a back to a shortlisted front: inspect only the addition, reprice, and reuse it on replay", async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shortlist-gallery-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const listing = details({ images: [photo(1)], retrievedAt: new Date(now).toISOString() });
    const store = createShortlistStore(path.join(dir, "shortlist.json"));
    const service = createShortlistService({ store, details: async () => listing, now: () => now });
    const paid: Array<[number[], string | undefined]> = [];
    const { evaluate } = harness({ details: async () => listing, assess: async (_listing, photos, _signal, _mode, stage) => {
        paid.push([photos.map(p => p.number), stage?.kind]);
        const result = reading(1);
        if (stage?.kind === "gallery") {
            assert.equal(stage.prior.photoCheck.images[0].view, "FRONT");
            result.photoCheck.images[0].view = "BACK";
            result.photoCheck.images[0].issues = ["White bottom-left corner and a visible crease on the back."];
            result.condition!.creases = "PRESENT";
            result.condition!.rawCondition = "DAMAGED";
            result.condition!.gradeRange = null;
        }
        return { result, usage: { inputTokens: 600, outputTokens: 200 } };
    } });
    const initial = await evaluate(listing.id);
    assert.equal(initial.listing.photosAnalyzed, 1);
    const summary = { id: listing.id, title: listing.title, url: listing.url, currentPrice: listing.price, shipping: listing.shipping,
        buyingOption: listing.buyingOption, bids: listing.bids, endTime: listing.endTime, isGraded: false, images: listing.images, seller: null };
    await store.save(summary, initial);
    listing.images = [photo(1, 500), photo(2)];
    const refreshed = (await service.refresh([listing.id])).entries[0];
    assert.equal(refreshed.evaluation, null, "a gallery edit invalidates the displayed advice");
    assert.equal(refreshed.photoChange?.neededBack, true);
    assert.equal(refreshed.photoChange?.previousVerdict, initial.underwriting?.verdict);
    listing.aspects.Edition = "1st Edition";
    await assert.rejects(evaluate(listing.id, { addedPhotosOnly: true }), /cannot be matched/);
    assert.deepEqual(paid, [[[1], undefined]], "a conflicting printing cannot authorize extra spending");
    delete listing.aspects.Edition;
    const updated = await evaluate(listing.id, { addedPhotosOnly: true });
    assert.deepEqual(paid, [[[1], undefined], [[2], "gallery"]]);
    assert.deepEqual(updated.photoCheck?.images.map(i => [i.number, i.view]), [[1, "FRONT"], [2, "BACK"]]);
    assert.equal(updated.condition?.rawCondition, "DAMAGED");
    assert.equal(updated.condition?.creases, "PRESENT");
    assert.equal(updated.reusedSteps.includes("previousGalleryPhotos"), true);
    assert.ok(!updated.underwriting?.verdict.startsWith("BUY"));
    await service.remember(updated, listingEvidenceKey(refreshed.listing));
    const [saved] = await store.list();
    assert.equal(saved.needsAnalysis, false);
    assert.equal(saved.photoChange?.reviewedVerdict, saved.evaluation?.underwriting?.verdict);
    assert.equal(saved.photoChange?.previousVerdict, refreshed.photoChange?.previousVerdict);
    const replay = await evaluate(listing.id, { addedPhotosOnly: true });
    assert.deepEqual(replay.photoCheck?.images, updated.photoCheck?.images);
    assert.equal(replay.underwriting?.verdict, updated.underwriting?.verdict);
    assert.equal(replay.usage.length, 0);
    assert.equal(paid.length, 2);
    listing.images = [photo(5), photo(2)];
    await assert.rejects(evaluate(listing.id, { addedPhotosOnly: true }), /cannot be matched/);
    assert.equal(paid.length, 2, "replaced front cannot trigger a new full-gallery charge");
});

test("clear added back and detail photos can unlock an evidenced grading deal without resending the front", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("saved photo update tests must use offline providers"));
    const listing = details({ images: [photo(1)], bestOffer: false, retrievedAt: new Date(now).toISOString() });
    const batches: number[][] = [];
    const { evaluate } = harness({ details: async () => listing, assess: async (_listing, photos) => {
        batches.push(photos.map(p => p.number));
        const answer = reading(photos.length);
        const views = ["FRONT", "BACK", "FRONT_DETAIL", "BACK_DETAIL"] as const;
        answer.photoCheck.images.forEach((image, index) => { image.view = views[photos[index].number - 1]; });
        answer.condition!.rawCondition = "LIGHTLY_PLAYED";
        if (photos.length === 1) answer.condition!.gradeRange = null;
        return { result: answer, usage: { inputTokens: 500, outputTokens: 300 } };
    } });
    const front = await evaluate(listing.id);
    assert.ok(!front.underwriting?.verdict.startsWith("BUY"));
    listing.images = [photo(1), photo(2), photo(3), photo(4)];
    const complete = await evaluate(listing.id, { addedPhotosOnly: true });
    assert.deepEqual(batches, [[1], [2, 3, 4]]);
    assert.equal(complete.underwriting?.verdict, "BUY_AND_GRADE");
    assert.equal(resultGroup({ ...listing, currentPrice: listing.price, isGraded: false }, complete), "deals");
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

test("conflicting saved stamp or shadow readings supersede an otherwise fresh valuation", async () => {
    for (const [field, opposite, reason] of [["firstEditionStamp", "VISIBLE", /First Edition stamp/],
        ["artBoxShadow", "ABSENT", /artwork border/]] as const) {
        const listing = details(), full = reading();
        const pass = { cardCount: "ONE", cardIdentity: full.photoCheck.cardIdentity, printedName: "Venusaur", printedNumber: "15/102",
            printingMarks: { ...full.photoCheck.printingMarks!, [field]: opposite }, slab: null };
        const valuation = cardEvaluation();
        Object.assign(valuation, { assessmentVersion: ANALYSIS_VERSION, conditionVersion: CONDITION_VERSION,
            pricingVersion: PRICING_VERSION, pricesCheckedAt: new Date(now - 1000).toISOString() });
        assert.equal(currentPriceEvidence(valuation, now), true);
        const record: SavedRecord = { itemId: listing.id, version: ANALYSIS_VERSION, photoFingerprint: photoFingerprint(listing.images),
            answeredAt: new Date(now - 86400000).toISOString(), photoCheck: { result: full.photoCheck, usage: { inputTokens: 1, outputTokens: 1 } },
            assessment: { version: CONDITION_VERSION, completedRuns: 2, mode: "FULL", photoNumbers: [1, 2, 3, 4], result: full.condition!, setAside: [] },
            identityPasses: [{ result: pass, usage: { inputTokens: 1, outputTokens: 1 } }], reviewContext: { title: listing.title, photos: listing.images },
            latestEvaluation: { evidenceKey: listingEvidenceKey(listing), evaluation: valuation } };
        const original = structuredClone(record);
        const { evaluate, calls } = harness({ saved: async () => record, stamp: async () => assert.fail("no replacement crop for an explicit conflict") });
        const result = await evaluate(listing.id);
        assert.deepEqual(result.photoCheck?.printingMarks?.conflicts, [field]);
        assert.match(result.identity?.reasons.join(" ") ?? "", reason);
        assert.equal(result.underwriting?.verdict, "NEEDS_REVIEW");
        assert.equal(calls.assessed + calls.raw + calls.comps, 0);
        assert.deepEqual(record, original);
    }
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

test("a photographed slab on a raw listing switches to label-only follow-up and ignores stray raw grades on reopen", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("slab follow-up must use mocked providers only"));
    const listing = details({ bestOffer: false, retrievedAt: new Date(now - 1000).toISOString() });
    const front = reading(1);
    front.photoCheck.holder = "GRADED_SLAB";
    front.photoCheck.slab = { present: true, grader: "PSA", grade: "8", gradeQualifier: null, certNumber: "12345678",
        labelText: "1999 POKEMON GAME VENUSAUR-HOLO #15 NM-MT 8", caseCondition: "SCRATCHED", authenticity: "NONE_SEEN",
        authenticityEvidence: [], concerns: ["The front of the case is scratched."] };
    const routes: { mode?: string; photos: number[] }[] = [];
    const { evaluate, cache, calls } = harness({ details: async () => listing, assess: async (_listing, photos, _signal, mode, stage) => {
        routes.push({ mode, photos: photos.map(photo => photo.number) });
        if (stage?.kind === "front") return { result: front, usage: { inputTokens: 500, outputTokens: 300 } };
        assert.equal(stage?.kind, "remainder");
        assert.equal(stage.front.condition, null);
        const back = reading(photos.length);
        back.condition = null;
        back.photoCheck.images[0].view = "BACK";
        return { result: back, usage: { inputTokens: 500, outputTokens: 300 } };
    }, fetchRawComps: async () => assert.fail("a verified slab never needs raw resale research") });
    const first = await evaluate(listing.id);
    assert.deepEqual(routes, [{ mode: "RAW", photos: [1] }, { mode: "SLAB_LABEL", photos: [2] }]);
    assert.equal(cache.get(stagedPhotoPlan(listing, boundedAssessmentPlan(listing), "front").key).condition, null);
    assert.equal(first.condition, null);
    assert.equal(first.provisionalGradeRange, undefined);
    assert.equal(first.slab?.grade, "8");
    assert.equal(first.slab?.caseCondition, "SCRATCHED");
    assert.ok(first.slab?.concerns.includes("The front of the case is scratched."));
    assert.deepEqual(first.photoCheck?.images.map(image => image.number), [1, 2]);
    assert.equal(first.underwriting?.verdict, "BUY_GRADED");

    const [snapshotKey, snapshot] = [...cache.entries()].find(([key]) => key.startsWith(PRIVATE_EVALUATION_PREFIX))!;
    snapshot.evaluation.condition = structuredClone(front.condition);
    snapshot.evaluation.provisionalGradeRange = front.condition!.gradeRange;
    snapshot.evaluation.gradeStatus = "ESTIMATED";
    const reopened = await evaluate(listing.id);
    assert.equal(routes.length, 2);
    assert.equal(calls.comps, 1);
    assert.equal(reopened.condition, null);
    assert.equal(reopened.provisionalGradeRange, undefined);
    assert.equal(reopened.gradeStatus, "CERTIFIED_SLAB");
    assert.equal(reopened.slab?.grade, "8");
    assert.deepEqual(reopened.photoCheck, first.photoCheck);

    // Older raw staging used a different key and selected a larger gallery.
    // Keep the paid image mapping and disregard its stray raw grades.
    cache.delete(snapshotKey);
    for (const key of cache.keys()) if (key.includes("/remainder-1:")) cache.delete(key);
    const frontKey = stagedPhotoPlan(listing, boundedAssessmentPlan(listing), "front").key;
    cache.get(frontKey).condition = { ...front.condition, gradeRange: null };
    const oldFront = { photoCheck: front.photoCheck, condition: cache.get(frontKey).condition };
    const rawPlan = compatibleBoundedPlans(listing).find(plan => plan.mode === "RAW" && plan.version.endsWith("/bounded-prompts-2"))!;
    const oldRemainder = stagedPhotoPlan(listing, rawPlan, "remainder", oldFront);
    const oldReading = reading(oldRemainder.photos.length);
    oldReading.photoCheck.images[0].view = "BACK";
    const saved = { ...oldReading, version: oldRemainder.version, answeredAt: new Date(now).toISOString() };
    cache.set(oldRemainder.key, saved);
    const reused = await evaluate(listing.id);
    assert.equal(routes.length, 2, "already paid for the older raw remainder");
    assert.deepEqual(reused.photoCheck?.images.map(image => image.number), [1, 2, 3, 4]);
    assert.equal(reused.condition, null);
    assert.equal(reused.slab?.grade, "8");
    assert.notEqual(saved.condition?.gradeRange, null, "reading the earlier stage does not modify it");

    cache.delete(snapshotKey);
    saved.photoCheck.images[0].view = "FRONT";
    const conflict = await evaluate(listing.id);
    assert.equal(conflict.condition, null);
    assert.equal(conflict.slab?.grade, "8");
    assert.equal(conflict.underwriting?.verdict, "NEEDS_REVIEW");
    assert.equal(conflict.identity?.notThisCard, undefined);
    assert.ok(conflict.slab?.reasons.includes("The front and later photos show different card holders."));
});

const sellerSlabNameIssue = "The seller's Card Name is Blastoise, but the slab label and card read Venusaur.";
function savedSlabNameConflict({ title = "PSA 7 Venusaur Base Set 15/102 Holo English",
    labelText = "1999 POKEMON GAME VENUSAUR HOLO #15 EX MT 7", grade = "7", additionalProblem = "" } = {}) {
    const listing = details({ title, condition: "Graded",
        aspects: { ...details().aspects, "Card Name": "Blastoise", "Professional Grader": "PSA", Grade: grade } });
    const readingForSlab = reading(2);
    readingForSlab.condition = null;
    readingForSlab.photoCheck.holder = "GRADED_SLAB";
    readingForSlab.photoCheck.slab = { present: true, grader: "PSA", grade: "7", gradeQualifier: null, certNumber: "12345678",
        labelText, caseCondition: "INTACT", authenticity: "NONE_SEEN", authenticityEvidence: [], concerns: [] };
    if (additionalProblem) readingForSlab.photoCheck.cardMatch = { verdict: "MISMATCH", problems: [sellerSlabNameIssue, additionalProblem] };
    const plan = boundedAssessmentPlan(listing);
    const stored = { ...readingForSlab, version: plan.version, answeredAt: new Date(now).toISOString() };
    return { listing, key: plan.key, stored };
}

test("a saved slab label repairs a seller card-name hold without another photo assessment", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("slab name correction must use saved/mocked evidence only"));
    const { listing, key, stored } = savedSlabNameConflict();
    const { evaluate, cache, calls } = harness({ details: async () => listing,
        assess: async () => assert.fail("the accepted label reading must be reused"),
        lookup: async query => query.name === "Venusaur" ? [card] : [] });
    cache.set(key, structuredClone(stored));

    const first = await evaluate(listing.id);
    assert.equal(first.identity?.status, "IDENTIFIED");
    assert.equal(first.identity?.name, "Venusaur");
    assert.equal(first.listing.aspects?.["Card Name"], "Blastoise");
    assert.equal(first.slabPricing?.status, "PRICED");
    assert.equal(first.slabPricing?.grade, "7");
    assert.equal(photoReviewStatus(first).needsYourReview, false);
    assert.equal(calls.comps, 1);

    // Reopen a still-fresh snapshot generated by the previous resolver, which
    // searched for Blastoise at #15 and never reached exact slab pricing.
    const saved = [...cache.entries()].find(([key]) => key.startsWith(PRIVATE_EVALUATION_PREFIX))![1];
    Object.assign(saved.evaluation.identity, { status: "NEEDS_REVIEW", name: null, cardNumber: null, recordId: null,
        reasons: ["No card in the price database matches Base Set #15/102."] });
    saved.evaluation.slabPricing = null;
    saved.evaluation.underwriting.verdict = "NEEDS_REVIEW";
    const reopened = await evaluate(listing.id);
    assert.equal(reopened.identity?.status, "IDENTIFIED");
    assert.equal(reopened.slabPricing?.status, "PRICED");
    assert.equal(reopened.answeredAt, first.answeredAt);
    assert.deepEqual(reopened.photoCheck, first.photoCheck);
    assert.deepEqual(reopened.usage, []);
    assert.deepEqual(cache.get(key), stored);
    assert.equal(calls.comps, 2);
    await evaluate(listing.id);
    assert.equal(calls.comps, 2, "the corrected checkpoint can reopen without fetching more sales");
});

test("the seller name correction leaves material slab conflicts in review", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("slab conflict checks must use saved/mocked evidence only"));
    const scenarios: Array<{ label: string; title?: string; labelText?: string; grade?: string; additionalProblem?: string; records?: CardRecord[] }> = [
        { label: "different card named in the title", title: "PSA 7 Blastoise Base Set 15/102 Holo English" },
        { label: "different card named on the slab", labelText: "1999 POKEMON GAME BLASTOISE HOLO #15 EX MT 7" },
        { label: "different collector number on the slab", labelText: "1999 POKEMON GAME VENUSAUR HOLO #2 EX MT 7" },
        { label: "different grade in the title", title: "PSA 8 Venusaur Base Set 15/102 Holo English" },
        { label: "different grade in item specifics", grade: "8" },
        { label: "separate photo identity conflict", additionalProblem: "The back photo shows a different card." },
        { label: "missing exact catalog identity", records: [{ ...card, name: "Blastoise" }] },
    ];
    for (const scenario of scenarios) {
        const { listing, key, stored } = savedSlabNameConflict(scenario);
        const { evaluate, cache, calls } = harness({ details: async () => listing,
            assess: async () => assert.fail("the accepted label reading must be reused"),
            lookup: async () => scenario.records ?? [card] });
        cache.set(key, stored);
        const result = await evaluate(listing.id);
        assert.equal(result.underwriting?.verdict, "NEEDS_REVIEW", scenario.label);
        assert.equal(result.slabPricing, null, scenario.label);
        assert.equal(calls.comps, 0, scenario.label);
    }
});

test("cached plain-grade prices containing a special title reprice without another photo charge", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("saved pricing correction must use mocked providers only"));
    const full = reading(); full.condition = null; full.photoCheck.holder = "GRADED_SLAB";
    full.photoCheck.slab = { present: true, grader: "PSA", grade: "7", gradeQualifier: null, certNumber: "12345678",
        labelText: "1999 POKEMON GAME VENUSAUR HOLO #15 EX MT 7", caseCondition: "INTACT", authenticity: "NONE_SEEN", authenticityEvidence: [], concerns: [] };
    const { evaluate, calls, cache } = harness({ assess: async () => {
        calls.assessed++; return { result: full, usage: { inputTokens: 700, outputTokens: 450 } };
    } });
    const original = await evaluate("v1|special-price-correction|0");
    const saved = [...cache.entries()].find(([key]) => key.startsWith(PRIVATE_EVALUATION_PREFIX))![1];
    saved.evaluation.slabPricing.summary.sales[0].title += " Pristine";
    saved.evaluation.slabPricing.summary.median = 99999;
    const photoBefore = structuredClone(original.photoCheck), comparisonsBefore = calls.comps;
    const corrected = await evaluate("v1|special-price-correction|0");
    assert.ok(calls.comps > comparisonsBefore, "known contaminated prices cannot use the whole-evaluation cache");
    assert.equal(corrected.slabPricing?.summary?.median, original.slabPricing?.summary?.median);
    assert.deepEqual(corrected.photoCheck, photoBefore);
    assert.equal(calls.assessed, 1); assert.deepEqual(corrected.usage, []);
    const comparisonsAfter = calls.comps;
    const reopened = await evaluate("v1|special-price-correction|0");
    assert.ok(reopened.reusedSteps.includes("savedEvaluation"));
    assert.equal(calls.comps, comparisonsAfter); assert.equal(calls.assessed, 1);
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
    for (const staged of [false, true]) {
        const listing = details(staged ? { bestOffer: false, retrievedAt: new Date(now - 1000).toISOString() } : {});
        const batches: number[][] = [];
        const { evaluate, calls, cache } = harness({ details: async () => listing, assess: async (_listing, photos) => {
            batches.push(photos.map(photo => photo.number));
            const other = reading(photos.length);
            other.photoCheck.cardIdentity!.language = "Japanese";
            return { result: other, usage: { inputTokens: 700, outputTokens: 450 } };
        } });
        await assert.rejects(evaluate(listing.id), EnglishOnlyError);
        assert.equal(cache.size, 1);
        await assert.rejects(evaluate(listing.id), EnglishOnlyError);
        assert.deepEqual(batches, staged ? [[1]] : [[1, 2, 3, 4]]);
        assert.equal(calls.comps, 0); assert.equal(calls.raw, 0);
    }
});

test("seller metadata cannot turn an unknown photographed card language into a confirmed deal", async () => {
    const unknown = reading(); unknown.photoCheck.cardIdentity!.language = null;
    const { evaluate, calls } = harness({ assess: async () => { calls.assessed++; return { result: unknown, usage: { inputTokens: 700, outputTokens: 450 } }; } });
    const result = await evaluate("v1|unknown-language|0");
    assert.equal(result.identity?.status, "NEEDS_REVIEW");
    assert.equal(calls.raw, 0); assert.equal(calls.comps, 0);
    assert.ok(!result.underwriting?.verdict.startsWith("BUY"));
});

test("corrupt cached assessments with an out-of-range likely grade stop without replacement AI", async () => {
    const invalid = reading(); invalid.condition!.gradeRange = { low: 3, likely: 9, high: 8 };
    assert.throws(() => validateBoundedReading(invalid, 4), StorageUnavailableError);
    const { evaluate, calls, cache } = harness();
    cache.set(boundedAssessmentKey(details()), { version: BOUNDED_ASSESSMENT_VERSION, answeredAt: new Date(now).toISOString(), ...invalid });
    await assert.rejects(evaluate("v1|bounded|0"), StorageUnavailableError); assert.equal(calls.assessed, 0);
});

test("a rejected paid remainder is retained across evaluator instances without replacing accepted photo evidence", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("replaying an invalid paid answer must remain offline"));
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "flipper-rejected-assessment-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = createCacheStore({ directory, backend: () => "file" });
    const item = details({ bestOffer: false });
    const plan = boundedAssessmentPlan(item);
    const front = reading(1); front.condition!.gradeRange = null;
    const remainder = stagedPhotoPlan(item, plan, "remainder", front);
    const firstKey = stagedPhotoPlan(item, plan, "front").key;
    const rejected = reading(remainder.photos.length); rejected.condition!.gradeRange = { low: 3, likely: 9, high: 8 };
    const usage = { inputTokens: 900, outputTokens: 700 };
    const attempts: string[] = [];
    const makeEvaluator = () => harness({ details: async () => item, cached: store.read, save: store.write,
        assess: async (_listing, _photos, _signal, _mode, stage) => {
            attempts.push(stage?.kind ?? "combined");
            return { result: stage?.kind === "front" ? front : rejected, usage };
        } }).evaluate;

    const assertListingRejection = (error: unknown) => {
        assert.ok(error instanceof RejectedPhotoAssessmentError);
        assert.match(error.message, /grade and its range/);
        assert.deepEqual(evaluationFailure(error), { status: 422, code: "PHOTO_ASSESSMENT_REJECTED", error: error.message, retryable: false });
        return true;
    };
    await assert.rejects(makeEvaluator()(item.id), assertListingRejection);
    const savedFront = await store.read(firstKey, 1);
    assert.deepEqual(savedFront?.photoCheck, front.photoCheck);
    assert.equal(await store.read(remainder.key, 1), null);
    const savedRejection = await store.read(`${remainder.key}:rejected`, 1);
    assert.deepEqual(savedRejection?.result, rejected);
    assert.deepEqual(savedRejection?.usage, usage);
    assert.equal(savedRejection?.version, remainder.version);
    assert.deepEqual(savedRejection?.photoNumbers, remainder.photos.map(photo => photo.number));
    assert.match(savedRejection?.reason ?? "", /incomplete or invalid/);

    await assert.rejects(makeEvaluator()(item.id), assertListingRejection);
    for (const damaged of [{ ...savedRejection, photoNumbers: [] }, { ...savedRejection, result: reading(remainder.photos.length) }]) {
        await store.write(`${remainder.key}:rejected`, damaged);
        await assert.rejects(makeEvaluator()(item.id), StorageUnavailableError);
    }
    await store.write(`${remainder.key}:rejected`, savedRejection);
    await store.write(plan.key, { ...reading(), version: plan.version, answeredAt: new Date(now).toISOString(), usage });
    const recovered = await makeEvaluator()(item.id);
    assert.equal(recovered.underwriting?.verdict, "BUY_AND_GRADE");
    assert.deepEqual(attempts, ["front", "remainder"]);
    assert.deepEqual(await store.read(firstKey, 1), savedFront);
    assert.deepEqual(await store.read(`${remainder.key}:rejected`, 1), savedRejection);
});

test("a documented authenticity concern without a photo location recovers paid observations and stays out of Deals", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("replaying the saved reading must remain offline"));
    const item = details(), plan = boundedAssessmentPlan(item), input = reading();
    input.condition!.authenticity = { concern: "POSSIBLE", reasons: ["No clear manufacturing anomaly is visible."],
        limitations: ["Sleeve glare hides the surface and card stock."], observations: [] };
    const { evaluate, cache, calls } = harness({ details: async () => item,
        assess: async () => assert.fail("the original photos were already assessed"),
        stamp: async () => assert.fail("pricing and stamp checks cannot resolve authenticity"),
    });
    cache.set(`${plan.key}:rejected`, { result: input, version: plan.version, answeredAt: new Date(now).toISOString(),
        photoNumbers: plan.photos.map(photo => photo.number), usage: { inputTokens: 800, outputTokens: 600 },
        reason: "The bounded photo assessment is incomplete or invalid. Saved evidence was kept; no automatic replacement assessment was authorized." });
    for (const attempt of [1, 2]) {
        const result = await evaluate(item.id);
        assert.equal(result.identity?.name, "Venusaur");
        assert.equal(result.listing.photosAnalyzed, plan.photos.length);
        assert.equal(result.condition?.rawCondition, input.condition?.rawCondition);
        assert.equal(result.condition?.authenticity.concern, "POSSIBLE");
        assert.deepEqual(result.condition?.authenticity.observations, []);
        assert.equal(result.underwriting?.verdict, "NEEDS_REVIEW");
        assert.ok(result.underwriting.reasons.some(reason => reason.includes("without identifying a specific feature")));
        assert.deepEqual(result.usage, [], `attempt ${attempt} must reuse all paid photo work`);
        assert.equal(resultGroup({ ...item, currentPrice: item.price, isGraded: false }, result), "review");
    }
    assert.equal(calls.comps + calls.raw, 0);
});

test("an unlocated front-photo concern stops the staged search before a second paid reading", async () => {
    const item = details({ bestOffer: false });
    const stages: string[] = [];
    const { evaluate } = harness({ details: async () => item, assess: async (_listing, photos, _signal, _mode, stage) => {
        stages.push(stage?.kind ?? "combined");
        const report = reading(photos.length);
        report.condition!.authenticity = { concern: "POSSIBLE", reasons: ["Authenticity uncertain."],
            limitations: ["Card stock obscured in sleeve."], observations: [] };
        return { result: report, usage: { inputTokens: 900, outputTokens: 500 } };
    } });
    const result = await evaluate(item.id);
    assert.deepEqual(stages, ["front"]);
    assert.equal(result.listing.photosAnalyzed, 1);
    assert.equal(result.underwriting?.verdict, "NEEDS_REVIEW");
    assert.equal(result.condition?.authenticity.concern, "POSSIBLE");
});

test("a wide photo grade keeps its original estimate and raw resale route on first assessment and saved rejection replay", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("the wide grade replay must stay offline"));
    const listing = details({ bestOffer: false, images: [photo(1), photo(2)] });
    const plan = boundedAssessmentPlan(listing);
    const front = reading(1); front.condition!.gradeRange = null;
    const back = reading(1); back.photoCheck.images[0].view = "BACK";
    back.condition!.rawCondition = "LIGHTLY_PLAYED";
    back.condition!.gradeRange = { low: 3, likely: 5, high: 6 };
    const remainder = stagedPhotoPlan(listing, plan, "remainder", front);
    const frontPlan = stagedPhotoPlan(listing, plan, "front");
    const usage = { inputTokens: 1200, outputTokens: 700 };
    const answeredAt = new Date(now).toISOString();
    for (const saved of [false, true]) {
        let sales: Comp[] = [];
        const charged: string[] = [];
        const { evaluate, cache } = harness({ details: async () => listing,
            fetchRawComps: async () => sales,
            fetchComps: async () => assert.fail("a broad range cannot sponsor grading research"),
            assess: async (_listing, _photos, _signal, _mode, stage) => {
                charged.push(stage?.kind ?? "combined");
                return { result: stage?.kind === "front" ? front : back, usage };
            } });
        sales = seedRawSoldCopies(cache, listing, "LIGHTLY_PLAYED", 150, now);
        if (saved) {
            cache.set(frontPlan.key, { ...front, version: frontPlan.version, answeredAt, usage });
            cache.set(`${remainder.key}:rejected`, { result: back, version: remainder.version, answeredAt, usage, photoNumbers: [2],
                reason: "The bounded photo assessment is incomplete or invalid. Saved evidence was kept; no automatic replacement assessment was authorized." });
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = await evaluate(listing.id);
            assert.deepEqual(result.photoCheck?.images.map(({ number, view }) => [number, view]), [[1, "FRONT"], [2, "BACK"]]);
            assert.equal(result.condition?.rawCondition, "LIGHTLY_PLAYED");
            assert.equal(result.condition.gradeRange, null);
            assert.deepEqual(displayedRawGrade(result), { range: { low: 3, likely: 5, high: 6 }, confidence: "LOW", source: "PROVISIONAL" });
            assert.equal(result.rawPricing?.status, "PRICED");
            assert.equal(result.underwriting?.verdict, "BUY_RAW");
            if (saved || attempt > 0) assert.deepEqual(result.usage, []);
        }
        assert.deepEqual(charged, saved ? [] : ["front", "remainder"]);
    }
});

test("a tentative grade with only lower-condition photo sales reuses surrounding PSA sales, independently of the grading verdict", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("no new provider work during the replay"));
    const listing = details({ price: 99 });
    const input = reading();
    input.condition!.rawCondition = "HEAVILY_PLAYED";
    input.condition!.gradeRange = { low: 2, likely: 3, high: 4 };
    input.condition!.confidence = "LOW";
    let rawSales: Comp[] = [], rawLookups = 0, cachedRecordLookups = 0;
    const queried: string[] = [];
    const { evaluate, cache } = harness({ details: async () => listing,
        assess: async () => assert.fail("the saved listing photos must be reused"),
        fetchRawComps: async () => { rawLookups++; return rawSales; },
        cachedPricingRecord: async id => { cachedRecordLookups++; assert.equal(id, String(card.id)); return card; },
        fetchComps: async () => assert.fail("tentative estimates cannot sponsor live grade pricing"),
        fetchCachedComps: async (_id, target) => { queried.push(`${target.grader} ${target.grade}`); return gradedSales(target); },
    });
    const plan = boundedAssessmentPlan(listing);
    cache.set(plan.key, { ...input, version: plan.version, answeredAt: new Date(now).toISOString() });
    rawSales = seedRawSoldCopies(cache, listing, "DAMAGED", 8, now);
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await evaluate(listing.id);
        assert.equal(result.condition?.gradeRange, null);
        assert.deepEqual(result.gradedPricing?.PSA?.referenceByGrade?.map(row => [row.grade, row.count]), [[2, 5], [3, 5], [4, 5]]);
        assert.equal(result.gradedPricing?.PSA?.referenceGradeComps?.grade, 3);
        assert.equal(result.gradedPricing?.PSA?.status, "PRICE_UNAVAILABLE");
        assert.equal(result.gradedPricing?.PSA?.byGrade, undefined);
        assert.equal(result.underwriting?.verdict, "CANT_PRICE");
        assert.deepEqual(result.usage, []);
        if (attempt > 0) assert.ok(result.reusedSteps.includes("savedEvaluation"));
    }
    const neighboringQueries = ["PSA 2", "PSA 3", "PSA 4"];
    assert.deepEqual(queried, neighboringQueries);
    assert.equal(cachedRecordLookups, 0);

    // Install an otherwise fresh private evaluation written before neighboring reference sales were stored.
    const key = [...cache.keys()].find(key => key.startsWith(PRIVATE_EVALUATION_PREFIX))!;
    const older = cache.get(key).evaluation;
    delete older.gradedPricing.PSA.referenceByGrade;
    const originalRawLookups = rawLookups;
    for (let replay = 0; replay < 2; replay++) {
        const result = await evaluate(listing.id);
        assert.ok(result.reusedSteps.includes("savedEvaluation"));
        assert.deepEqual(result.usage, []);
        assert.equal(result.pricesCheckedAt, older.pricesCheckedAt);
        assert.deepEqual(result.gradedPricing?.PSA?.referenceByGrade?.map(row => row.grade), [2, 3, 4]);
        assert.equal(result.gradedPricing?.PSA?.byGrade, undefined);
        assert.equal(result.underwriting?.verdict, "CANT_PRICE");
    }
    assert.equal(cachedRecordLookups, 1);
    assert.equal(rawLookups, originalRawLookups, "an accepted raw valuation must not be refreshed to add grading context");
    assert.deepEqual(queried, [...neighboringQueries, ...neighboringQueries]);
});

test("a provisional grade with unknown raw wear can show cached exact slab sales for context", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("a grade reference must stay offline"));
    const listing = details(), input = reading();
    input.condition!.rawCondition = "UNKNOWN";
    input.condition!.gradeRange = { low: 5, likely: 7, high: 8 };
    const queried: string[] = [];
    const { evaluate, cache } = harness({ details: async () => listing,
        assess: async () => assert.fail("the saved listing photos must be reused"),
        fetchRawComps: async () => assert.fail("no raw sale category has been established"),
        fetchComps: async () => assert.fail("provisional grade references must use only cached sales"),
        fetchCachedComps: async (_id, options) => {
            queried.push(`${options.grader} ${options.grade}`); return gradedSales(options);
        } });
    const plan = boundedAssessmentPlan(listing);
    cache.set(plan.key, { ...input, version: plan.version, answeredAt: new Date(now).toISOString() });
    const result = await evaluate(listing.id);
    assert.deepEqual(queried, ["PSA 7"]);
    assert.equal(result.gradedPricing?.PSA?.referenceGradeComps?.grade, 7);
    assert.equal(result.gradedPricing?.PSA?.status, "PRICE_UNAVAILABLE");
    assert.equal(result.gradedPricing?.PSA?.byGrade, undefined);
    assert.equal(result.rawPricing, null);
    assert.equal(result.underwriting?.verdict, "CANT_PRICE");
    assert.deepEqual(result.usage, []);
});

test("budget and storage stops propagate instead of launching remaining research", async () => {
    const writeFailure = harness({
        assess: async () => ({ result: reading(1), usage: { inputTokens: 900, outputTokens: 700 } }),
        save: async key => { assert.ok(key.endsWith(":rejected")); throw new Error("Disk full"); },
    });
    await assert.rejects(writeFailure.evaluate("v1|failed-rejection-write|0"), error =>
        error instanceof StorageUnavailableError && evaluationFailure(error).code === "STORAGE_UNAVAILABLE" &&
        error.cause instanceof Error && error.cause.message === "Disk full");
    for (const failure of [new AiSpendingError("AI_BUDGET", "Search budget exhausted."), new StorageUnavailableError()]) {
        const { evaluate, calls } = harness({ fetchComps: async () => { calls.comps++; throw failure; } });
        await assert.rejects(evaluate("v1|bounded|0"), error => error === failure);
        assert.equal(calls.comps, 1, "no other grade/grader research starts after a controlled stop");
    }
});

test("a fresh complete legacy evaluation retains preference over a newer bounded reading without new lookups", async () => {
    const listing = details(), full = reading(), oldEvaluation = cardEvaluation();
    oldEvaluation.rawPricing = { status: "PRICED", conditionEvidence: "AI_PHOTOS", prices: [{ condition: "LIGHTLY_PLAYED",
        price: 85, updatedAt: new Date(now).toISOString(), basis: "EBAY_SOLD", comps: salesSummary("RAW", "LIGHTLY_PLAYED", [80, 85, 90]) }] };
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
    assert.deepEqual(await drainSharedWork(), { complete: true, pending: 0 });
    assert.equal(cache.size, 1, "accepted evidence is saved after its browser consumer detaches");
    assert.equal(calls.comps, 0); assert.equal(calls.raw, 0);
    const next = await evaluate("v1|bounded|0");
    assert.equal(calls.assessed, 1);
    assert.ok(next.reusedSteps.includes("boundedPhotoAssessment"));
});

test("CLI shutdown drains the accepted reading's final cache save after its evaluator consumer stops", async () => {
    let started!: () => void, respond!: () => void, saving!: () => void, finishSave!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const response = new Promise<void>(resolve => { respond = resolve; });
    const enteredSave = new Promise<void>(resolve => { saving = resolve; });
    const storageReady = new Promise<void>(resolve => { finishSave = resolve; });
    const saved = new Map<string, unknown>();
    let storageClosed = false;
    const { evaluate, calls } = harness({ assess: async (_listing, photos) => {
        calls.assessed++; started(); await response;
        return { result: reading(photos.length), usage: { inputTokens: 900, outputTokens: 700 } };
    }, save: async (key, value) => {
        saving(); await storageReady;
        assert.equal(storageClosed, false, "a detached accepted answer must retain storage until its final cache write");
        saved.set(key, structuredClone(value));
    } });
    const stop = new AbortController(), consumer = evaluate("v1|bounded|0", { signal: stop.signal });
    await began; stop.abort(); await assert.rejects(consumer, { name: "AbortError" });
    let drained = false;
    const shutdown = drainSharedWork().then(result => { drained = true; storageClosed = true; return result; });
    respond(); await enteredSave;
    assert.equal(drained, false); assert.equal(saved.size, 0);
    assert.deepEqual(await drainSharedWork({ timeoutMs: 0 }), { complete: false, pending: 1 });
    finishSave();
    assert.deepEqual(await shutdown, { complete: true, pending: 0 });
    assert.equal(saved.size, 1); assert.equal(calls.assessed, 1);
    assert.equal(calls.comps, 0); assert.equal(calls.raw, 0, "Stop must not begin downstream paid pricing while draining accepted photos");
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

test("a fixed-price search skips a refreshed auction before paying, even when another search can assess the same item", async () => {
    const auction = details({ buyingOption: "AUCTION", price: 32.4, endTime: new Date(now + 2 * 3600000).toISOString(),
        retrievedAt: new Date(now).toISOString() });
    const current = { buyingOption: "FIXED_PRICE" as const, price: 125, shipping: 8.4, bids: 0, endTime: null,
        termsCheckedAt: new Date(now - 60000).toISOString() };
    const { evaluate, calls } = harness({ details: async () => auction });
    const skipped = await evaluate(auction.id, { automatic: true, typeFilter: "FIXED_PRICE", current });
    assert.equal(skipped.gradeStatus, "SKIPPED_LISTING_FORMAT");
    assert.match(skipped.modeReasons[0], /auction.*Buy It Now/);
    assert.equal(skipped.listing.buyingOption, "AUCTION");
    assert.equal(skipped.listing.price, 32.4);
    assert.equal(calls.assessed + calls.raw + calls.comps, 0);
    const [fixed, either] = await Promise.all([
        evaluate(auction.id, { automatic: true, typeFilter: "FIXED_PRICE", current }),
        evaluate(auction.id, { automatic: true, typeFilter: "all", current }),
    ]);
    assert.equal(fixed.gradeStatus, "SKIPPED_LISTING_FORMAT");
    assert.ok(either.photoCheck);
    assert.equal(calls.assessed, 1);
});

test("automatic auctions recheck the 10-hour window while explicit manual analysis remains available", async () => {
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

test("changed or missing edition item specifics recheck saved photos before reusing First Edition prices", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("edition cache correction must use only supplied offline evidence"));
    for (const source of ["private", "old-private", "legacy"]) for (const field of ["Edition", "Features", "Printing"]) {
        let listing = details({ id: `v1|edition-cache-${source}-${field}|0`, aspects: { ...details().aspects, [field]: "1st Edition" } });
        const accepted = reading();
        accepted.photoCheck.printingMarks = { firstEditionStamp: "VISIBLE", artBoxShadow: "ABSENT", reprintMark: "NONE_SEEN", evidence: ["The First Edition stamp is visible."] };
        const firstEditionCard = { ...structuredClone(card), variants: [
            { name: "1st Edition Holofoil", printing: "FIRST_EDITION", finish: "HOLO" },
            ...structuredClone(card.variants),
        ] };
        let checkpoint: SavedRecord | null = null;
        const { evaluate, calls, cache } = harness({ details: async () => listing, saved: async () => checkpoint,
            assess: async () => { calls.assessed++; return { result: structuredClone(accepted), usage: { inputTokens: 700, outputTokens: 450 } }; },
            lookup: async () => [structuredClone(firstEditionCard)],
            fetchRawComps: async () => { calls.raw++; return []; },
            fetchComps: async (_id, options) => {
                calls.comps++;
                assert.equal(options.variant, "1st Edition Holofoil", "a verified First Edition copy cannot request Unlimited prices");
                return [{ id: `${options.grader}-${options.grade}`, title: `Venusaur Base Set 15/102 1st Edition Holo ${options.grader} ${options.grade}`,
                    price: 500 + Number(options.grade) * 10, sold_at: new Date(now - 86400000).toISOString(), variant: options.variant,
                    grader: options.grader, grade: String(options.grade), grade_qualifier: null, currency: "USD", sale_type: "fixed_price", attribution: "exact", listing_url: null }];
            } });
        const original = await evaluate(listing.id);
        assert.equal(original.identity?.printing, "FIRST_EDITION");
        assert.equal(original.gradedPricing?.PSA?.printing, "FIRST_EDITION");
        const photoKey = boundedAssessmentKey(listing), savedPhotoAnswer = structuredClone(cache.get(photoKey));
        const marketCalls = calls.raw + calls.comps;
        if (source === "old-private") {
            // Before this correction the hash omitted these fields, so a
            // First Edition checkpoint collides with today's unstated claim.
            const saved = [...cache.entries()].find(([key]) => key.startsWith(PRIVATE_EVALUATION_PREFIX))![1];
            saved.contextKey = evaluationContextKey({ ...listing, aspects: Object.fromEntries(Object.entries(listing.aspects).filter(([name]) => name !== field)) });
        }
        if (source === "legacy") checkpoint = {
            itemId: listing.id, version: ANALYSIS_VERSION, photoFingerprint: photoFingerprint(listing.images), answeredAt: original.answeredAt,
            reviewContext: { title: listing.title, photos: listing.images },
            photoCheck: { result: structuredClone(accepted.photoCheck), usage: { inputTokens: 700, outputTokens: 450 } },
            assessment: { version: CONDITION_VERSION, mode: "FULL", photoNumbers: [1, 2, 3, 4], result: structuredClone(accepted.condition!), setAside: [] },
            latestEvaluation: { evidenceKey: listingEvidenceKey({ title: listing.title, images: listing.images }), evaluation: original },
        };
        for (const claim of [null, "Unlimited"]) {
            const aspects = Object.fromEntries(Object.entries(listing.aspects).filter(([name]) => name !== field));
            listing = { ...listing, aspects: { ...aspects, ...(claim ? { [field]: claim } : {}) } };
            assert.equal(boundedAssessmentKey(listing), photoKey, "edition metadata does not invalidate accepted paid photo inputs");
            const changed = await evaluate(listing.id);
            assert.equal(changed.reusedSteps.includes("savedEvaluation"), false, `${source}/${field}/${claim}`);
            assert.equal(changed.identity?.status, "NEEDS_REVIEW"); assert.equal(changed.identity?.printing, "UNKNOWN");
            assert.equal(changed.underwriting?.verdict, "NEEDS_REVIEW"); assert.equal(changed.gradedPricing, null);
            assert.deepEqual(changed.photoCheck, original.photoCheck);
            assert.equal(calls.assessed, 1); assert.deepEqual(changed.usage, []);
            assert.equal(calls.raw + calls.comps, marketCalls, "unresolved printing cannot borrow the old First Edition prices");
            assert.deepEqual(cache.get(photoKey), savedPhotoAnswer);
        }
        listing = { ...listing, aspects: { ...listing.aspects, [field]: "First Edition, Holofoil" } };
        const restored = await evaluate(listing.id);
        assert.equal(restored.identity?.printing, "FIRST_EDITION"); assert.equal(restored.gradedPricing?.PSA?.printing, "FIRST_EDITION");
        const restoredMarketCalls = calls.raw + calls.comps;
        const reopened = await evaluate(listing.id);
        assert.ok(reopened.reusedSteps.includes("savedEvaluation"));
        assert.equal(calls.raw + calls.comps, restoredMarketCalls); assert.equal(calls.assessed, 1);
        assert.deepEqual(cache.get(photoKey), savedPhotoAnswer);
    }
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

test("expired or superseded private prices refresh without repurchasing the photo assessment", async () => {
    for (const reason of ["age", "pricing policy"]) {
        let clock = now;
        const { evaluate, calls, cache } = harness({ now: () => clock });
        const first = await evaluate("v1|price-expiry|0");
        const marketCalls = calls.comps + calls.raw;
        if (reason === "pricing policy") for (const [key, value] of cache) {
            if (key.startsWith(PRIVATE_EVALUATION_PREFIX)) value.evaluation.pricingVersion = "previous-price-policy";
        }
        clock += reason === "age" ? 6 * 3600000 + 1 : 1;
        const next = await evaluate("v1|price-expiry|0");
        assert.equal(calls.assessed, 1, reason);
        assert.ok(next.reusedSteps.includes("boundedPhotoAssessment"));
        assert.ok(calls.comps + calls.raw > marketCalls);
        assert.equal(next.pricingVersion, PRICING_VERSION);
        assert.equal(next.answeredAt, first.answeredAt);
        assert.notEqual(next.pricesCheckedAt, first.pricesCheckedAt);
    }
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

test("an eligible stamp crop changes the real evaluator's verdict and survives a reprice", async () => {
    const item = details({
        title: "Venusaur Base Set 15/102 1st Edition Holo English",
        price: 80, retrievedAt: new Date(now).toISOString(),
    });
    const report = reading();
    report.condition!.gradeRange = null;
    report.condition!.rawCondition = "LIGHTLY_PLAYED";
    report.photoCheck.printingMarks = { firstEditionStamp: "CANT_TELL", artBoxShadow: "ABSENT", reprintMark: "NONE_SEEN", evidence: [] };
    let stampCalls = 0, originalCalls = 0;
    let priceFailure: Error | null = null, stampFailure: Error | null = null;
    const { evaluate } = harness({
        details: async () => item,
        assess: async () => { originalCalls++; return { result: report, usage: { inputTokens: 900, outputTokens: 300 } }; },
        lookup: async () => [{ ...card, setName: "Base Set (Shadowless)",
            variants: [
                { name: "1st Edition Holofoil", printing: "FIRST_EDITION", finish: "HOLO" },
                { name: "Unlimited Holofoil", printing: "SHADOWLESS", finish: "HOLO" },
            ] }],
        fetchRawComps: async (_id, variant) => {
            if (priceFailure) throw priceFailure;
            const first = /1st edition/i.test(variant ?? "");
            return [{ id: first ? "first" : "shadowless", title: `Venusaur Base Set 15/102 ${first ? "1st Edition" : "Shadowless"} Holo LP`,
                price: first ? 220 : 70, sold_at: new Date(now - 86400000).toISOString(),
                variant: first ? "1st Edition Holofoil" : "Unlimited Holofoil", currency: "USD", attribution: "exact",
                sale_type: "fixed_price", listing_url: "https://www.ebay.com/itm/223456789012", grader: null, grade: null, grade_qualifier: null }];
        },
        soldCondition: () => ({
            usage: [], status: () => "REVIEWED",
            read: async () => ({ condition: "LIGHTLY_PLAYED", evidence: ["Accepted physical wear evidence."], photoCount: 4 }),
            acquire: async () => assert.fail("stamp scenarios must not buy sold-copy assessments"),
        }),
        stamp: async () => {
            stampCalls++;
            if (stampFailure) throw stampFailure;
            return { result: "VISIBLE", reused: false, key: "fixture", answeredAt: new Date(now).toISOString(),
                usage: { inputTokens: 100, outputTokens: 10 },
                source: { photoNumber: 1, sourceSha256: "a".repeat(64), box: { left: 90, top: 90, width: 200, height: 140 } } };
        },
    });
    const highTarget = await evaluate(item.id, { targets: { minProfit: 1000, minRoi: 0 } });
    assert.equal(highTarget.underwriting?.verdict, "NEEDS_REVIEW");

    priceFailure = new PriceResearchBudgetError("Price accounting is invalid.", "STATE");
    await assert.rejects(evaluate(item.id), error => error === priceFailure);
    priceFailure = new PriceResearchBudgetError("Price research allowance reached.", "LIMIT");
    assert.equal((await evaluate(item.id)).pricingDeferred?.provider, "PKMNPRICES");
    assert.equal(stampCalls, 0);
    priceFailure = null;

    const storageError = new StorageUnavailableError("Focused stamp evidence could not be read.");
    stampFailure = new Error("Wrapped crop error", { cause: storageError });
    await assert.rejects(evaluate(item.id), error => error === storageError);
    const heldStamp = new AiSpendingError("AI_EVIDENCE_HELD", "The previous stamp check has an unresolved outcome.");
    stampFailure = new Error("Wrapped crop error", { cause: heldStamp });
    await assert.rejects(evaluate(item.id), error => error === heldStamp);
    stampFailure = new AiSpendingError("AI_BUDGET", "The optional stamp request could not be reserved.");
    const denied = await evaluate(item.id);
    assert.equal(denied.underwriting?.verdict, "NEEDS_REVIEW");
    assert.equal(denied.focusedStamp, undefined);
    stampFailure = null;

    const result = await evaluate(item.id);
    assert.equal(result.focusedStamp?.result, "VISIBLE");
    assert.equal(result.identity?.printing, "FIRST_EDITION");
    assert.equal(result.underwriting?.verdict, "BUY_RAW");
    assert.equal(stampCalls, 4);
    assert.equal(originalCalls, 1);
    assert.equal(report.photoCheck.printingMarks.firstEditionStamp, "CANT_TELL");
    item.price = 300;
    const repriced = await evaluate(item.id);
    assert.equal(repriced.identity?.printing, "FIRST_EDITION");
    assert.equal(repriced.underwriting?.verdict, "PASS");
    assert.equal(stampCalls, 4);
    assert.equal(originalCalls, 1);
});

test("Neo Destiny resolves a manually requested ordinary printing from its saved front and reuses the observation", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("the replay must not contact providers"));
    const searchId = randomUUID();
    for (const observed of ["NOT_PRESENT", "VISIBLE", "CANT_TELL"] as const) {
        const item = details({ id: "v1|840157638714|0", title: "Dark Gengar 6/105 Neo Destiny Holo Pokemon Card NM",
            price: 1076, shipping: 5.95, retrievedAt: new Date(now).toISOString(), images: [photo(1), photo(2)],
            aspects: { "Card Name": "Dark Gengar", "Card Number": "6/105", Set: "Neo Destiny", Finish: "Holo", Language: "English" } });
        const report = reading(2);
        Object.assign(report.photoCheck, { holder: "SLEEVE", printedName: "Dark Gengar", printedNumber: "6/105" });
        Object.assign(report.photoCheck.cardIdentity!, { name: "Dark Gengar", cardNumber: "6/105", set: "Neo Destiny" });
        report.photoCheck.images[0].obscuresCondition = true;
        report.photoCheck.printingMarks = { firstEditionStamp: "CANT_TELL", artBoxShadow: "CANT_TELL", reprintMark: "NONE_SEEN", evidence: [] };
        let cropCount = 0;
        const { evaluate, cache } = harness({
            details: async () => item, assess: async () => assert.fail("use the saved original photos"),
            lookup: async () => [{ ...card, name: "Dark Gengar", setName: "Neo Destiny", cardNumber: "006/105",
                variants: [{ name: "Unlimited Holofoil", printing: "UNLIMITED", finish: "HOLO" },
                    { name: "1st Edition Holofoil", printing: "FIRST_EDITION", finish: "HOLO" }] }],
            fetchRawComps: async () => [], fetchComps: async () => [],
            stamp: async () => {
                assert.equal(getAiUsageContext().searchId, searchId);
                cropCount++;
                return { result: observed, reused: false, key: "fixture", answeredAt: new Date(now).toISOString(),
                    usage: { inputTokens: 100, outputTokens: 10 },
                    source: { method: "NEO_DESTINY_CONTEXT_V1", observation: "Compared the artwork corner to the enlarged stamp area.", photoNumber: 1, sourceSha256: "d".repeat(64), box: { left: 90, top: 90, width: 200, height: 140 } } };
            },
        });
        const plan = boundedAssessmentPlan(item);
        cache.set(plan.key, { ...report, version: plan.version, answeredAt: new Date(now).toISOString() });
        await withAiUsageContext({ searchId }, () => evaluate(item.id, { automatic: true }));
        assert.equal(cropCount, 0, "automatic screening needs a financially actionable comparison");
        const checkpoint = [...cache.entries()].find(([key]) => key.startsWith(PRIVATE_EVALUATION_PREFIX))![1];
        checkpoint.evaluation.focusedStamp = { result: "CANT_TELL", photoNumber: 1,
            sourceSha256: "d".repeat(64), box: { left: 90, top: 90, width: 200, height: 140 } };
        const priceOnly = await withAiUsageContext({ searchId }, () => evaluate(item.id, { priceOnly: true }));
        assert.equal(priceOnly.focusedStamp?.result, "CANT_TELL");
        assert.equal(cropCount, 0, "price-only refresh cannot buy a context retry");
        const assessment = await withAiUsageContext({ searchId }, () => evaluate(item.id));
        assert.equal(assessment.focusedStamp?.result, observed);
        assert.equal(assessment.identity?.printing, observed === "NOT_PRESENT" ? "UNLIMITED" : "UNKNOWN");
        assert.equal(assessment.photoCheck?.printingMarks?.firstEditionStamp, observed);
        const again = await withAiUsageContext({ searchId }, () => evaluate(item.id, { priceOnly: true }));
        assert.deepEqual(again.focusedStamp, assessment.focusedStamp);
        assert.equal(again.identity?.printing, assessment.identity?.printing);
        const repeat = await withAiUsageContext({ searchId }, () => evaluate(item.id));
        assert.deepEqual(repeat.focusedStamp, assessment.focusedStamp, "even an inconclusive full-context answer is final for this source");
        assert.equal(cropCount, 1);
        assert.equal(report.photoCheck.printingMarks.firstEditionStamp, "CANT_TELL");
    }
});

test("a focused artwork-frame check resolves a photographed English Base Set printing and reuses its result on reprice", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("the offline replay must not contact a provider"));
    const originalSearch = randomUUID();
    for (const edge of ["PRESENT", "UNCLEAR"] as const) {
        const item = details({ title: "Mewtwo Base Set Unlimited 10/102 Holo English", price: 24.99, shipping: 6.65, retrievedAt: new Date(now).toISOString() });
        Object.assign(item.aspects, { "Card Name": "Mewtwo", "Card Number": "10/102" });
        const report = reading();
        report.photoCheck.printedName = "Mewtwo";
        report.photoCheck.printedNumber = "10/102";
        Object.assign(report.photoCheck.cardIdentity!, { name: "Mewtwo", cardNumber: "10/102" });
        report.photoCheck.printingMarks = { artBoxShadow: "CANT_TELL", firstEditionStamp: "CANT_TELL", reprintMark: "NONE_SEEN", evidence: ["The frame could not be read."] };
        const record: CardRecord = { ...card, name: "Mewtwo", cardNumber: "10/102" };
        let calls = 0;
        const { evaluate, cache } = harness({
            details: async () => item, lookup: async () => [record],
            assess: async () => assert.fail("reuse the paid gallery"),
            fetchRawComps: async () => [], fetchComps: async () => [], compChecks: async () => new Map(),
            frame: async () => {
                calls++;
                assert.equal(getAiUsageContext().searchId, originalSearch);
                assert.equal(getAiUsageContext().listingId, item.id);
                return { focus: { rightEdge: edge, bottomEdge: edge, stamp: "NOT_PRESENT", observation: "The view shows the artwork border and stamp area.", sourceSha256: "b".repeat(64), photoNumber: 1 }, reused: false, usage: { inputTokens: 112, outputTokens: 24 } };
            },
        });
        const plan = boundedAssessmentPlan(item);
        cache.set(plan.key, { ...report, version: plan.version, answeredAt: new Date(now).toISOString() });
        const initial = await withAiUsageContext({ searchId: originalSearch }, () => evaluate(item.id));
        assert.equal(calls, 1);
        assert.equal(initial.focusedPrinting?.rightEdge, edge);
        assert.equal(initial.identity?.printing, edge === "PRESENT" ? "UNLIMITED" : "UNKNOWN");
        assert.equal(initial.identity?.status, edge === "PRESENT" ? "IDENTIFIED" : "NEEDS_REVIEW");
        if (edge === "UNCLEAR") assert.equal(initial.underwriting?.verdict, "NEEDS_REVIEW");
        assert.equal(report.photoCheck.printingMarks.artBoxShadow, "CANT_TELL");
        const again = await withAiUsageContext({ searchId: originalSearch }, () => evaluate(item.id, { priceOnly: true }));
        assert.deepEqual(again.focusedPrinting, initial.focusedPrinting);
        assert.deepEqual(again.identity?.printing, initial.identity?.printing);
        assert.ok(again.reusedSteps.includes("focusedArtworkFrame"));
        assert.equal(calls, 1);
    }
});


test("a new frame observation cannot erase an explicit disagreement, invent a stamp, or establish a premium edition from two different edges", () => {
    const check = reading().photoCheck;
    const observation = { rightEdge: "PRESENT", bottomEdge: "PRESENT", stamp: "CANT_TELL", observation: "A dark band follows both gold edges.", sourceSha256: "b".repeat(64), photoNumber: 1 } as const;
    check.printingMarks!.firstEditionStamp = "CANT_TELL";
    assert.equal(applyFrameReading(check, observation)?.printingMarks?.firstEditionStamp, "CANT_TELL");
    assert.equal(applyFrameReading(check, { ...observation, rightEdge: "ABSENT" }), null);
    assert.equal(applyFrameReading(check, { ...observation, rightEdge: "ABSENT", bottomEdge: "ABSENT", stamp: "NOT_PRESENT" }), null);
    assert.equal(applyFrameReading(check, { ...observation, stamp: "VISIBLE" }), null);
    check.printingMarks!.conflicts = ["artBoxShadow"];
    assert.equal(applyFrameReading(check, { ...observation, stamp: "NOT_PRESENT" }), null);
});

test("Legendary Collection Charizard uses the complete PSA subject for pricing and invalidates a stale holo valuation", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("this replay must use saved evidence"));
    const listing = details({ title: "Charizard #3/110 Holo - Pokemon 2002 Legendary Collection - PSA 9",
        price: 1350, shipping: 5.99, condition: "Graded", cardCondition: null, images: [photo(1), photo(2)],
        aspects: { "Card Name": "Charizard", Set: "Legendary Collection", "Card Number": "3/110", Language: "English", Finish: "Holo",
            "Professional Grader": "PSA", Grade: "9" } });
    for (const [subject, expected] of [["CHARIZARD", "NON_HOLO"], ["CHARIZARD-HOLO", "HOLO"],
        ["CHARIZARD-REVERSE FOIL", "REVERSE_HOLO"], ["CHARIZARD ???", "UNKNOWN"]] as const) {
        const accepted = reading(2); accepted.condition = null;
        accepted.photoCheck.holder = "GRADED_SLAB";
        accepted.photoCheck.printedName = "Charizard"; accepted.photoCheck.printedNumber = "3/110";
        accepted.photoCheck.cardIdentity = { name: "Charizard", set: "Legendary Collection", cardNumber: "3/110", language: "English",
            confidence: "HIGH", finish: "HOLO", evidence: ["Charizard #3/110 is visible.", "Holographic foil is visible in the artwork."] };
        accepted.photoCheck.slab = { present: true, grader: "PSA", grade: "9", gradeQualifier: null, certNumber: "12345678",
            labelText: `2002 POKEMON ${subject} LEGENDARY COLLECTION #3 MINT 9 12345678`, caseCondition: "INTACT", authenticity: "NONE_SEEN", authenticityEvidence: [], concerns: [] };
        const catalog: CardRecord = { ...card, name: "Charizard", setName: "Legendary Collection", cardNumber: "003/110", variants: [
            { name: "Normal", finish: "NON_HOLO", printing: "UNLIMITED" }, { name: "Holofoil", finish: "HOLO", printing: "UNLIMITED" },
            { name: "Reverse Holofoil", finish: "REVERSE_HOLO", printing: "UNLIMITED" }] };
        const { evaluate, cache } = harness({ details: async () => listing, lookup: async () => [catalog],
            assess: async () => assert.fail("reuse the accepted slab photo"), fetchComps: async () => [] });
        const plan = boundedAssessmentPlan(listing);
        const original = { ...accepted, version: plan.version, answeredAt: new Date(now).toISOString() };
        cache.set(plan.key, structuredClone(original));
        const result = await evaluate(listing.id);
        assert.equal(result.photoCheck?.cardIdentity?.finish, expected);
        assert.equal(result.identity?.finish, expected === "UNKNOWN" ? "CONFLICTING" : expected);
        assert.equal(result.identity?.status, expected === "UNKNOWN" ? "NEEDS_REVIEW" : "IDENTIFIED");
        assert.equal(result.slabPricing?.variant, expected === "UNKNOWN" ? undefined : catalog.variants.find(v => v.finish === expected)?.name);
        assert.deepEqual(result.usage, []); assert.deepEqual(cache.get(plan.key), original);
        if (expected === "NON_HOLO") {
            const entry = [...cache.entries()].find(([key]) => key.startsWith(PRIVATE_EVALUATION_PREFIX))![1];
            Object.assign(entry.evaluation.identity, { finish: "HOLO", reasons: [] });
            entry.evaluation.photoCheck = structuredClone(accepted.photoCheck);
            entry.evaluation.slabPricing = { status: "PRICED", variant: "Holofoil", grader: "PSA", grade: "9", summary: salesSummary("PSA", "9", [2000, 2300]) };
            assert.equal(currentPriceEvidence(entry.evaluation, now), false);
            const replay = await evaluate(listing.id);
            assert.equal(replay.identity?.finish, "NON_HOLO");
            assert.equal(replay.slabPricing?.variant, "Normal");
            assert.deepEqual(replay.usage, []);

            const wrongGrade = structuredClone(accepted.photoCheck);
            wrongGrade.slab!.grade = "8";
            assert.equal(legendaryCharizardLabelFinish(wrongGrade), "UNKNOWN");
            const wrongCert = structuredClone(accepted.photoCheck);
            wrongCert.slab!.certNumber = "87654321";
            assert.equal(legendaryCharizardLabelFinish(wrongCert), "UNKNOWN");
            const otherSet = structuredClone(accepted.photoCheck);
            otherSet.cardIdentity!.set = "Base Set";
            assert.equal(legendaryCharizardLabelFinish(otherSet), null);
            const raw = structuredClone(accepted.photoCheck);
            raw.holder = "TOPLOADER";
            assert.equal(legendaryCharizardLabelFinish(raw), null);

            const holoOnly = { ...catalog, variants: catalog.variants.filter(v => v.finish === "HOLO") };
            const missing = harness({ details: async () => listing, lookup: async () => [holoOnly],
                assess: async () => assert.fail("the label already identifies the finish"),
                fetchComps: async () => assert.fail("a holo record cannot authorize non-holo sales") });
            missing.cache.set(plan.key, structuredClone(original));
            const waiting = await missing.evaluate(listing.id);
            assert.equal(waiting.identity?.status, "IDENTIFIED");
            assert.equal(waiting.identity?.finish, "NON_HOLO");
            assert.equal(waiting.identity?.recordId, null);
            assert.equal(waiting.underwriting?.verdict, "CANT_PRICE");
            assert.match(waiting.underwriting!.reasons.join(" "), /non-holo price record/i);
            assert.deepEqual(waiting.usage, []);

            const nonHoloRecord = { ...catalog, id: 42, name: "Charizard (Non-Holo)", variants: catalog.variants.filter(v => v.finish === "NON_HOLO") };
            const separate = harness({ details: async () => listing, lookup: async () => [holoOnly, nonHoloRecord],
                assess: async () => assert.fail("reuse the label"),
                fetchComps: async (id, request) => {
                    assert.equal(id, 42); assert.equal(request.variant, "Normal"); return [];
                } });
            separate.cache.set(plan.key, structuredClone(original));
            const exact = await separate.evaluate(listing.id);
            assert.equal(exact.identity?.recordId, 42);
            assert.equal(exact.slabPricing?.variant, "Normal");

        }
    }
});

test("buyer price research can settle a previously inspected sold condition on an overpriced listing without buying cold photo reviews", async () => {
    const item = details(), report = reading(), searchId = randomUUID();
    report.condition!.rawCondition = "LIGHTLY_PLAYED";
    report.condition!.gradeRange = null;
    let confirmed = false, authorizations = 0;
    const evidence = { condition: "LIGHTLY_PLAYED" as const, evidence: ["Two readings agree on edge whitening."], photoCount: 2 };
    const sale: Comp = { id: "saved-medium", title: "Venusaur Base Set 15/102 Unlimited Holo", price: 10,
        sold_at: new Date(now - 86400000).toISOString(), variant: "Holofoil", currency: "USD", attribution: "exact",
        sale_type: "fixed_price", listing_url: "https://www.ebay.com/itm/223456789010", grader: null, grade: null, grade_qualifier: null };
    const cold: Comp = { ...sale, id: "cold", price: 1000, listing_url: "https://www.ebay.com/itm/223456789011" };
    const { evaluate, cache } = harness({ assess: async () => assert.fail("reuse the buyer's listing photos"), fetchRawComps: async () => [sale, cold],
        soldCondition: () => ({ usage: [], read: async row => row === sale && confirmed ? evidence : null,
            status: row => row === sale ? "CORROBORATABLE" : "UNREVIEWED",
            acquire: async (row, _, __, verify) => {
                assert.equal(row, sale); assert.equal(verify, true); authorizations++; confirmed = true; return evidence;
            } }) });
    const plan = boundedAssessmentPlan(item);
    cache.set(plan.key, { ...report, version: plan.version, answeredAt: new Date(now).toISOString() });
    // Seed the saved price gap; ordinary price refreshes only reuse historical photos.
    const store = createPrivateEvaluationStore({ cached: async key => cache.get(key) ?? null, save: async (key, value) => { cache.set(key, value); } });
    const fixture = harness({ assess: async () => ({ result: report, usage: { inputTokens: 1, outputTokens: 1 } }), fetchRawComps: async () => [] });
    const initial = await fixture.evaluate(item.id);
    await store.save(initial, { evidenceKey: listingEvidenceKey(item), contextKey: evaluationContextKey(item), searchId });
    const refresh = (verifySoldCondition: boolean) => withAiUsageContext({ searchId, listingId: item.id }, () => evaluate(item.id, { priceOnly: true, verifySoldCondition }));
    assert.equal((await refresh(false)).rawPricing?.status, "PRICE_UNAVAILABLE");
    const verified = await refresh(true);
    assert.equal(verified.rawPricing?.prices?.find(p => p.condition === "LIGHTLY_PLAYED")?.price, 10);
    assert.equal((await refresh(true)).rawPricing?.status, "PRICED");
    assert.equal(authorizations, 1, "an accepted single physical match closes the acquisition stage");
});

test("a hunt can resolve a saved Dark Gengar auction's edition once within its live bid budget", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("the replay must not contact providers"));
    const searchId = randomUUID();
    const item = details({ id: "v1|123451234567|0", title: "Dark Gengar 6/105 Neo Destiny Holo",
        buyingOption: "AUCTION", price: 25, bids: 1, auctionBids: { currentBid: 25, minimumBid: 26 },
        shipping: 3, retrievedAt: new Date(now).toISOString(), endTime: new Date(now + 3600_000).toISOString(),
        images: [photo(1), photo(2)], aspects: { Set: "Neo Destiny", Finish: "Holo", Language: "English" } });
    const original = reading(2);
    Object.assign(original.photoCheck.cardIdentity!, { name: "Dark Gengar", cardNumber: "6/105", set: "Neo Destiny" });
    original.photoCheck.printingMarks = { firstEditionStamp: "CANT_TELL", artBoxShadow: "CANT_TELL", reprintMark: "NONE_SEEN", evidence: [] };
    Object.assign(original.photoCheck, { printedName: "Dark Gengar", printedNumber: "6/105" });
    let crops = 0;
    const { evaluate, cache } = harness({ details: async () => item, assess: async () => assert.fail("the full gallery was already paid for"),
        lookup: async () => [{ ...card, name: "Dark Gengar", setName: "Neo Destiny", cardNumber: "6/105",
            variants: [{ name: "Unlimited Holofoil", printing: "UNLIMITED", finish: "HOLO" }, { name: "1st Edition Holofoil", printing: "FIRST_EDITION", finish: "HOLO" }] }],
        fetchRawComps: async () => [], fetchComps: async () => [],
        frame: async () => assert.fail("Neo Destiny has no Base Set artwork-frame check"),
        stamp: async () => {
            crops++; assert.equal(getAiUsageContext().searchId, searchId);
            return { result: "NOT_PRESENT", reused: false, key: "fixture", answeredAt: new Date(now).toISOString(),
                usage: { inputTokens: 100, outputTokens: 10 }, source: { method: "NEO_DESTINY_CONTEXT_V1", observation: "The printed stamp area is blank.",
                    photoNumber: 1, sourceSha256: "d".repeat(64), box: { left: 90, top: 90, width: 200, height: 140 } } };
        } });
    const gallery = boundedAssessmentPlan(item);
    cache.set(gallery.key, { ...original, version: gallery.version, answeredAt: new Date(now).toISOString() });
    await withAiUsageContext({ searchId }, () => evaluate(item.id, { automatic: true, typeFilter: "AUCTION" }));
    const saved = [...cache.entries()].find(([key]) => key.startsWith(PRIVATE_EVALUATION_PREFIX))![1];
    saved.evaluation.focusedStamp = { result: "CANT_TELL", photoNumber: 1,
        sourceSha256: "d".repeat(64), box: { left: 90, top: 90, width: 200, height: 140 } };
    const focused = (maxDelivered: number) => withAiUsageContext({ searchId }, () =>
        evaluate(item.id, { priceOnly: true, huntPrinting: { maxDelivered }, typeFilter: "AUCTION" }));
    await focused(25);
    assert.equal(crops, 0, "the next delivered bid exceeds the budget");
    const first = await focused(40);
    assert.equal(first.identity?.printing, "UNLIMITED");
    assert.equal(first.focusedStamp?.photoNumber, 1);
    assert.equal((await focused(40)).identity?.printing, "UNLIMITED");
    assert.equal(crops, 1);
});
