import { analyzeListingPhotos } from "./openai.js";

// Maps the photo-sufficiency verdict to how much grading we allow:
//   SUFFICIENT → FULL    (normal grade range)
//   PARTIAL    → LIMITED (wider, conservative range with warnings)
//   anything else → BLOCKED (no grade at all)
// The default case means a missing or unexpected verdict is
// always BLOCKED, so the gate fails closed.
export function getGradingMode(photoAnalysis) {
    switch (photoAnalysis?.photoSufficiency) {
        case "SUFFICIENT":
            return "FULL";

        case "PARTIAL":
            return "LIMITED";

        default:
            return "BLOCKED";
    }
}

export async function evaluateListing() {
    const photoAnalysis = await analyzeListingPhotos();
    const gradingMode = getGradingMode(photoAnalysis);

    if (gradingMode === "BLOCKED") {
        return {
            photoAnalysis,
            gradingMode,
            gradeStatus: "SKIPPED_INSUFFICIENT_PHOTOS",
            gradeEstimate: null,
        };
    }

    // Grade estimation will go here, and must respect gradingMode:
    //   FULL    → normal grade range
    //   LIMITED → wider/conservative range, low confidence, warnings
    return {
        photoAnalysis,
        gradingMode,
        gradeStatus: "NOT_IMPLEMENTED",
        gradeEstimate: null,
    };
}
