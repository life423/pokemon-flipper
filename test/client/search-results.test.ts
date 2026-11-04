import { test } from "node:test";
import assert from "node:assert/strict";
import {
    countSearchResults, filterSearchResults, groupSearchResults, sortSearchResults, selectDealAlternatives,
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

test("known reprint titles leave Base Set results rather than become a manual-review task when metadata conflicts", t => {
    const fetch = t.mock.method(globalThis, "fetch", () => { assert.fail("classifying existing reprint evidence must not purchase another check"); });
    const intent = { ...holoIntent, cardName: "Charizard", cardNumber: "4/102", titleWords: ["charizard"] };
    const ordinary = listing("uncertain-base", { title: "Charizard Base Set 4/102 English Holo" });
    const celebration = listing("celebration-conflict", { title: "Pokemon Charizard Celebration Base Set 4/102 English Holo" });
    const anniversary = listing("anniversary-conflict", { title: "Charizard 30th Celebration 4/102 English Holo" });
    const copies = [ordinary, celebration, anniversary];
    const analyses = Object.fromEntries(copies.map(item => {
        const value = evaluation(item);
        value.identity = { ...value.identity!, status: "NEEDS_REVIEW", name: "Charizard", cardNumber: "4/102", reasons: ["The title and item specifics disagree about the release."] };
        value.photoCheck!.cardIdentity = { name: "Charizard", set: "Base Set", cardNumber: "4/102", finish: "HOLO", language: "English", confidence: "MEDIUM", evidence: ["Name and number are readable; release mark is uncertain."] };
        value.underwriting = { ...value.underwriting!, verdict: "NEEDS_REVIEW", reasons: [...value.identity.reasons] };
        return [item.id, done(value)];
    }));
    const visible = filter(copies, analyses, {}, "search", intent);
    const groups = groupSearchResults(visible, analyses, false, new Set());
    assert.deepEqual(ids(groups.all), [ordinary.id]);
    assert.deepEqual(ids(groups.review), [ordinary.id], "genuine uncertainty without an incompatible release stays reviewable");
    assert.deepEqual(groups.deals, []);
    const counts = countSearchResults({ listings: copies, analyses, page: "search", intent, newMode: false, newIds: new Set() });
    assert.equal(counts.mismatched, 2);
    assert.equal(counts.candidates, 1, "known wrong releases no longer count as eligible analysis candidates");
    assert.equal(fetch.mock.callCount(), 0);
});

test("a high-confidence physical card reading overrides seller set claims when filtering the requested market", () => {
    const reprint = listing("photo-confirmed-reprint"), actual = listing("actual-original");
    const changed = evaluation(reprint);
    changed.identity = { ...changed.identity!, status: "NEEDS_REVIEW", reasons: ["Seller metadata says Base Set."] };
    changed.photoCheck!.cardIdentity = { name: "Venusaur", set: "Celebrations: Classic Collection", cardNumber: "15/102", finish: "HOLO", language: "English", confidence: "HIGH", evidence: ["The photographed anniversary stamp identifies a reprint."] };
    changed.underwriting = { ...changed.underwriting!, verdict: "NEEDS_REVIEW", reasons: changed.identity.reasons };
    const right = evaluation(actual);
    right.identity!.set = "Celebrations: Classic Collection";
    right.photoCheck!.cardIdentity = { name: "Venusaur", set: "Base Set", cardNumber: "15/102", finish: "HOLO", language: "English", confidence: "HIGH", evidence: ["The clear physical card identifies the original release."] };
    const analyses = { [reprint.id]: done(changed), [actual.id]: done(right) };
    assert.deepEqual(ids(filter([reprint, actual], analyses, {}, "search", holoIntent)), [actual.id]);
    assert.deepEqual(ids(filter([reprint], analyses, {}, "shortlist", holoIntent)), [reprint.id], "a search scope cannot delete or hide otherwise relevant saved history");
});

test("known canonical identity respects requested set, collector number, printed name and printing", () => {
    const wrongSet = listing("other-set"), wrongNumber = listing("other-number"), wrongName = listing("other-name"), right = listing("right");
    const setValue = evaluation(wrongSet); setValue.identity!.set = "Base Set 2";
    const numberValue = evaluation(wrongNumber); numberValue.identity!.cardNumber = "14/102";
    const nameValue = evaluation(wrongName); nameValue.identity!.name = "Mewtwo";
    const correct = evaluation(right); correct.identity!.set = "Base Set (Shadowless)"; correct.identity!.cardNumber = "015/0102"; correct.identity!.printing = "SHADOWLESS";
    const analyses = { [wrongSet.id]: done(setValue), [wrongNumber.id]: done(numberValue), [wrongName.id]: done(nameValue), [right.id]: done(correct) };
    assert.deepEqual(ids(filter([wrongSet, wrongNumber, wrongName, right], analyses, {}, "search", holoIntent)), [right.id]);
    assert.deepEqual(filter([right], analyses, {}, "search", { ...holoIntent, printing: "UNLIMITED" }), []);
});

test("a broad reprint search and unknown photo identity are not reclassified as vintage mismatches", () => {
    const item = listing("celebration-query", { title: "Venusaur Celebration 15/102 Holo" });
    const value = evaluation(item);
    value.identity = { ...value.identity!, status: "NEEDS_REVIEW", reasons: ["The exact release needs clearer evidence."] };
    value.photoCheck!.cardIdentity = { name: null, set: null, cardNumber: null, finish: "UNKNOWN", language: "English", confidence: "LOW", evidence: [] };
    value.underwriting = { ...value.underwriting!, verdict: "NEEDS_REVIEW", reasons: value.identity.reasons };
    const analyses = { [item.id]: done(value) };
    assert.deepEqual(ids(filter([item], analyses, {}, "search", { ...holoIntent, sets: ["Celebrations: Classic Collection"] })), [item.id]);
    assert.deepEqual(ids(filter([item], analyses, {}, "search", { ...holoIntent, sets: [] })), [item.id]);
});

test("the three saved Base Set cases retain both PSA copies and exclude the disputed anniversary reprint", () => {
    const first = listing("v1|287700156029|0", { title: "1999 Pokémon Base Set Charizard #4/102 Holo – PSA 5 EX – Excellent Eye Appeal", isGraded: true });
    const anniversary = listing("v1|168833419127|0", { title: "Pokemon 30th Celebration Charizard 4/102" });
    const second = listing("v1|840086210843|0", { title: "1999 Pokemon Base Set Charizard 4/102 Holo Rare PSA 5 EX Vintage WOTC", isGraded: true });
    const intent = { ...holoIntent, cardName: "Charizard", cardNumber: null, titleWords: ["charizard"] };
    const photo = (set: string, confidence: "HIGH" | "MEDIUM") => ({ name: "Charizard", set, cardNumber: "4/102", language: "English", finish: "HOLO" as const, confidence, evidence: ["The card name, number and English text are readable."] });
    const firstValue = slab(first, "PSA", "5");
    firstValue.identity = { ...firstValue.identity!, name: "Charizard", cardNumber: "004/102" };
    firstValue.photoCheck!.cardIdentity = photo("1999 Pokémon Game Base Set", "HIGH");
    firstValue.underwriting = { ...firstValue.underwriting!, verdict: "NEEDS_REVIEW", reasons: ["A seller certificate field differs from the readable label."] };
    const reprintValue = evaluation(anniversary);
    reprintValue.identity = { ...reprintValue.identity!, status: "NEEDS_REVIEW", name: null, cardNumber: null, printing: "UNKNOWN", reasons: ["The anniversary title conflicts with Base Set item specifics."] };
    reprintValue.photoCheck!.cardIdentity = photo("Base Set", "MEDIUM");
    reprintValue.underwriting = { ...reprintValue.underwriting!, verdict: "NEEDS_REVIEW", reasons: reprintValue.identity.reasons };
    const secondValue = slab(second, "PSA", "5");
    secondValue.identity = { ...secondValue.identity!, name: "Charizard", cardNumber: "004/102" };
    secondValue.photoCheck!.cardIdentity = photo("Base Set", "HIGH");
    secondValue.underwriting = { ...secondValue.underwriting!, verdict: "PASS", reasons: ["The asking price does not clear the financial target."] };
    const analyses = { [first.id]: done(firstValue), [anniversary.id]: done(reprintValue), [second.id]: done(secondValue) };
    const visible = filter([first, anniversary, second], analyses, {}, "search", intent);
    const groups = groupSearchResults(visible, analyses, false, new Set());
    assert.deepEqual(ids(groups.all), [first.id, second.id]);
    assert.deepEqual(ids(groups.review), [first.id]);
    assert.deepEqual(groups.candidates, [], "the completed PSA loss remains in All matching, not Sorting");
    assert.deepEqual(groups.deals, [], "scope correction cannot promote a priced loss into Deals");
    assert.equal(countSearchResults({ listings: [first, anniversary, second], analyses, page: "search", intent, newMode: false, newIds: new Set() }).mismatched, 1);
});

test("high-confidence actual holo, reverse-holo and non-holo finishes stay distinct despite seller wording", () => {
    const holo = listing("actual-holo"), reverse = listing("actual-reverse"), plain = listing("actual-non-holo");
    const copies = [holo, reverse, plain];
    const finishes = ["HOLO", "REVERSE_HOLO", "NON_HOLO"] as const;
    const analyses = Object.fromEntries(copies.map((item, index) => {
        const value = evaluation(item, 20);
        value.identity = { ...value.identity!, status: "NEEDS_REVIEW", finish: "UNKNOWN", reasons: ["Seller metadata cannot establish the finish."] };
        value.listing.aspects.Finish = "Holo";
        value.photoCheck!.cardIdentity = { name: "Venusaur", set: "Base Set", cardNumber: "15/102", language: "English", finish: finishes[index], confidence: "HIGH", evidence: ["The physical foil pattern is clear."] };
        return [item.id, done(value)];
    }));
    assert.deepEqual(ids(filter(copies, analyses, {}, "search", holoIntent)), [holo.id]);
    assert.deepEqual(ids(filter(copies, analyses, {}, "search", { ...holoIntent, finish: "REVERSE_HOLO" })), [reverse.id]);
    assert.deepEqual(ids(filter(copies, analyses, {}, "search", { ...holoIntent, finish: "NON_HOLO" })), [plain.id]);
    const low = structuredClone(analyses[reverse.id]);
    if (low.status === "done") { low.evaluation.photoCheck!.cardIdentity!.confidence = "LOW"; low.evaluation.identity!.finish = "HOLO"; }
    assert.deepEqual(ids(filter([reverse], { [reverse.id]: low }, {}, "search", holoIntent)), [reverse.id], "low-confidence photo guesses do not overrule settled finish evidence");
    const unknown = structuredClone(analyses[holo.id]);
    if (unknown.status === "done") unknown.evaluation.photoCheck!.cardIdentity!.finish = "UNKNOWN";
    assert.deepEqual(filter([holo], { [holo.id]: unknown }, {}, "search", holoIntent), [], "unknown actual and canonical finish cannot be filled with the seller's holo claim");
    assert.deepEqual(ids(filter([holo], { [holo.id]: unknown }, {}, "search", { ...holoIntent, finish: null })), [holo.id]);
    assert.deepEqual(groupSearchResults(filter(copies, analyses, {}, "search", holoIntent), analyses, false, new Set()).deals, []);
});

test("deliberately deferred low-value copies stay out of deals and offers even with a reused profit estimate", () => {
    const deferred = listing("deferred", { found: { how: "PHOTO_SHOWS_IT", note: "The photo identifies this card." } });
    const normal = listing("fully-researched");
    const e = evaluation(deferred, 300, "STRONG"); e.researchMode = "DEFERRED_LOW_RESALE";
    const analyses = { [deferred.id]: done(e), [normal.id]: done(evaluation(normal, 250, "GOOD")) };
    const groups = groupSearchResults([deferred, normal], analyses, true, new Set());
    assert.deepEqual(ids(groups.deals), [normal.id]);
    assert.deepEqual(groups.offers, []); assert.deepEqual(groups.review, []);
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

test("All matching includes screened passes and unfinished cards while excluding known wrong cards and junk without new work", t => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", () => { requests++; throw new Error("All matching is a projection of saved results"); });
    const deal = listing("deal"), pass = listing("pass"), waiting = listing("unfinished");
    const wrong = listing("wrong-card"), junk = listing("flagged-junk", { screen: screen({ junk: true }) });
    const wrongAssessment = evaluation(wrong);
    wrongAssessment.identity!.notThisCard = "Photos show a different card.";
    const passAssessment = evaluation(pass, 20);
    assert.equal(passAssessment.underwriting?.verdict, "PASS");
    const analyses = { [deal.id]: done(evaluation(deal)), [pass.id]: done(passAssessment), [wrong.id]: done(wrongAssessment) };
    const visible = filter([deal, pass, waiting, wrong, junk, listing("wrong-set", { match: "OTHER_SET" })], analyses);
    const groups = groupSearchResults(visible, analyses, false, new Set());
    assert.deepEqual(ids(groups.all), ["deal", "pass", "unfinished"]);
    assert.deepEqual(ids(groups.deals), ["deal"]);
    assert.equal(Object.hasOwn(analyses, waiting.id), false, "showing a card does not imply an assessment exists");
    assert.equal(requests, 0);
});

test("a photo rejection marked OTHER_LANGUAGE hides an English-titled listing and never returns it to the analysis queue", () => {
    const rejected = listing("foreign-photo-rejected", { title: "Venusaur Base Set English Holo", match: "OTHER_LANGUAGE" });
    const english = listing("english-card", { title: "Venusaur Base Set English Holo" });
    assert.equal(canAutoAnalyze(rejected), false);
    for (const analyses of [{}, { [rejected.id]: { status: "error", evidenceKey: rejected.id, message: "Photos show a German card." } as AnalysisState }]) {
        const visible = filter([rejected, english], analyses);
        assert.deepEqual(ids(groupSearchResults(visible, analyses, true, new Set([rejected.id])).all), [english.id]);
        const counts = countSearchResults({ listings: [rejected, english], analyses, page: "search", newMode: false, newIds: new Set() });
        assert.equal(counts.waiting, 1);
        assert.equal(counts.mismatched, 1);
    }
});

test("English-only results exclude foreign titles and saved evidence before grouping without treating unknown language as foreign", t => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", () => { requests++; throw new Error("Language filtering must use saved evidence"); });
    const english = listing("english", { title: "Venusaur Base Set English Holo" });
    const unknown = listing("unconfirmed"), alias = listing("english-alias");
    const foreignTitle = listing("foreign-title", { title: "Venusaur Base Set German Holo" });
    const foreignIdentity = listing("foreign-identity"), foreignPhoto = listing("foreign-photo"), foreignAspect = listing("foreign-aspect");
    const foreignMatch = listing("foreign-match", { match: "OTHER_LANGUAGE" });
    const identity = evaluation(foreignIdentity); identity.identity!.language = "German";
    const photo = evaluation(foreignPhoto); photo.photoCheck!.cardIdentity = { name: "Venusaur", set: "Base Set", cardNumber: "15/102",
        finish: "HOLO", language: "Japanese", confidence: "HIGH", evidence: ["Japanese text visible."] };
    const aspect = evaluation(foreignAspect); aspect.listing.aspects.Language = "fr";
    const englishAlias = evaluation(alias); englishAlias.identity!.language = "en-US";
    const analyses = { [foreignIdentity.id]: done(identity), [foreignPhoto.id]: done(photo), [foreignAspect.id]: done(aspect), [alias.id]: done(englishAlias) };
    const listings = [english, unknown, alias, foreignTitle, foreignIdentity, foreignPhoto, foreignAspect, foreignMatch];
    const before = structuredClone({ listings, analyses });
    for (const page of ["search", "shortlist"] as const) {
        const visible = filter(listings, analyses, {}, page);
        assert.deepEqual(ids(visible), ["english", "unconfirmed", "english-alias"]);
        assert.deepEqual(ids(groupSearchResults(visible, analyses, false, new Set()).all), ids(visible));
    }
    const counts = countSearchResults({ listings, analyses, page: "search", newMode: false, newIds: new Set() });
    assert.equal(counts.mismatched, 5);
    assert.equal(counts.candidates, 3);
    assert.equal(counts.waiting, 2);
    assert.equal(Object.hasOwn(analyses, unknown.id), false, "an unconfirmed row does not gain a photo assessment");
    assert.deepEqual({ listings, analyses }, before);
    assert.equal(requests, 0);
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

test("photographed holders override wrong raw/graded metadata in all result groups and counts", t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("holder filtering must reuse paid evidence"));
    const miscategorized = listing("raw-category-slab");
    const ordinary = listing("ordinary-raw");
    const certified = slab(miscategorized, "PSA", "8");
    const analyses = { [miscategorized.id]: done(certified), [ordinary.id]: done(evaluation(ordinary)) };
    const snapshot = structuredClone({ miscategorized, ordinary, analyses });
    const rawRows = filter([miscategorized, ordinary], analyses, { kindFilter: "raw" });
    assert.deepEqual(ids(rawRows), [ordinary.id]);
    const groups = groupSearchResults(rawRows, analyses, true, new Set([miscategorized.id]));
    assert.deepEqual(groups.new, []);
    for (const rows of Object.values(groups)) assert.equal(rows.some(row => row.id === miscategorized.id), false);
    assert.deepEqual(ids(filter([miscategorized, ordinary], analyses, { kindFilter: "graded" })), [miscategorized.id]);
    assert.deepEqual(ids(filter([miscategorized, ordinary], analyses)), [miscategorized.id, ordinary.id]);
    const counts = countSearchResults({ listings: [miscategorized], analyses, filters: { ...filters, kindFilter: "raw" }, page: "search", newMode: false, newIds: new Set() });
    assert.equal(counts.candidates, 0); assert.equal(counts.waiting, 0); assert.equal(counts.unchecked, 0);
    assert.deepEqual({ miscategorized, ordinary, analyses }, snapshot, "classifying a holder does not rewrite terms, grades or financial advice");
});

test("bare, sleeved and top-loaded cards stay raw despite seller graded categories", () => {
    for (const holder of ["NONE", "SLEEVE", "TOPLOADER"]) {
        const item = listing(holder, { isGraded: true });
        const value = evaluation(item); value.photoCheck!.holder = holder;
        const analyses = { [item.id]: done(value) };
        assert.deepEqual(ids(filter([item], analyses, { kindFilter: "raw" })), [item.id]);
        assert.deepEqual(filter([item], analyses, { kindFilter: "graded" }), []);
    }
});

test("unreadable slab grades and certificate concerns do not turn certified holders into raw cards", () => {
    const item = listing("unreadable-slab");
    const value = slab(item, "PSA", "8");
    value.photoCheck!.slab!.grade = null;
    value.slab = { ...value.slab!, grade: null, status: "NEEDS_REVIEW", reasons: ["The numeric label grade is unreadable."] };
    value.underwriting = null;
    const analyses = { [item.id]: done(value) };
    assert.deepEqual(filter([item], analyses, { kindFilter: "raw" }), []);
    const rows = filter([item], analyses, { kindFilter: "graded" });
    assert.deepEqual(ids(groupSearchResults(rows, analyses, false, new Set()).review), [item.id]);
});

test("raw/graded query constraints use observed kind with Both selected and stay out of shortlist browsing", () => {
    const mislabeledRaw = listing("actually-slab");
    const mislabeledSlab = listing("actually-raw", { isGraded: true });
    const analyses = { [mislabeledRaw.id]: done(slab(mislabeledRaw, "CGC", "8")), [mislabeledSlab.id]: done(evaluation(mislabeledSlab)) };
    const rows = [mislabeledRaw, mislabeledSlab];
    assert.deepEqual(ids(filter(rows, analyses, {}, "search", { ...holoIntent, graded: false })), [mislabeledSlab.id]);
    assert.deepEqual(ids(filter(rows, analyses, {}, "search", { ...holoIntent, graded: true })), [mislabeledRaw.id]);
    assert.deepEqual(ids(filter(rows, analyses, {}, "shortlist", { ...holoIntent, graded: true })), rows.map(row => row.id));
    assert.deepEqual(filter(rows, analyses, { kindFilter: "raw" }, "search", { ...holoIntent, graded: true }), [], "query and control constraints cannot silently replace one another");
});

test("unknown photo holders preserve preliminary category without claiming they were confirmed raw", () => {
    for (const holder of ["UNKNOWN", "OTHER"]) {
        const item = listing(holder, { isGraded: true });
        const value = evaluation(item); value.photoCheck!.holder = holder;
        const analyses = { [item.id]: done(value) };
        assert.deepEqual(filter([item], analyses, { kindFilter: "raw" }), []);
        assert.deepEqual(ids(filter([item], analyses, { kindFilter: "graded" })), [item.id]);
    }
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
    const withOffers = groupSearchResults(listings, analyses, true, new Set([offer.id, lowball.id]));
    assert.deepEqual(ids(withOffers.offers), ["offer-only"]); assert.deepEqual(ids(withOffers.deals), ["buy-now-deal"]);
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
    assert.deepEqual(ids(grouped.deals), [discovered.id]);
    assert.equal(value.rating?.level, "GOOD", "classification does not rewrite saved provider evidence");
});

test("completed rejections and intentional deferrals leave Sorting while unresolved attention stays separate", () => {
    const pass = listing("priced-pass"), deferred = listing("deferred-work"), unchecked = listing("unchecked", { screen: screen({ status: "DROPPED" }) });
    const attention = listing("attention");
    const deferredEvaluation = evaluation(deferred, 300); deferredEvaluation.researchMode = "DEFERRED_LOW_RESALE";
    const review = evaluation(attention); review.identity!.status = "NEEDS_REVIEW";
    review.underwriting = underwrite(review, { ...MONEY_CONFIG, targets });
    const analyses = { [pass.id]: done(evaluation(pass, 20)), [deferred.id]: done(deferredEvaluation), [attention.id]: done(review) };
    const groups = groupSearchResults([pass, deferred, unchecked, attention], analyses, false, new Set());
    assert.deepEqual(groups.candidates, []);
    assert.deepEqual(ids(groups.review), [attention.id]); assert.deepEqual(groups.deals, []);
    assert.deepEqual(ids(groups.all), [pass.id, deferred.id, unchecked.id, attention.id], "removing queue entries does not delete saved research");
    assert.equal(canAutoAnalyze(unchecked), false, "workbench membership does not authorize paid analysis");
});

test("the completed Chansey loss leaves Sorting and attention without deleting paid assessment history", t => {
    t.mock.method(globalThis, "fetch", () => { assert.fail("routing a saved loss must not request providers"); });
    const chansey = listing("completed-chansey", { title: "Chansey Base Set Holo", currentPrice: 75.46,
        screen: screen({ status: "UNSCREENED", reason: "The preliminary price was unavailable." }) });
    const assessed = evaluation(chansey, 15);
    assessed.identity!.name = "Chansey";
    assessed.photoCheck!.missingViews = ["BACK"];
    assessed.underwriting = underwrite(assessed, MONEY_CONFIG);
    assert.equal(assessed.underwriting?.verdict, "PASS");
    assert.equal(assessed.underwriting?.best?.profit, -75.29);
    assert.equal(assessed.underwriting?.best?.maxBid, 0);
    const analyses = freeze({ [chansey.id]: done(assessed) });
    const groups = groupSearchResults([chansey], analyses, true, new Set());
    assert.deepEqual(groups.candidates, []);
    assert.deepEqual(groups.review, []);
    assert.deepEqual(groups.deals, []);
    assert.deepEqual(groups.offers, []);
    assert.deepEqual(ids(groups.all), [chansey.id]);
    assert.equal(analyses[chansey.id].evaluation, assessed, "paid evidence remains available unchanged");
    const counts = countSearchResults({ listings: [chansey], analyses, page: "search", newMode: false, newIds: new Set() });
    assert.equal(counts.waiting, 0);
    assert.equal(counts.analyzing, 0);
    assert.equal(counts.unchecked, 0, "stale preliminary metadata cannot make a completed loss unfinished again");
});

test("Sorting contains genuinely unfinished candidates while unresolved identity, pricing and errors stay in attention", () => {
    const waiting = listing("waiting"), loading = listing("loading"), unknown = listing("unknown-printing");
    const unpriced = listing("no-prices"), failed = listing("analysis-failed"), missingDecision = listing("missing-decision");
    const uncertain = evaluation(unknown);
    uncertain.identity!.status = "NEEDS_REVIEW";
    uncertain.identity!.reasons = ["The photographed printing cannot be identified."];
    uncertain.underwriting = underwrite(uncertain, { ...MONEY_CONFIG, targets });
    const noPrices = evaluation(unpriced);
    noPrices.rawPricing = null;
    noPrices.underwriting = underwrite(noPrices, { ...MONEY_CONFIG, targets });
    const unfinishedDecision = evaluation(missingDecision); unfinishedDecision.underwriting = null;
    const analyses: Record<string, AnalysisState> = {
        [loading.id]: { status: "loading", evidenceKey: loading.id, startedAt: NOW },
        [unknown.id]: done(uncertain), [unpriced.id]: done(noPrices), [missingDecision.id]: done(unfinishedDecision),
        [failed.id]: { status: "error", evidenceKey: failed.id, message: "The assessment could not finish." },
    };
    const groups = groupSearchResults([waiting, loading, unknown, unpriced, failed, missingDecision], analyses, false, new Set());
    assert.deepEqual(ids(groups.candidates), [waiting.id, loading.id]);
    assert.deepEqual(ids(groups.review), [unknown.id, unpriced.id, failed.id, missingDecision.id]);
    assert.deepEqual(groups.deals, []);
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

test("empty Deals alternatives prefer positive results below targets and omit losses, mismatches and material holds", () => {
    const below = listing("below"), loss = listing("loss"), pending = listing("pending"), held = listing("held"), fake = listing("fake");
    const positive = evaluation(below, 180); positive.underwriting = underwrite(positive, MONEY_CONFIG);
    assert.equal(positive.underwriting.verdict, "PASS"); assert.ok(positive.underwriting.best!.profit > 0);
    const hold = evaluation(held); hold.identity = { ...hold.identity!, status: "NEEDS_REVIEW", reasons: ["Release is uncertain."] }; hold.underwriting = underwrite(hold, MONEY_CONFIG);
    const counterfeit = evaluation(fake); counterfeit.condition!.authenticity.concern = "LIKELY_FAKE"; counterfeit.underwriting = underwrite(counterfeit, MONEY_CONFIG);
    const analyses = { [below.id]: done(positive), [loss.id]: done(evaluation(loss, 20)), [held.id]: done(hold), [fake.id]: done(counterfeit) };
    const rows = [loss, listing("mismatch", { match: "OTHER_SET" }), pending, below, held, fake,
        listing("ended", { endTime: new Date(NOW - 1).toISOString() }), listing("unavailable", { availability: "UNAVAILABLE" }),
        listing("above-filter", { currentPrice: 200 }), listing("dropped", { screen: screen({ status: "DROPPED" }) })];
    const filtered = filter(rows, analyses, { maxPrice: "150" });
    const alternatives = selectDealAlternatives(filtered, analyses, MONEY_CONFIG.targets, NOW);
    assert.deepEqual(alternatives.map(option => [option.listing.id, option.label]), [[below.id, "Below your targets"], [pending.id, "Resale not yet verified"]]);
    assert.equal(alternatives[0].profit, positive.underwriting.best!.profit);
    assert.equal(alternatives[1].profit, null); assert.equal(alternatives[1].roi, null);
    assert.deepEqual(groupSearchResults(filtered, analyses, false, new Set()).deals, [], "alternatives do not become Deals");
});

test("unfinished and reference-only alternatives expose no optimistic profit and require no provider work", t => {
    const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("alternatives only project saved results"));
    const reference = listing("reference"), value = evaluation(reference, 5000);
    value.rawPricing!.prices[0].basis = "TCGPLAYER";
    value.underwriting = underwrite(value, MONEY_CONFIG);
    const unavailable = listing("no-sold-quotes", { screen: screen({ status: "UNSCREENED", soldEvidence: {
        status: "UNAVAILABLE", exactScope: false, references: [], note: "No sold quotes are available.",
    } }) });
    const rows = [reference, unavailable, ...Array.from({ length: 4 }, (_, index) => listing(`pending-${index}`))];
    const analyses = { [reference.id]: done(value) }, before = structuredClone({ rows, analyses });
    const alternatives = selectDealAlternatives(filter(rows, analyses), analyses, MONEY_CONFIG.targets, NOW);
    assert.equal(alternatives.length, 3);
    assert.deepEqual(selectDealAlternatives([unavailable], analyses, MONEY_CONFIG.targets, NOW), []);
    assert.deepEqual(selectDealAlternatives([reference], analyses, MONEY_CONFIG.targets, NOW).map(option => [option.listing.id, option.profit]), [[reference.id, null]]);
    assert.ok(!alternatives.some(option => option.listing.id === unavailable.id));
    assert.ok(alternatives.every(option => option.label === "Resale not yet verified" && option.profit === null && option.roi === null));
    assert.deepEqual({ rows, analyses }, before); assert.equal(fetch.mock.callCount(), 0);
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
