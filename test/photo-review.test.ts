import { test } from "node:test";
import assert from "node:assert/strict";
import { cardEvaluation } from "./fixtures/card-evaluation.ts";
import { planDeeperPhotos, photoReviewStatus } from "../shared/photo-review.ts";
import { photoEvidence } from "../shared/photo-evidence.ts";
import { retargetEvaluation } from "../shared/money/targets.ts";
import { resultGroup } from "../shared/analysis.ts";
import { auctionDecision } from "../shared/card-presentation.ts";
import type { DeeperPhotoReview } from "../shared/types.ts";

function deep(impact: DeeperPhotoReview["findings"][number]["impact"]): DeeperPhotoReview {
    return { inputKey: "test", reviewedAt: "2026-10-26T13:00:00Z", summary: "Focused second opinion", photoNumbers: [1],
        findings: [{ area: "IDENTITY", impact, observation: "The printing mark contradicts the initial reading.", photoNumbers: [1] }], requestedPhotos: [], usage: { inputTokens: 1, outputTokens: 1 } };
}
const any = { minProfit: 0, minRoi: 0 };
test("a completed low-confidence AI review is distinguished from pending and preliminary photo checks", () => {
    const e = cardEvaluation(); e.condition!.confidence = "LOW"; e.condition!.gradeRange.likely = null;
    const status = photoReviewStatus(e);
    assert.equal(status.title, "AI photo review complete"); assert.equal(status.needsYourReview, true);
    assert.match(status.reasons.join(" "), /single likely grade/);
    assert.equal(status.reviewedAt, e.answeredAt);
    assert.equal(photoReviewStatus(null).title, "AI photo review not completed");
    assert.equal(photoReviewStatus(null, { screen: { evidence: { mainPhoto: "MATCH" } } } as never).title, "AI preliminary photo check only");
});

test("targeted photo selection deduplicates resolutions, excludes stock and limits paid input size", () => {
    const e = cardEvaluation(); const check = e.photoCheck!; check.cardCount = "ONE";
    const urls = Array.from({ length: 15 }, (_, i) => `https://i.ebayimg.com/images/g/${i}/s-l225.jpg`);
    check.images = urls.map((_, i) => ({ number: i + 1, view: i === 0 ? "FRONT" : i === 1 ? "BACK" : i === 2 ? "FRONT_DETAIL" : "BACK_DETAIL", usable: true, isStockImage: i === 14, issues: [] }));
    urls[4] = urls[0].replace("225", "1600");
    const plan = planDeeperPhotos(check, urls);
    assert.equal(plan.photos.length, 8);
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
