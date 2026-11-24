import { test } from "node:test";
import assert from "node:assert/strict";
import { cardEvaluation } from "./fixtures/card-evaluation.ts";
import { planDeeperPhotos, photoReviewStatus } from "../shared/photo-review.ts";
import { photoEvidence, slabLabelConfidence } from "../shared/photo-evidence.ts";
import { retargetEvaluation } from "../shared/money/targets.ts";
import { resultGroup } from "../shared/analysis.ts";
import { auctionDecision } from "../shared/card-presentation.ts";
import type { DeeperPhotoReview } from "../shared/types.ts";
import { mixedCoverageEvaluation } from "./fixtures/photo-coverage.ts";

function deep(impact: DeeperPhotoReview["findings"][number]["impact"]): DeeperPhotoReview {
    return { inputKey: "test", reviewedAt: "2026-10-26T13:00:00Z", summary: "Focused second opinion", photoNumbers: [1],
        findings: [{ area: "IDENTITY", impact, observation: "The printing mark contradicts the initial reading.", photoNumbers: [1] }], requestedPhotos: [], usage: { inputTokens: 1, outputTokens: 1 } };
}
const any = { minProfit: 0, minRoi: 0 };
test("disclosed corner and edge wear hidden by a holder is a terminal pass", () => {
    const e = cardEvaluation(any);
    e.listing.conditionNotes = ["Minor corner and edge wear"];
    e.photoCheck!.holder = "TOPLOADER";
    e.photoCheck!.cardCount = "ONE";
    e.condition!.corners.visibility = "PARTIAL";
    e.condition!.edges.visibility = "NOT_VISIBLE";

    const rejected = retargetEvaluation(e, any);
    assert.equal(rejected.underwriting?.verdict, "PASS");
    assert.match(rejected.underwriting?.reasons[0] ?? "", /discloses corner and edge wear/);
    assert.equal(rejected.underwriting?.best, null);
    assert.equal(photoReviewStatus(rejected).needsYourReview, false);

    e.listing.photosInListing++;
    assert.notEqual(retargetEvaluation(e, any).underwriting?.best, null, "a partial gallery might still show the wear");
    e.listing.photos = [1, 2, 3, 4, 5].map(n => `https://i.ebayimg.com/images/g/offline-${n}/s-l1600.jpg`);
    assert.notEqual(retargetEvaluation(e, any).underwriting?.best, null, "an uninspected distinct image might still show the wear");
    e.listing.photos[4] = e.listing.photos[0].replace("1600", "500");
    assert.equal(retargetEvaluation(e, any).underwriting?.best, null, "a resized duplicate adds no uninspected view");
    e.photoCheck!.images[3].number = 5;
    assert.notEqual(retargetEvaluation(e, any).underwriting?.best, null, "two reports on one image cannot substitute for a missing distinct view");
    e.photoCheck!.images[3].number = 4;
    delete e.listing.photos;
    e.listing.photosInListing--;
    e.listing.conditionNotes = ["No corner or edge wear"];
    assert.notEqual(retargetEvaluation(e, any).underwriting?.best, null, "negated wear is not a disclosure");
    e.listing.conditionNotes = ["Minor corner and edge wear"];
    e.condition!.corners.visibility = e.condition!.edges.visibility = "CLEAR";
    assert.notEqual(retargetEvaluation(e, any).underwriting?.best, null, "clear areas remain eligible for pricing");
});

