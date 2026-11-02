import { test } from "node:test";
import assert from "node:assert/strict";
import {
    countSearchResults, filterSearchResults, groupSearchResults, sortSearchResults,
    type SearchFilters,
} from "../../client/src/search/results.ts";
import type { AnalysisState } from "../../client/src/analysis-state.ts";
import type { Evaluation, ListingSummary, RatingLevel, Screen, SearchIntent } from "../../shared/types.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { canAutoAnalyze } from "../../shared/analysis.ts";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const targets = { minProfit: 0, minRoi: 0 };
const filters: SearchFilters = { typeFilter: "all", kindFilter: "all", maxPrice: "", minPrice: "", minGrade: 0 };
const ids = (listings: ListingSummary[]) => listings.map(listing => listing.id);
const screen = (change: Partial<Screen> = {}): Screen => ({ status: "CANDIDATE", reason: null, card: null, bestCase: null, assumed: null, ...change });
const listing = (id: string, change: Partial<ListingSummary> = {}): ListingSummary => ({
    id, title: "Venusaur Base Set 15/102 Holo", currentPrice: 100, shipping: 0, bids: 0,
    isGraded: false, buyingOption: "FIXED_PRICE", endTime: null, availability: "ACTIVE",
    images: ["https://example.invalid/front.jpg"], url: "https://example.invalid/listing", seller: null,
    screen: screen(), ...change,
});
function evaluation(item: ListingSummary, resale = 250, level?: RatingLevel): Evaluation {
    const area = () => ({ visibility: "CLEAR", severity: "MINOR", observations: [] });
    const value: Evaluation = {
        listing: { ...item, price: item.currentPrice, sellerCondition: "Ungraded", cardCondition: null,
            conditionNotes: [], aspects: {}, photos: item.images, photosInListing: 1, photosAnalyzed: 1 },
        photoCheck: { cardCount: "ONE", holder: "NONE", confidence: "HIGH", photoSufficiency: "SUFFICIENT",
            images: [{ number: 1, view: "FRONT", usable: true, isStockImage: false, issues: [] }], missingViews: [], problems: [] },
        identity: { status: "IDENTIFIED", name: "Venusaur", set: "Base Set", cardNumber: "015/102", printing: "UNLIMITED",
            printingLabel: "Unlimited", finish: "HOLO", language: "English", evidence: null, reasons: [] },
        condition: { centering: area(), corners: area(), edges: area(), surface: area(), creases: "NONE_SEEN", rawCondition: "LIGHTLY_PLAYED",
            gradeRange: { low: 4, likely: 5, high: 8 }, authenticity: { concern: "NONE_SEEN", reasons: [] }, confidence: "HIGH", limitations: [], summary: "Offline assessment." },
        gradingMode: "FULL", modeReasons: [], gradeStatus: "ESTIMATED", setAside: [],
        rawPricing: { status: "PRICED", prices: [{ condition: "LIGHTLY_PLAYED", price: resale, updatedAt: new Date(NOW).toISOString() }] },
        gradedPricing: null, slab: null, slabPricing: null, underwriting: null, rating: null,
        answeredAt: new Date(NOW).toISOString(), reusedSteps: [], usage: [],
    };
    value.underwriting = underwrite(value, { ...MONEY_CONFIG, targets });
    if (level) value.rating = { level, room: null, strengths: [], concerns: [], notes: [], auction: null };
    return value;
}
const done = (value: Evaluation): Extract<AnalysisState, { status: "done" }> => ({ status: "done", evaluation: value, evidenceKey: value.listing.id });
function slab(item: ListingSummary, grader: string, grade: string) {
    const value = evaluation(item);
    value.photoCheck!.holder = "GRADED_SLAB";
    value.photoCheck!.slab = { present: true, grader, grade, gradeQualifier: null, certNumber: "offline-cert", labelText: `${grader} ${grade}`,
        caseCondition: "INTACT", authenticity: "NONE_SEEN", concerns: [] };
    value.slab = { status: "OK", grader, grade, gradeQualifier: null, certNumber: "offline-cert", certUrl: null,
        labelText: `${grader} ${grade}`, caseCondition: "INTACT", reasons: [], concerns: [] };
    return value;
}
const filter = (listings: ListingSummary[], analyses: Record<string, AnalysisState> = {}, changes: Partial<SearchFilters> = {}, page: "search" | "shortlist" = "search", intent?: SearchIntent) =>
    filterSearchResults({ listings, analyses, filters: { ...filters, ...changes }, page, intent, now: NOW });

