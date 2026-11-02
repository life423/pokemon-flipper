import { cardEvaluation } from "./card-evaluation.ts";

// Mirrors the saved 147652972123 report's coverage: photo 2 is a cropped
// close-up, while photo 4 is a usable, unobscured view of the whole back.
export function mixedCoverageEvaluation() {
    const evaluation = cardEvaluation();
    evaluation.gradingMode = "FULL";
    evaluation.modeReasons = [];
    evaluation.condition!.confidence = "MEDIUM";
    evaluation.condition!.gradeRange = { low: 7, likely: 8, high: 9 };
    Object.assign(evaluation.photoCheck!, { cardCount: "ONE", confidence: "MEDIUM", photoSufficiency: "PARTIAL", images: [
        { number: 1, view: "FRONT", usable: true, isStockImage: false, obscuresCondition: false, issues: [] },
        { number: 2, view: "BACK_DETAIL", usable: true, isStockImage: false, obscuresCondition: true,
            issues: ["Only the upper-right portion of the card back is shown.", "Strong glare obscures fine surface detail in that area."] },
        { number: 3, view: "BACK_DETAIL", usable: true, isStockImage: false, obscuresCondition: true, issues: ["Only the upper-left portion of the card back is shown."] },
        { number: 4, view: "BACK", usable: true, isStockImage: false, obscuresCondition: false,
            issues: ["Lighting is uneven, though the full back, borders, corners, and much of the surface remain visible."] },
        { number: 5, view: "BACK", usable: true, isStockImage: false, obscuresCondition: true, issues: ["Direct glare obscures fine back-surface scratches there."] },
        { number: 6, view: "BACK", usable: true, isStockImage: false, obscuresCondition: true, issues: ["Oblique viewing angle introduces perspective distortion."] },
        { number: 7, view: "BACK", usable: true, isStockImage: false, obscuresCondition: true, issues: ["Glare obscures fine surface detail."] },
        { number: 8, view: "FRONT", usable: true, isStockImage: false, obscuresCondition: true, issues: ["The alternate front has glare over the lower text."] },
    ], missingViews: ["Low-glare, straight-on close-up of the front holofoil surface.", "Low-glare, straight-on close-up of the full back surface."] });
    evaluation.listing.photosInListing = 8;
    evaluation.listing.photosAnalyzed = 8;
    return evaluation;
}