test("readable verified slabs keep incidental glare as notes, but identity, case and deeper concerns still need review", () => {
    const e = cardEvaluation(); e.condition = null; e.gradingMode = "BLOCKED";
    e.modeReasons = ["The card is already graded."];
    e.photoCheck!.confidence = "LOW";
    e.photoCheck!.holder = "GRADED_SLAB";
    e.photoCheck!.cardCount = "ONE";
    e.photoCheck!.missingViews = ["Angled raw surface"];
    e.photoCheck!.images[0].obscuresCondition = true;
    e.photoCheck!.images[0].issues = ["Plastic reflections obscure tiny raw scratches."];
    e.photoCheck!.slab = { present: true, grader: "PSA", grade: "7", gradeQualifier: null, certNumber: "123", labelText: "PSA 7", caseCondition: "SCRATCHED", authenticity: "NONE_SEEN", concerns: [] };
    e.slab = { status: "OK", grader: "PSA", grade: "7", gradeQualifier: null, certNumber: "123", certUrl: null, labelText: "PSA 7", caseCondition: "SCRATCHED", reasons: [], concerns: [] };
    const status = photoReviewStatus(e);
    assert.equal(status.needsYourReview, false);
    assert.equal(status.confidence, "LOW", "photo limitations remain visible");
    assert.equal(slabLabelConfidence(e), "HIGH", "readable certified grade remains high confidence despite glare and case scratches");
    assert.deepEqual(status.photoNotes, ["Photo 1 (front): Plastic reflections obscure tiny raw scratches."]);
    e.slab.status = "NEEDS_REVIEW"; e.slab.reasons = ["Case is cracked."];
    assert.ok(photoReviewStatus(e).reasons.includes("Case is cracked."));
    assert.equal(slabLabelConfidence(e), null);
    e.slab.status = "OK"; e.slab.reasons = []; e.identity!.status = "NEEDS_REVIEW"; e.identity!.reasons = ["Card number differs."];
    assert.ok(photoReviewStatus(e).reasons.includes("Card number differs."));
    assert.equal(slabLabelConfidence(e), null);
    e.identity!.status = "IDENTIFIED"; e.deeperPhotoReview = deep("NEW_CONCERN");
    assert.equal(photoReviewStatus(e).needsYourReview, true);
    assert.equal(slabLabelConfidence(e), null);
    e.deeperPhotoReview = undefined;
    e.photoCheck!.slab.grade = "6";
    assert.equal(slabLabelConfidence(e), null, "a contradictory grade cannot get the high confidence label");
});

test("readable slab confidence and informational seller-certificate notes remain separate from manual concerns", () => {
    const e = cardEvaluation();
    e.condition = null;
    e.photoCheck!.holder = "GRADED_SLAB";
    e.photoCheck!.confidence = "HIGH";
    const note = "The seller-entered certificate number differs from the readable slab label. The photographed label's certificate number is used.";
    e.slab = { status: "OK", grader: "PSA", grade: "5", gradeQualifier: null, certNumber: "123", certUrl: null, labelText: "PSA 5", caseCondition: "INTACT", reasons: [], concerns: [note] };
    const status = photoReviewStatus(e);
    assert.equal(status.confidence, "HIGH");
    assert.equal(status.needsYourReview, false);
    assert.ok(status.photoNotes.includes(note));
    assert.deepEqual(status.reasons, []);
    e.slab.status = "NEEDS_REVIEW";
    e.slab.reasons = ["Visible label alteration needs review."];
    const held = photoReviewStatus(e);
    assert.equal(held.confidence, "HIGH", "a clear photo reading is distinct from purchase or authenticity certainty");
    assert.equal(held.needsYourReview, true);
    assert.ok(held.reasons.includes("Visible label alteration needs review."));
    assert.equal(photoEvidence(e).confidence, held.confidence);
});
test("a completed low-confidence AI review is distinguished from pending and preliminary photo checks", () => {
    const e = cardEvaluation(); e.condition!.confidence = "LOW"; e.condition!.gradeRange.likely = null;
    const status = photoReviewStatus(e);
    assert.equal(status.title, "AI photo review complete"); assert.equal(status.needsYourReview, true);
    assert.match(status.reasons.join(" "), /single likely grade/);
    assert.equal(status.reviewedAt, e.answeredAt);
    assert.equal(photoReviewStatus(null).title, "AI photo review not completed");
    assert.equal(photoReviewStatus(null, { screen: { evidence: { mainPhoto: "MATCH" } } } as never).title, "AI preliminary photo check only");
});

