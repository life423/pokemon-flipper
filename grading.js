import { getListingDetails } from "./ebay.js";
import {
    ANALYSIS_VERSION,
    checkListingPhotos,
    assessCardCondition,
} from "./openai.js";
import {
    photoFingerprint,
    loadSaved,
    saveRecord,
    reusableRecord,
    assessmentStillFits,
} from "./evaluation-store.js";
import { identifyCard } from "./card-identity.js";
import { rawPricesFor } from "./pricing.js";
import { lookupCards, fetchComps } from "./pkmnprices.js";
import { gradedPricesFor, compsForGrade } from "./graded-comps.js";
import { checkSlab } from "./slab-check.js";
import { GRADERS, underwrite } from "./underwriting.js";
import { rateDeal } from "./deal-rating.js";

// Cost cap: only the first photos, in the seller's order.
const MAX_PHOTOS = 8;

// A first look grades twice and keeps the more cautious answer, so
// one optimistic run can't set the saved answer on its own.
const CONDITION_RUNS = 2;

const AREAS = ["centering", "corners", "edges", "surface"];

// Risk order for picking the more cautious answer. Anything the
// table doesn't know ranks as the riskiest, so surprises fail closed.
const AUTHENTICITY_RISK = ["NONE_SEEN", "POSSIBLE", "LIKELY_FAKE"];
const CREASE_RISK = ["NONE_SEEN", "SUSPECTED", "PRESENT"];
const RAW_CONDITION_RISK = [
    "NEAR_MINT",
    "LIGHTLY_PLAYED",
    "MODERATELY_PLAYED",
    "HEAVILY_PLAYED",
    "DAMAGED",
    "UNKNOWN",
];

function riskOf(order, value) {
    const index = order.indexOf(value);
    return index === -1 ? order.length : index;
}

// Returns the more cautious of two condition answers. A red flag in
// either one wins first (authenticity, then creases), then the lower
// grade range, then the worse raw condition. Ties keep the first.
export function moreCautious(a, b) {
    const likelyOf = (answer) => answer.gradeRange.likely ?? 0;

    const comparisons = [
        riskOf(AUTHENTICITY_RISK, b.authenticity.concern) -
            riskOf(AUTHENTICITY_RISK, a.authenticity.concern),
        riskOf(CREASE_RISK, b.creases) - riskOf(CREASE_RISK, a.creases),
        a.gradeRange.low - b.gradeRange.low,
        likelyOf(a) - likelyOf(b),
        a.gradeRange.high - b.gradeRange.high,
        riskOf(RAW_CONDITION_RISK, b.rawCondition) -
            riskOf(RAW_CONDITION_RISK, a.rawCondition),
    ];

    for (const difference of comparisons) {
        if (difference > 0) return b;
        if (difference < 0) return a;
    }

    return a;
}

function summarizeAnswer(answer) {
    return {
        gradeRange: answer.gradeRange,
        rawCondition: answer.rawCondition,
        authenticity: answer.authenticity.concern,
    };
}

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

// Verified sold comps from each grader, for an identified card.
async function gradedPricesByGrader(card, identity, gradeRange) {
    const byGrader = {};

    for (const grader of GRADERS) {
        try {
            byGrader[grader] = await gradedPricesFor(card, identity, gradeRange, { fetchComps, grader });
        } catch (error) {
            byGrader[grader] = {
                status: "PRICE_UNAVAILABLE",
                reason: `The ${grader} comp lookup failed: ${error.message}`,
            };
        }
    }

    return byGrader;
}

// Verified sold comps for a slab's exact grader and grade.
async function slabPricesFor(card, identity, slab) {
    try {
        return await compsForGrade(card, identity, {
            grader: slab.grader,
            grade: slab.grade,
            fetchComps,
        });
    } catch (error) {
        return {
            status: "PRICE_UNAVAILABLE",
            reason: `The ${slab.grader} comp lookup failed: ${error.message}`,
        };
    }
}