const holoIntent: SearchIntent = { cardName: "Venusaur", sets: ["Base Set"], cardNumber: "15/102", printing: null, graded: null,
    finish: "HOLO", titleWords: ["venusaur"], source: "rules" };

test("deliberately deferred low-value copies stay out of deals, offers and hidden finds even with a reused profit estimate", () => {
    const deferred = listing("deferred", { found: { how: "PHOTO_SHOWS_IT", note: "The photo identifies this card." } });
    const normal = listing("fully-researched");
    const e = evaluation(deferred, 300, "STRONG"); e.researchMode = "DEFERRED_LOW_RESALE";
    const analyses = { [deferred.id]: done(e), [normal.id]: done(evaluation(normal, 250, "GOOD")) };
    const groups = groupSearchResults([deferred, normal], analyses, true, new Set());
    assert.deepEqual(ids(groups.deals), [normal.id]);
    assert.deepEqual(groups.offers, []); assert.deepEqual(groups.hidden, []); assert.deepEqual(groups.review, []);
    assert.deepEqual(ids(groups.all), [deferred.id, normal.id]);
    assert.deepEqual(ids(sortSearchResults([deferred, normal], analyses, "best", targets, NOW)), [normal.id, deferred.id]);
});

test("the result inventory excludes expired, unavailable and disproved copies before grouping", () => {
    const kept = listing("kept");
    const wrongPhoto = listing("wrong-photo");
    const wrongEvaluation = evaluation(wrongPhoto); wrongEvaluation.identity!.notThisCard = "Photo shows a different release.";
    const listings = [kept, listing("expired", { endTime: new Date(NOW - 1).toISOString() }),
        listing("ending-now", { endTime: new Date(NOW).toISOString() }), listing("unavailable", { availability: "UNAVAILABLE" }),
        listing("wrong-set", { match: "OTHER_SET" }), wrongPhoto];
    const analyses = { [kept.id]: done(evaluation(kept)), [wrongPhoto.id]: done(wrongEvaluation) };
    const visible = filter(listings, analyses);
    assert.deepEqual(ids(visible), ["kept"]);
    const groups = groupSearchResults(visible, analyses, false, new Set(["kept", "expired"]));
    assert.deepEqual(ids(groups.deals), ["kept"]);
    assert.deepEqual(ids(groups.all), ["kept"]);
    assert.deepEqual(ids(groups.new), ["kept"]);
});

test("a minimum Buy It Now price does not hide a low auction opening bid", () => {
    const listings = [listing("cheap-bin", { currentPrice: 20 }), listing("eligible-bin", { currentPrice: 40 }),
        listing("opening-bid", { buyingOption: "AUCTION", currentPrice: 1, endTime: new Date(NOW + 3600000).toISOString() }),
        listing("over-budget", { currentPrice: 500 })];
    assert.deepEqual(ids(filter(listings, {}, { minPrice: "30", maxPrice: "100" })), ["eligible-bin", "opening-bid"]);
    assert.deepEqual(ids(filter(listings, {}, { minPrice: "30", typeFilter: "FIXED_PRICE", maxPrice: "100" })), ["eligible-bin"]);
});