test("an inconclusive Base Set printing review distinguishes the recognized card from the unresolved marks", () => {
    const evaluation = cardEvaluation();
    const generic = "The photos don't clearly show which printing this is.";
    const conflict = "The title and item details disagree about the printing.";
    evaluation.identity!.status = "NEEDS_REVIEW";
    evaluation.identity!.reasons = [generic, conflict];
    evaluation.photoCheck!.cardIdentity = { name: "Mewtwo", set: "Base Set", cardNumber: "10/102", language: "English", finish: "HOLO",
        confidence: "HIGH", evidence: ["The English text and 10/102 are visible."] };
    evaluation.photoCheck!.printingMarks = { artBoxShadow: "CANT_TELL", firstEditionStamp: "CANT_TELL" };
    const status = photoReviewStatus(evaluation);
    assert.equal(status.needsYourReview, true);
    assert.ok(status.reasons.includes("The photo review identified the card. That review could not confirm the shadow along the artwork border or the First Edition stamp."));
    assert.ok(status.reasons.includes(conflict));
    assert.ok(!status.reasons.includes(generic));
    assert.deepEqual(evaluation.identity!.reasons, [generic, conflict]);

    for (const [catalogSet, photographedSet, language] of [
        ["Neo Destiny", "Neo Destiny", "English"],
        ["Base Set 2", "Base Set 2", "English"],
        ["Base Set", "Neo Destiny", "English"],
        ["Neo Destiny", "Base Set", "English"],
        ["Base Set", "Base Set", "Japanese"],
    ]) {
        evaluation.identity!.set = catalogSet;
        Object.assign(evaluation.photoCheck!.cardIdentity!, { set: photographedSet, language });
        const reasons = photoReviewStatus(evaluation).reasons;
        assert.ok(reasons.includes(generic));
        assert.ok(reasons.includes(conflict));
        assert.doesNotMatch(reasons.join(" "), /artwork border|First Edition stamp/i);
    }
    for (const cardNumber of ["8/102", "95/102", "10/130"]) {
        evaluation.identity!.set = "Base Set";
        Object.assign(evaluation.photoCheck!.cardIdentity!, { set: "Base Set", language: "English", cardNumber });
        assert.ok(photoReviewStatus(evaluation).reasons.includes(generic));
    }
});

test("a previously skipped photo set can be completed without asking for manual review", () => {
    const evaluation = cardEvaluation();
    evaluation.photoCheck!.images = evaluation.photoCheck!.images.slice(0, 1);
    const reason = "This offer might work at the changed listing terms. The rest of the photos are pending.";
    evaluation.underwriting = { verdict: "CANT_PRICE", reasons: [reason], best: null, paths: [], assumptions: [] };
    for (const stop of ["SLAB_PRICE", "RAW_PRICE"] as const) {
        evaluation.frontPhotoStop = stop;
        const status = photoReviewStatus(evaluation);
        assert.equal(status.title, "Front photo checked");
        assert.equal(status.checked, 1);
        assert.equal(status.needsYourReview, false);
        assert.deepEqual(status.reasons, []);
        assert.ok(status.photoNotes.includes(reason));
        assert.ok(status.photoNotes.includes("The remaining listing photos have not been checked."));
    }
    evaluation.deeperPhotoReview = deep("NEW_CONCERN");
    assert.equal(photoReviewStatus(evaluation).needsYourReview, true);
});

test("targeted photo selection covers different views within six unique listing photos", () => {
    const e = cardEvaluation(); const check = e.photoCheck!; check.cardCount = "ONE";
    const urls = Array.from({ length: 15 }, (_, i) => `https://i.ebayimg.com/images/g/${i}/s-l225.jpg`);
    check.images = urls.map((_, i) => ({ number: i + 1, view: i === 0 ? "FRONT" : i === 1 ? "BACK" : i === 2 ? "FRONT_DETAIL" : "BACK_DETAIL", usable: true, isStockImage: i === 14, issues: [] }));
    urls[4] = urls[0].replace("225", "1600");
    const plan = planDeeperPhotos(check, urls);
    assert.equal(plan.photos.length, 6);
    assert.deepEqual(plan.photos.slice(0, 4).map((photo) => photo.view), ["FRONT", "BACK", "FRONT_DETAIL", "BACK_DETAIL"]);
    assert.ok(plan.photos.every((photo) => photo.number !== 5 && photo.number !== 15 && photo.url.includes("1600")));
    check.images[0].obscuresCondition = true;
    assert.equal(planDeeperPhotos(check, urls).photos.length, 0);
});

