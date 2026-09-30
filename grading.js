import { getListingDetails } from "./ebay.js";
import { checkListingPhotos, assessCardCondition } from "./openai.js";

// Cost cap: only the first photos, in the seller's order.
const MAX_PHOTOS = 8;

const AREAS = ["centering", "corners", "edges", "surface"];
const CLOSE_UP_VIEWS = ["FRONT_DETAIL", "BACK_DETAIL"];

const NO_CLOSE_UPS =
    "No close-up photos, so fine surface flaws like holo scratches can't be ruled out.";

function isClearPhoto(photo) {
    return photo.usable && !photo.isStockImage;
}

export function hasCloseUps(photoCheck) {
    return photoCheck.images.some(
        (photo) => isClearPhoto(photo) && CLOSE_UP_VIEWS.includes(photo.view)
    );
}

// Code-enforced rules on the photo check. Drops reports for photos
// that don't exist or were already reported, and never allows high
// confidence without a close-up.
export function applyPhotoCheckRules(photoCheck, photoCount) {
    const seen = new Set();

    const images = photoCheck.images.filter((photo) => {
        const valid =
            Number.isInteger(photo.number) &&
            photo.number >= 1 &&
            photo.number <= photoCount &&
            !seen.has(photo.number);

        seen.add(photo.number);
        return valid;
    });

    const checked = { ...photoCheck, images };

    if (!hasCloseUps(checked) && checked.confidence === "HIGH") {
        checked.confidence = "MEDIUM";
    }

    return checked;
}

// The model reports what it sees. These rules, not the model,
// decide how much grading the evidence allows. Anything missing
// or unexpected fails closed.
export function getGradingMode(photoCheck) {
    const clearPhotos = photoCheck.images.filter(isClearPhoto);
    const hasView = (view) => clearPhotos.some((photo) => photo.view === view);

    const blockedReasons = [];

    if (photoCheck.cardCount !== "ONE") {
        blockedReasons.push("The listing doesn't show exactly one card.");
    }
    if (photoCheck.holder === "GRADED_SLAB") {
        blockedReasons.push("The card is already graded.");
    }
    if (!hasView("FRONT")) {
        blockedReasons.push("No usable photo shows the front.");
    }
    // The model's overall verdict only counts when it rules the
    // photos out. "Partial" is a borderline call that flips between
    // runs, so full versus limited comes from the concrete facts below.
    if (!["SUFFICIENT", "PARTIAL"].includes(photoCheck.photoSufficiency)) {
        blockedReasons.push("The photos aren't good enough to judge condition.");
    }

    if (blockedReasons.length > 0) {
        return { mode: "BLOCKED", reasons: blockedReasons };
    }

    const limitedReasons = [];

    if (!hasView("BACK")) {
        limitedReasons.push("No usable photo shows the back.");
    }
    if (photoCheck.confidence === "LOW") {
        limitedReasons.push("The photo check has low confidence.");
    }
    if (photoCheck.images.some((photo) => photo.isStockImage)) {
        limitedReasons.push("Some photos are stock images, not this copy.");
    }
    if (photoCheck.holder !== "NONE") {
        limitedReasons.push("A sleeve or holder may hide edges and surface.");
    }

    const mode = limitedReasons.length > 0 ? "LIMITED" : "FULL";

    // A note, not a downgrade: front and back photos alone still
    // get graded, just without a clean bill for the surface.
    const notes = hasCloseUps(photoCheck) ? [] : [NO_CLOSE_UPS];

    return { mode, reasons: [...limitedReasons, ...notes] };
}

function isGrade(value) {
    return Number.isInteger(value) && value >= 1 && value <= 10;
}

// Code-enforced rules on the condition report. Returns null when
// the grade range is broken, since there's no safe way to repair it.
export function applyConditionRules(
    assessment,
    gradingMode,
    { closeUps = false } = {}
) {
    const condition = structuredClone(assessment);

    // Whole-card photos can show a surface flaw, but they can't
    // prove there isn't one. A visible defect still counts.
    if (!closeUps) {
        if (condition.surface.visibility === "CLEAR") {
            condition.surface.visibility = "PARTIAL";
        }
        if (condition.surface.severity === "NONE") {
            condition.surface.severity = "UNKNOWN";
        }
        condition.limitations = [...condition.limitations, NO_CLOSE_UPS];
    }

    // An area no photo shows has unknown severity, whatever the model said.
    for (const area of AREAS) {
        if (condition[area].visibility === "NOT_VISIBLE") {
            condition[area].severity = "UNKNOWN";
        }
    }

    const { low, likely, high } = condition.gradeRange;

    const validRange =
        isGrade(low) &&
        isGrade(high) &&
        low <= high &&
        (likely === null || (isGrade(likely) && low <= likely && likely <= high));

    if (!validRange) {
        return null;
    }

    // Limited evidence never names a single grade or claims confidence.
    if (gradingMode === "LIMITED") {
        condition.gradeRange.likely = null;
        condition.confidence = "LOW";
    }

    // High confidence needs every area clearly visible.
    const allClear = AREAS.every(
        (area) => condition[area].visibility === "CLEAR"
    );

    if (!allClear && condition.confidence === "HIGH") {
        condition.confidence = "MEDIUM";
    }

    return condition;
}

export async function evaluateListing(itemId) {
    const listing = await getListingDetails(itemId);
    const photoUrls = listing.images.slice(0, MAX_PHOTOS);

    const evaluation = {
        listing: {
            id: listing.id,
            title: listing.title,
            url: listing.url,
            sellerCondition: listing.condition,
            aspects: listing.aspects,
            photosInListing: listing.images.length,
            photosAnalyzed: photoUrls.length,
        },
        photoCheck: null,
        gradingMode: "BLOCKED",
        modeReasons: [],
        gradeStatus: "SKIPPED",
        condition: null,
        usage: [],
    };

    if (photoUrls.length === 0) {
        evaluation.modeReasons = ["The listing has no photos."];
        return evaluation;
    }

    const photoCheck = await checkListingPhotos(listing, photoUrls);
    const checkedPhotos = applyPhotoCheckRules(photoCheck.result, photoUrls.length);

    evaluation.photoCheck = checkedPhotos;
    evaluation.usage.push({ step: "photoCheck", ...photoCheck.usage });

    const { mode, reasons } = getGradingMode(checkedPhotos);
    evaluation.gradingMode = mode;
    evaluation.modeReasons = reasons;

    if (mode === "BLOCKED") {
        return evaluation;
    }

    // Only the clear photos go to the (more expensive) condition step.
    const photos = checkedPhotos.images.filter(isClearPhoto).map((photo) => ({
        url: photoUrls[photo.number - 1],
        label: photo.view,
    }));

    const assessment = await assessCardCondition(listing, photos, mode);
    evaluation.usage.push({ step: "condition", ...assessment.usage });

    const condition = applyConditionRules(assessment.result, mode, {
        closeUps: hasCloseUps(checkedPhotos),
    });

    if (condition === null) {
        evaluation.gradeStatus = "REJECTED_INVALID_RANGE";
        return evaluation;
    }

    evaluation.gradeStatus = "ESTIMATED";
    evaluation.condition = condition;

    return evaluation;
}