test("potential-grade filtering uses the raw upper end, exact slab grades, and retains unassessed candidates", () => {
    const raw = listing("raw-upper-eight"), below = listing("raw-upper-six"), waiting = listing("not-assessed");
    const exact = listing("slab-eight", { isGraded: true }), half = listing("slab-seven-half", { isGraded: true });
    const low = evaluation(below); low.condition!.gradeRange = { low: 2, likely: 4, high: 6 };
    const analyses = { [raw.id]: done(evaluation(raw)), [below.id]: done(low), [exact.id]: done(slab(exact, "PSA", "8")), [half.id]: done(slab(half, "CGC", "7.5")) };
    const listings = [raw, below, exact, half, waiting];
    assert.deepEqual(ids(filter(listings, analyses, { minGrade: 8 })), ["raw-upper-eight", "slab-eight", "not-assessed"]);
    assert.deepEqual(ids(filter(listings, analyses, { minGrade: 8, kindFilter: "graded" })), ["slab-eight"]);
});

test("explicit grader and grade criteria narrow search results without leaking into the shortlist", () => {
    const psa = listing("psa-eight", { isGraded: true }), cgc = listing("cgc-eight", { isGraded: true }), raw = listing("raw-potential-eight");
    const listings = [psa, cgc, raw];
    const analyses = { [psa.id]: done(slab(psa, "PSA", "8")), [cgc.id]: done(slab(cgc, "CGC", "8")), [raw.id]: done(evaluation(raw)) };
    const intent = { ...holoIntent, graded: true, grader: "PSA", minGrade: 7, maxGrade: 9 };
    assert.deepEqual(ids(filter(listings, analyses, {}, "search", intent)), ["psa-eight"]);
    assert.deepEqual(ids(filter(listings, analyses, {}, "shortlist", intent)), ["psa-eight", "cgc-eight", "raw-potential-eight"]);
    assert.equal(countSearchResults({ listings, analyses, page: "search", intent, newMode: false, newIds: new Set() }).mismatched, 2);
    assert.equal(countSearchResults({ listings, analyses, page: "shortlist", intent, newMode: false, newIds: new Set() }).mismatched, 0);
});

test("offer-dependent discoveries stay separate from confirmed deals and respect the 10-percent cutoff", () => {
    const found = { how: "WRONG_CATEGORY" as const, note: "Offline discovery." };
    const deal = listing("buy-now-deal", { bestOffer: true, found }), offer = listing("offer-only", { bestOffer: true, found });
    const lowball = listing("requires-lowball", { bestOffer: true, found }), waiting = listing("waiting-discovery", { found });
    const review = listing("printing-review", { found, mistakes: [{ kind: "FIRST_EDITION", detail: "Stamp needs confirmation." }] });
    const rejected = listing("rejected-discovery", { found });
    const reviewEvaluation = evaluation(review); reviewEvaluation.identity!.status = "NEEDS_REVIEW";
    reviewEvaluation.underwriting = underwrite(reviewEvaluation, { ...MONEY_CONFIG, targets });
    const analyses = { [deal.id]: done(evaluation(deal)), [offer.id]: done(evaluation(offer, 128)),
        [lowball.id]: done(evaluation(lowball, 100)), [review.id]: done(reviewEvaluation), [rejected.id]: done(evaluation(rejected, 80)) };
    assert.equal(analyses[offer.id].evaluation.underwriting?.verdict, "PASS");
    const listings = filter([deal, offer, lowball, waiting, review, rejected], analyses);
    const without = groupSearchResults(listings, analyses, false, new Set([offer.id, lowball.id]));
    assert.deepEqual(ids(without.deals), ["buy-now-deal"]); assert.deepEqual(ids(without.offers), []);
    assert.deepEqual(without.hidden, []);
    const withOffers = groupSearchResults(listings, analyses, true, new Set([offer.id, lowball.id]));
    assert.deepEqual(ids(withOffers.offers), ["offer-only"]); assert.deepEqual(ids(withOffers.deals), ["buy-now-deal"]);
    assert.deepEqual(withOffers.hidden, []);
    assert.deepEqual(ids(withOffers.new), ["offer-only", "requires-lowball"], "new inventory includes a newly discovered rejection in All/New, not Deals");
});