// Grades one listing and prices it. The model's answers are saved per
// listing and reused until the photos, model, or prompts change. The
// code rules, identity, prices, and money math always run fresh.
//   fresh: ignore saved answers and ask the model again.
//   remember: save new answers.
export async function evaluateListing(
    itemId,
    { fresh = false, remember = true } = {}
) {
    const listing = await getListingDetails(itemId);
    const photoUrls = listing.images.slice(0, MAX_PHOTOS);

    const evaluation = {
        listing: {
            id: listing.id,
            title: listing.title,
            url: listing.url,
            sellerCondition: listing.condition,
            cardCondition: listing.cardCondition,
            conditionNotes: listing.conditionNotes,
            seller: listing.seller,
            aspects: listing.aspects,
            price: listing.price,
            shipping: listing.shipping,
            buyingOption: listing.buyingOption,
            bids: listing.bids,
            endTime: listing.endTime,
            photosInListing: listing.images.length,
            photosAnalyzed: photoUrls.length,
        },
        photoCheck: null,
        gradingMode: "BLOCKED",
        modeReasons: [],
        gradeStatus: "SKIPPED",
        condition: null,
        setAside: [],
        identity: null,
        rawPricing: null,
        gradedPricing: null,
        slab: null,
        slabPricing: null,
        underwriting: null,
        rating: null,
        answeredAt: null,
        reusedSteps: [],
        usage: [],
    };

    if (photoUrls.length === 0) {
        evaluation.modeReasons = ["The listing has no photos."];
        evaluation.underwriting = underwrite(evaluation);
        return evaluation;
    }

    const fingerprint = photoFingerprint(photoUrls);

    const saved = fresh
        ? null
        : reusableRecord(await loadSaved(listing.id), {
              version: ANALYSIS_VERSION,
              fingerprint,
          });

    const record = saved ?? {
        itemId: listing.id,
        version: ANALYSIS_VERSION,
        photoFingerprint: fingerprint,
        answeredAt: null,
        photoCheck: null,
        assessment: null,
    };

    let changed = false;

    if (record.photoCheck) {
        evaluation.reusedSteps.push("photoCheck");
    } else {
        const photoCheck = await checkListingPhotos(listing, photoUrls);
        record.photoCheck = { result: photoCheck.result, usage: photoCheck.usage };
        evaluation.usage.push({ step: "photoCheck", ...photoCheck.usage });
        changed = true;
    }

    const checkedPhotos = applyPhotoCheckRules(record.photoCheck.result, photoUrls.length);
    evaluation.photoCheck = checkedPhotos;

    const { mode, reasons } = getGradingMode(checkedPhotos);
    evaluation.gradingMode = mode;
    evaluation.modeReasons = reasons;

    // Identity and raw pricing don't depend on the grading mode, only
    // on the listing showing one card, raw or graded.
    let identifiedCard = null;

    if (checkedPhotos.cardCount === "ONE") {
        const { identity, card } = await identifyCard(listing, checkedPhotos, { lookupCards });

        identifiedCard = card;
        evaluation.identity = identity;

        if (checkedPhotos.holder === "GRADED_SLAB") {
            // A graded card is resold as is: read its slab, then price
            // that exact grader and grade.
            evaluation.slab = checkSlab(checkedPhotos, listing.aspects);

            if (evaluation.slab.status === "OK") {
                evaluation.slabPricing = await slabPricesFor(card, identity, evaluation.slab);
            }
        } else {
            evaluation.rawPricing = rawPricesFor(card, identity);
        }
    }

    if (mode !== "BLOCKED") {
        // Only the clear photos go to the (more expensive) condition step.
        const clearPhotos = checkedPhotos.images.filter(isClearPhoto);
        const photoNumbers = clearPhotos.map((photo) => photo.number);
        const closeUps = hasCloseUps(checkedPhotos);

        if (assessmentStillFits(record.assessment, mode, photoNumbers)) {
            evaluation.reusedSteps.push("condition");
        } else {
            const photos = clearPhotos.map((photo) => ({
                url: photoUrls[photo.number - 1],
                label: photo.view,
            }));

            const answers = await Promise.all(
                Array.from({ length: CONDITION_RUNS }, () =>
                    assessCardCondition(listing, photos, mode)
                )
            );

            for (const answer of answers) {
                evaluation.usage.push({ step: "condition", ...answer.usage });
            }

            // Broken answers are dropped. Of the rest, the more cautious
            // one is kept and the others are set aside for reference.
            const results = answers.map((answer) => answer.result);
            const valid = results.filter(
                (result) => applyConditionRules(result, mode, { closeUps }) !== null
            );

            record.assessment =
                valid.length > 0
                    ? (() => {
                          const kept = valid.reduce((a, b) => moreCautious(a, b));
                          return {
                              mode,
                              photoNumbers,
                              result: kept,
                              setAside: results.filter((result) => result !== kept),
                          };
                      })()
                    : null;

            changed = true;
        }

        const condition = record.assessment
            ? applyConditionRules(record.assessment.result, mode, { closeUps })
            : null;

        if (condition === null) {
            // Don't keep a broken answer: ask again next time.
            record.assessment = null;
            evaluation.gradeStatus = "REJECTED_INVALID_RANGE";
        } else {
            evaluation.gradeStatus = "ESTIMATED";
            evaluation.condition = condition;
            evaluation.setAside = (record.assessment.setAside ?? []).map(summarizeAnswer);

            if (identifiedCard) {
                evaluation.gradedPricing = await gradedPricesByGrader(
                    identifiedCard,
                    evaluation.identity,
                    condition.gradeRange
                );
            }
        }
    }

    if (changed) {
        record.answeredAt = new Date().toISOString();

        if (remember) {
            await saveRecord(listing.id, record);
        }
    }

    evaluation.answeredAt = record.answeredAt;
    evaluation.underwriting = underwrite(evaluation);
    evaluation.rating = rateDeal(evaluation);

    return evaluation;
}
