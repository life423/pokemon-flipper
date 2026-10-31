import type { Evaluation, ListingSummary, PhotoCheck } from "./types.ts";
import { photoAssessmentConfidence } from "./photo-evidence.ts";

export const DEEP_PHOTO_LIMIT = 8;
export function planDeeperPhotos(check: PhotoCheck | null, photos: string[]) {
    if (!check || check.cardCount !== "ONE") return { photos: [], reason: "A completed photo check of one card is needed first." };
    const seen = new Set<string>();
    const useful = check.images.filter((image) => {
        const url = photos[image.number - 1]?.replace(/\/s-l\d+\./, "/s-l1600.");
        if (!url || !image.usable || image.isStockImage || seen.has(url)) return false;
        seen.add(url); return true;
    });
    if (!useful.some((image) => image.view === "FRONT" && !image.obscuresCondition)) {
        return { photos: [], reason: "Ask the seller for a clear, unobscured front photo before paying for a deeper review." };
    }
    // Give each useful view a turn before adding more of the same view.
    const selected: typeof useful = [];
    for (const view of ["FRONT", "BACK", "FRONT_DETAIL", "BACK_DETAIL"]) {
        const image = useful.find((entry) => entry.view === view);
        if (image) selected.push(image);
    }
    for (const image of useful) if (!selected.includes(image)) selected.push(image);
    return { photos: selected.slice(0, DEEP_PHOTO_LIMIT).map((image) => ({ number: image.number, view: image.view, url: photos[image.number - 1].replace(/\/s-l\d+\./, "/s-l1600.") })), reason: null };
}

export function deeperPhotoConcerns(evaluation: Pick<Evaluation, "deeperPhotoReview">): string[] {
    return evaluation.deeperPhotoReview?.findings.filter((finding) => finding.impact === "NEW_CONCERN").map((finding) => finding.observation) ?? [];
}

export function photoReviewStatus(evaluation: Evaluation | null, listing?: ListingSummary) {
    if (!evaluation?.photoCheck) return {
        title: listing?.screen?.evidence?.mainPhoto === "MATCH" || listing?.mistakes?.length ? "AI preliminary photo check only" : "AI photo review not completed",
        confidence: "UNKNOWN", checked: 0, total: listing?.images?.length ?? 0, reviewedAt: null, reasons: [] as string[], photoNotes: [] as string[], needsYourReview: false,
    };
    const check = evaluation.photoCheck;
    const confidence = photoAssessmentConfidence(evaluation);
    const newConcerns = deeperPhotoConcerns(evaluation);
    const reasons = [...newConcerns];
    const photoNotes = check.images.filter((image) => image.obscuresCondition).flatMap((image) => image.issues);
    if (!evaluation.slab) reasons.push(...photoNotes);
    if (evaluation.identity?.status !== "IDENTIFIED") reasons.push(...(evaluation.identity?.reasons ?? ["The exact card identity is uncertain."]));
    if (evaluation.slab?.status !== "OK" && evaluation.slab) reasons.push(...evaluation.slab.reasons);
    if (!evaluation.slab && evaluation.condition?.gradeRange.likely === null) reasons.push("The photos do not support a single likely grade.");
    if (!evaluation.slab && !evaluation.condition) reasons.push("AI could not support a raw-condition or grade estimate.");
    if (!evaluation.slab) {
        if (confidence === "LOW") reasons.push("Photo assessment confidence is low.");
        reasons.push(...check.missingViews.map((view) => `Missing view: ${view.toLowerCase().replaceAll("_", " ")}.`));
        reasons.push(...evaluation.modeReasons);
    }
    const concerns = reasons.length > 0;
    return { title: "AI photo review complete", confidence, checked: check.images.length,
        total: evaluation.listing.photosInListing, reviewedAt: evaluation.answeredAt,
        reasons: [...new Set(reasons)], photoNotes: evaluation.slab ? [...new Set(photoNotes)] : [], needsYourReview: concerns };
}