test("best order favors stronger verified deals over a much larger thin-profit estimate", () => {
    const thin = listing("thin"), strong = listing("strong"), strongMore = listing("strong-more"), waiting = listing("waiting");
    const analyses = { [thin.id]: done(evaluation(thin, 1000, "THIN")), [strong.id]: done(evaluation(strong, 250, "STRONG")), [strongMore.id]: done(evaluation(strongMore, 300, "STRONG")) };
    assert.deepEqual(ids(sortSearchResults([thin, strong, waiting, strongMore], analyses, "best", targets, NOW)), ["strong-more", "strong", "thin", "waiting"]);
});

test("photographic discoveries use ordinary deal outcomes", () => {
    const discovered = listing("discovered-auction", { buyingOption: "AUCTION", found: { how: "PHOTO_SHOWS_IT", note: "Photo discovery" } });
    const value = evaluation(discovered, 250, "GOOD");
    const grouped = groupSearchResults([discovered], { [discovered.id]: done(value) }, false, new Set());
    assert.deepEqual(ids(grouped.deals), [discovered.id]); assert.deepEqual(grouped.hidden, []);
    assert.equal(value.rating?.level, "GOOD", "classification does not rewrite saved provider evidence");
});

test("the sorting workbench retains priced passes, deferred copies and unchecked rows while attention stays separate", () => {
    const pass = listing("priced-pass"), deferred = listing("deferred-work"), unchecked = listing("unchecked", { screen: screen({ status: "DROPPED" }) });
    const attention = listing("attention");
    const deferredEvaluation = evaluation(deferred, 300); deferredEvaluation.researchMode = "DEFERRED_LOW_RESALE";
    const review = evaluation(attention); review.identity!.status = "NEEDS_REVIEW";
    review.underwriting = underwrite(review, { ...MONEY_CONFIG, targets });
    const analyses = { [pass.id]: done(evaluation(pass, 20)), [deferred.id]: done(deferredEvaluation), [attention.id]: done(review) };
    const groups = groupSearchResults([pass, deferred, unchecked, attention], analyses, false, new Set());
    assert.deepEqual(ids(groups.candidates), [pass.id, deferred.id, unchecked.id]);
    assert.deepEqual(ids(groups.review), [attention.id]); assert.deepEqual(groups.deals, []);
    assert.equal(canAutoAnalyze(unchecked), false, "workbench membership does not authorize paid analysis");
});

test("overlooked order prioritizes confirmed deals and real listing evidence over retrieval method", () => {
    const verified = listing("verified"), verifiedClue = listing("verified-clue", { title: "Old vintage card" });
    const clue = listing("unverified-clue", { mistakes: [{ kind: "FIRST_EDITION", detail: "Photo suggests an omitted stamp." }] });
    const retrieval = listing("retrieval-only", { found: { how: "WRONG_CATEGORY", note: "A search lead, not evidence of profit." } });
    const analyses = { [verified.id]: done(evaluation(verified, 300, "STRONG")), [verifiedClue.id]: done(evaluation(verifiedClue, 250, "STRONG")) };
    assert.deepEqual(ids(sortSearchResults([retrieval, clue, verified, verifiedClue], analyses, "overlooked", targets, NOW)), ["verified-clue", "verified", "unverified-clue", "retrieval-only"]);
});

