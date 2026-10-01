import { sellerCondition } from "../deals/prescreen.js";

// How good a deal is, beyond clearing your targets. Plain rules on what
// the analysis found: each concern drops the rating a level. Strong
// with none, Good with one, Thin with two or more.

const LEVELS = ["STRONG", "GOOD", "THIN"];
const CONFIDENCE_ORDER = ["NONE", "LOW", "MEDIUM", "HIGH"];
const CONDITION_ORDER = ["NEAR_MINT", "LIGHTLY_PLAYED", "MODERATELY_PLAYED", "HEAVILY_PLAYED", "DAMAGED"];
const CONDITION_NAMES = {
    NEAR_MINT: "Near Mint",
    LIGHTLY_PLAYED: "Lightly Played",
    MODERATELY_PLAYED: "Moderately Played",
    HEAVILY_PLAYED: "Heavily Played",
    DAMAGED: "Damaged",
};

// The price should sit at least this far under the max bid.
const MIN_ROOM = 0.15;

// Sellers below either of these are a concern.
const MIN_FEEDBACK_SCORE = 25;
const MIN_FEEDBACK_PERCENT = 98;

const percent = (value) => `${Math.round(value * 100)}%`;
const dollars = (value) => `$${Math.abs(value).toFixed(2)}`;

// The sold comps behind the winning path's prices. Grades priced from a
// lower grade's sales are left out: they add no sales of their own.
function compsBehind(evaluation, best) {
    if (best.path === "GRADED_RESALE") {
        return evaluation.slabPricing?.summary ? [evaluation.slabPricing.summary] : [];
    }

    if (best.path === "GRADE") {
        const grades = (best.outlook ?? []).filter((o) => o.filledFrom === null).map((o) => o.grade);
        const byGrade = evaluation.gradedPricing?.[best.grader]?.byGrade ?? [];

        return byGrade.filter((summary) => grades.includes(Number(summary.grade)));
    }

    return [];
}

export function rateDeal(evaluation) {
    const underwriting = evaluation.underwriting;

    if (!underwriting?.verdict?.startsWith("BUY") || !underwriting.best) return null;

    const { best } = underwriting;
    const { listing } = evaluation;
    const strengths = [];
    const concerns = [];
    const notes = [];

    const room = best.maxBid > 0 ? (best.maxBid - listing.price) / best.maxBid : 0;

    if (room >= MIN_ROOM) {
        strengths.push(`The price is ${percent(room)} under the max bid.`);
    } else {
        concerns.push(`The price is only ${percent(room)} under the max bid.`);
    }

    if (best.path !== "RAW") {
        const lowEnd = best.path === "GRADE" ? "at the low end of the grade range" : "at the lowest recent sale";

        if (best.downside >= 0) {
            strengths.push(`Still profitable ${lowEnd}.`);
        } else {
            concerns.push(`Loses ${dollars(best.downside)} ${lowEnd}.`);
        }
    }

    const comps = compsBehind(evaluation, best);

    if (comps.length > 0) {
        const weakest = comps.reduce((a, b) =>
            CONFIDENCE_ORDER.indexOf(b.confidence) < CONFIDENCE_ORDER.indexOf(a.confidence) ? b : a
        );

        if (weakest.confidence === "HIGH") {
            strengths.push("Every price behind it rests on 5 or more recent verified sales.");
        } else if (weakest.confidence !== "MEDIUM") {
            const sales = weakest.count === 1 ? "sale" : "sales";
            concerns.push(`Only ${weakest.count} verified ${weakest.grader} ${weakest.grade} ${sales} behind the price.`);
        }
    }

    // A raw card: how sure the photos are, and whether the seller oversold it.
    if (best.path !== "GRADED_RESALE" && evaluation.condition) {
        if (evaluation.condition.confidence === "HIGH") {
            strengths.push("The condition read from the photos is high confidence.");
        } else if (evaluation.condition.confidence === "LOW") {
            concerns.push("The condition read from the photos is low confidence.");
        }

        if (evaluation.gradingMode === "LIMITED") {
            concerns.push("There are no close-up photos, so the condition read is limited.");
        }

        if (listing.cardCondition) {
            const claimed = sellerCondition(listing.cardCondition);
            const seen = evaluation.condition.rawCondition;
            const gap = CONDITION_ORDER.indexOf(seen) - CONDITION_ORDER.indexOf(claimed);

            if (CONDITION_ORDER.includes(seen) && gap >= 2) {
                concerns.push(
                    `The seller calls it ${CONDITION_NAMES[claimed]}, but the photos look ${CONDITION_NAMES[seen]}.`
                );
            }
        }
    }

    const seller = listing.seller;

    if (seller && typeof seller.feedbackScore === "number") {
        const feedbackPercent = seller.feedbackPercentage ?? 0;

        if (seller.feedbackScore < MIN_FEEDBACK_SCORE || feedbackPercent < MIN_FEEDBACK_PERCENT) {
            concerns.push(`The seller has ${seller.feedbackScore} feedback at ${feedbackPercent}% positive.`);
        }
    }

    if (listing.buyingOption === "AUCTION") {
        notes.push("It's an auction, so the price can still rise. The max bid is the most to pay.");
    }

    return {
        level: LEVELS[Math.min(concerns.length, LEVELS.length - 1)],
        room: Math.round(room * 1000) / 1000,
        strengths,
        concerns,
        notes,
    };
}