test("new photo risks pause Deals and offers while retaining original grade, price scenarios and confidence", () => {
    const original = cardEvaluation(any); original.listing.price = 1;
    const before = retargetEvaluation(original, any); original.deeperPhotoReview = deep("NEW_CONCERN");
    const after = retargetEvaluation(original, any);
    assert.equal(after.underwriting?.verdict, "NEEDS_REVIEW"); assert.equal(after.rating, null);
    assert.deepEqual(after.condition, before.condition);
    assert.deepEqual(after.underwriting?.paths, before.underwriting?.paths);
    assert.deepEqual(after.underwriting?.best, before.underwriting?.best);
    assert.equal(resultGroup({ ...original.listing, currentPrice: 1, images: [], isGraded: false, bestOffer: true }, after, true), "review");
    assert.equal(auctionDecision(after, any).provisional, true);
});

test("supporting or unresolved notes never promote an existing assessment or override fake-card protection", () => {
    const original = cardEvaluation(any); original.listing.price = 1;
    for (const impact of ["SUPPORTS_PRIOR", "UNRESOLVED"] as const) {
        const after = retargetEvaluation({ ...original, deeperPhotoReview: deep(impact) }, any);
        const before = retargetEvaluation(original, any);
        assert.deepEqual(after.underwriting, before.underwriting);
        assert.equal(after.condition?.confidence, original.condition?.confidence);
    }
    original.condition!.authenticity.concern = "LIKELY_FAKE";
    const fake = retargetEvaluation({ ...original, deeperPhotoReview: deep("NEW_CONCERN") }, any);
    assert.equal(fake.underwriting?.verdict, "PASS"); assert.equal(fake.underwriting?.best, null);
});

test("a completed stock/blocked photo check does not advertise high condition confidence", () => {
    const e = cardEvaluation(); e.condition = null; e.gradingMode = "BLOCKED";
    e.photoCheck!.confidence = "HIGH";
    e.photoCheck!.images.forEach((photo) => { photo.isStockImage = true; });
    const status = photoReviewStatus(e);
    assert.equal(status.title, "AI photo review complete");
    assert.equal(status.confidence, "UNKNOWN");
    assert.equal(photoEvidence(e).confidence, "UNKNOWN", "the detailed evidence section agrees with the review summary");
    assert.equal(status.needsYourReview, true);
    assert.match(status.reasons.join(" "), /could not support/);
});

test("a cropped back close-up stays a numbered photo note when the full back is covered", () => {
    const evaluation = mixedCoverageEvaluation();
    const before = structuredClone(evaluation);
    const status = photoReviewStatus(evaluation);
    assert.equal(status.needsYourReview, false);
    assert.deepEqual(status.reasons, []);
    assert.ok(status.photoNotes.includes("Photo 2 (back close-up): Only the upper-right portion of the card back is shown."));
    assert.ok(status.photoNotes.includes("Photo 4 (back): Lighting is uneven, though the full back, borders, corners, and much of the surface remain visible."));
    assert.ok(status.photoNotes.some(note => note.startsWith("Additional view requested by AI:")));
    assert.equal(photoEvidence(evaluation).coverage, "8 usable photos: 2 front, 4 back, 2 close-ups");
    assert.match(photoEvidence(evaluation).issues[0], /^Photo 2 \(back close-up\):/);
    assert.deepEqual(evaluation, before, "displaying photo scope must not change saved grades, confidence, prices or advice");
});

test("missing or obscured whole-side coverage still needs review for actionable grading despite usable close-ups", () => {
    const gradingAdvice = () => retargetEvaluation(mixedCoverageEvaluation(), any);
    assert.equal(gradingAdvice().underwriting?.best?.path, "GRADE");
    for (const side of ["FRONT", "BACK"]) {
        const missing = gradingAdvice();
        missing.photoCheck!.images = missing.photoCheck!.images.filter(photo => photo.view !== side);
        missing.listing.photosInListing = missing.photoCheck!.images.length;
        missing.photoCheck!.missingViews = [];
        const status = photoReviewStatus(missing);
        assert.equal(status.needsYourReview, true);
        assert.ok(status.reasons.includes(`No usable photo shows the whole ${side.toLowerCase()}.`));
        const obscured = gradingAdvice();
        obscured.photoCheck!.images.filter(photo => photo.view === side).forEach(photo => { photo.obscuresCondition = true; });
        assert.ok(photoReviewStatus(obscured).reasons.includes(`Every usable whole-${side.toLowerCase()} photo has obscured detail.`));
    }
    const stockBack = gradingAdvice();
    stockBack.photoCheck!.images.filter(photo => photo.view === "BACK").forEach(photo => { photo.isStockImage = true; });
    assert.equal(photoReviewStatus(stockBack).needsYourReview, true);
});