test("new-only progress queues only unseen eligible listings while keeping other progress counters accurate", () => {
    const oldWaiting = listing("old-waiting"), oldLoading = listing("old-loading"), waiting = listing("new-waiting"), loading = listing("new-loading");
    const complete = listing("new-complete"), failed = listing("new-failed"), unchecked = listing("new-unchecked", { screen: screen({ status: "UNSCREENED" }) });
    const config = listing("new-config", { screen: screen({ status: "UNSCREENED", pricingIssue: { kind: "CONFIG", retryAt: null } }) });
    const anomaly = listing("anomaly", { screen: screen({ status: "UNSCREENED", priceAnomaly: { referencePrice: 200, photoChecked: false } }) });
    const mismatch = listing("wrong-set", { match: "OTHER_SET" }), junk = listing("junk", { match: "JUNK", screen: screen({ status: "DROPPED", junk: true }) });
    const wrongPhoto = listing("wrong-photo"), wrongFinish = listing("wrong-finish");
    const wrongPhotoEvaluation = evaluation(wrongPhoto); wrongPhotoEvaluation.identity!.notThisCard = "Another card is pictured.";
    const wrongFinishEvaluation = evaluation(wrongFinish); wrongFinishEvaluation.identity!.finish = "NON_HOLO";
    const analyses: Record<string, AnalysisState> = {
        [oldLoading.id]: { status: "loading", evidenceKey: oldLoading.id, startedAt: NOW },
        [loading.id]: { status: "loading", evidenceKey: loading.id, startedAt: NOW },
        [complete.id]: done(evaluation(complete)), [failed.id]: { status: "error", evidenceKey: failed.id, message: "Offline failure." },
        [wrongPhoto.id]: done(wrongPhotoEvaluation), [wrongFinish.id]: done(wrongFinishEvaluation),
    };
    const listings = [oldWaiting, oldLoading, waiting, loading, complete, failed, unchecked, config, anomaly, mismatch, junk, wrongPhoto, wrongFinish];
    const newIds = new Set([waiting.id, loading.id, complete.id, failed.id, unchecked.id, config.id]);
    const context = { listings, analyses, newIds, page: "search" as const, intent: holoIntent };
    assert.deepEqual(countSearchResults({ ...context, newMode: true }), { candidates: 4, dropped: 1, unchecked: 2, mismatched: 3, junk: 1, analyzing: 2, waiting: 1 });
    assert.equal(countSearchResults({ ...context, newMode: false }).waiting, 3);
    const visible = filter(listings, analyses, {}, "search", holoIntent);
    const groups = groupSearchResults(visible, analyses, false, newIds);
    assert.deepEqual(ids(groups.new), ["new-waiting", "new-loading", "new-complete", "new-failed", "new-unchecked", "new-config"]);
    assert.ok(groups.review.some(item => item.id === failed.id), "a failed assessment remains visible for review");
});

function freeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); }
    return value;
}

test("result projections and alternate sorts neither mutate saved evidence nor request providers", t => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", () => { requests++; throw new Error("Result projection must not request a provider."); });
    const later = listing("later", { buyingOption: "AUCTION", currentPrice: 30, endTime: new Date(NOW + 7200000).toISOString() });
    const sooner = listing("sooner", { buyingOption: "AUCTION", currentPrice: 10, endTime: new Date(NOW + 3600000).toISOString() });
    const bin = listing("bin", { currentPrice: 20 });
    const listings = freeze([later, bin, sooner]);
    const analyses = freeze({ [bin.id]: done(evaluation(bin, 250, "STRONG")) });
    const before = structuredClone({ listings, analyses });
    const visible = filter(listings, analyses), groups = groupSearchResults(visible, analyses, true, new Set([bin.id]));
    assert.deepEqual(ids(sortSearchResults(groups.all, analyses, "ending", targets, NOW)), ["sooner", "later", "bin"]);
    assert.deepEqual(ids(sortSearchResults(groups.all, analyses, "priceLow", targets, NOW)), ["sooner", "bin", "later"]);
    assert.deepEqual(ids(sortSearchResults(groups.all, analyses, "priceHigh", targets, NOW)), ["later", "bin", "sooner"]);
    sortSearchResults(groups.all, analyses, "best", targets, NOW); sortSearchResults(groups.all, analyses, "overlooked", targets, NOW);
    countSearchResults({ listings, analyses, page: "search", newMode: false, newIds: new Set() });
    assert.deepEqual({ listings, analyses }, before); assert.deepEqual(ids(visible), ["later", "bin", "sooner"]);
    assert.equal(requests, 0);
});