test("partial-gallery missing or obscured views describe only reviewed photos and retain grading holds", () => {
    for (const side of ["FRONT", "BACK"] as const) {
        for (const obscured of [false, true]) {
            const evaluation = retargetEvaluation(mixedCoverageEvaluation(), any);
            assert.equal(evaluation.underwriting?.best?.path, "GRADE");
            evaluation.photoCheck!.images = evaluation.photoCheck!.images.slice(0, 6);
            evaluation.photoCheck!.images.forEach(photo => {
                if (photo.view === side) {
                    if (obscured) photo.obscuresCondition = true;
                    else photo.view = side === "FRONT" ? "FRONT_DETAIL" : "BACK_DETAIL";
                }
            });
            evaluation.listing.photosInListing = 11;
            evaluation.listing.photosAnalyzed = 6;
            const before = structuredClone(evaluation);
            const status = photoReviewStatus(evaluation);
            const warning = obscured
                ? `Every usable whole-${side.toLowerCase()} view among the 6 reviewed photos has obscured detail; 5 listing photos were not reviewed.`
                : `No usable whole-${side.toLowerCase()} view among the 6 reviewed photos; 5 listing photos were not reviewed.`;
            assert.ok(status.reasons.includes(warning));
            assert.equal(status.needsYourReview, true, "incomplete grading evidence still needs review");
            assert.equal(status.checked, 6);
            assert.equal(status.total, 11);
            assert.deepEqual(evaluation, before, "presentation never changes grades, advice or saved evidence");
        }
    }
});

test("partial raw-resale coverage remains an accurately scoped note rather than a new manual task", () => {
    const evaluation = mixedCoverageEvaluation();
    evaluation.underwriting!.best!.path = "RAW";
    evaluation.photoCheck!.images = [evaluation.photoCheck!.images.find(photo => photo.view === "FRONT")!];
    evaluation.listing.photosInListing = 2;
    evaluation.listing.photosAnalyzed = 1;
    const status = photoReviewStatus(evaluation);
    assert.equal(status.needsYourReview, false);
    assert.ok(status.photoNotes.includes("No usable whole-back view among the 1 reviewed photo; 1 listing photo was not reviewed."));
    assert.ok(!status.photoNotes.includes("No usable photo shows the whole back."));
});

test("the four-photo Mewtwo's supported raw condition leaves missing sold prices in sorting", () => {
    const evaluation = cardEvaluation();
    evaluation.listing.photosInListing = evaluation.listing.photosAnalyzed = 4;
    evaluation.condition!.rawCondition = "MODERATELY_PLAYED";
    evaluation.condition!.confidence = "LOW";
    evaluation.condition!.gradeRange = null;
    evaluation.rawPricing = { status: "PRICE_UNAVAILABLE", reason: "No accepted condition-matched sold price." };
    evaluation.photoCheck!.images = [
        { number: 1, view: "FRONT", usable: true, isStockImage: false, obscuresCondition: false, issues: ["Some glare and mild blur, but identity and lower text are readable."] },
        { number: 2, view: "BACK", usable: true, isStockImage: false, obscuresCondition: true, issues: ["Glare and image cropping; most of the back is visible."] },
        { number: 3, view: "BACK_DETAIL", usable: true, isStockImage: false, obscuresCondition: true, issues: ["Close-up is cropped and does not show the complete back or all edges."] },
        { number: 4, view: "BACK_DETAIL", usable: true, isStockImage: false, obscuresCondition: true, issues: ["Close-up is upside down, cropped, and glare-heavy."] },
    ];
    const value = retargetEvaluation(evaluation, any);
    assert.equal(value.underwriting?.verdict, "CANT_PRICE");
    const status = photoReviewStatus(value);
    assert.equal(status.needsYourReview, false);
    assert.ok(status.photoNotes.includes("The only usable back overview has limited detail."));
    assert.ok(status.photoNotes.includes("Photo 2 (back): Glare and image cropping; most of the back is visible."));
    assert.equal(resultGroup({} as never, value), "candidates");
    value.identity!.status = "NEEDS_REVIEW";
    value.identity!.reasons = ["The photographed collector number conflicts with the listing."];
    assert.ok(photoReviewStatus(value).reasons.includes(value.identity!.reasons[0]));
    assert.equal(resultGroup({} as never, value), "review");
});

test("overall identity, authenticity and purchase holds still require review with clear full-card coverage", () => {
    const identity = mixedCoverageEvaluation(); identity.identity!.status = "NEEDS_REVIEW"; identity.identity!.reasons = ["The card number differs."];
    assert.ok(photoReviewStatus(identity).reasons.includes("The card number differs."));
    const authenticity = mixedCoverageEvaluation(); authenticity.condition!.authenticity = { concern: "POSSIBLE", reasons: ["Visible font mismatch."] };
    assert.ok(photoReviewStatus(authenticity).reasons.includes("Visible font mismatch."));
    const held = mixedCoverageEvaluation(); held.underwriting!.verdict = "NEEDS_REVIEW"; held.underwriting!.reasons = ["Unresolved label conflict."];
    assert.ok(photoReviewStatus(held).reasons.includes("Unresolved label conflict."));
    const unknown = mixedCoverageEvaluation(); unknown.condition!.rawCondition = "UNKNOWN";
    assert.equal(photoReviewStatus(unknown).needsYourReview, true);
    const raw = mixedCoverageEvaluation(); raw.underwriting!.best!.path = "RAW"; raw.condition!.gradeRange.likely = null;
    assert.equal(photoReviewStatus(raw).needsYourReview, false, "raw resale does not require a single submission-grade estimate");
    assert.ok(photoReviewStatus(raw).photoNotes.includes("The photos do not support a single likely grade."));
});

test("intentional low-value deferral is not a manual task, while real identity or authenticity conflicts remain visible", () => {
    const e = mixedCoverageEvaluation(); e.researchMode = "DEFERRED_LOW_RESALE"; e.condition = null;
    e.underwriting = { verdict: "NEEDS_REVIEW", reasons: ["There's no condition estimate from the photos."], best: null, paths: [], assumptions: [] };
    assert.equal(photoReviewStatus(e).needsYourReview, false);
    assert.equal(resultGroup({} as never, e), null);
    e.identity!.status = "NEEDS_REVIEW"; e.identity!.reasons = ["Visible number conflicts with the record."];
    assert.equal(photoReviewStatus(e).needsYourReview, true);
    assert.equal(resultGroup({} as never, e), "review");
    const suspicious = mixedCoverageEvaluation(); suspicious.researchMode = "DEFERRED_LOW_RESALE";
    suspicious.condition!.authenticity.concern = "POSSIBLE"; suspicious.condition!.authenticity.reasons = ["The printed font differs."];
    assert.equal(resultGroup({} as never, suspicious), "review");
});


test("photo notes reconcile side availability across previously accepted stages", () => {
    const e = cardEvaluation(any);
    const check = e.photoCheck!;
    check.images[0].issues = ["Only the front is supplied; back and edge details are unavailable.", "Vertical scratch on holo."];
    check.images[1].view = "BACK";
    check.images[1].issues = ["Fine back edge detail is limited."];
    check.missingViews = ["FULL_BACK", "FRONT in the new input; prior front evidence is available", "Angled holo"];
    const notes = photoReviewStatus(e).photoNotes.join(" ");
    assert.doesNotMatch(notes, /Only the front|FULL_BACK|FRONT in the new input/);
    assert.match(notes, /Edge detail is unavailable in this photo/);
    assert.match(notes, /Vertical scratch on holo/);
    assert.match(notes, /Fine back edge detail is limited/);
    assert.match(notes, /Angled holo/);
});
