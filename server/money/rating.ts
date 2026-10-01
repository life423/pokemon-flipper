import { sellerCondition } from "../ebay/seller-condition.ts";
import { CONDITION_NAMES, conditionGap, isRawCondition } from "../../shared/conditions.ts";
import { dollars, percent } from "../../shared/format.ts";
import type { CompSummary, Confidence, Evaluation, PricedPath, Rating, RatingLevel } from "../../shared/types.ts";

// How good a deal is, beyond clearing your targets. Plain rules on what
// the analysis found: each concern drops the rating a level. Strong
// with none, Good with one, Thin with two or more.

const LEVELS: RatingLevel[] = ["STRONG", "GOOD", "THIN"];
const CONFIDENCE_ORDER: Confidence[] = ["NONE", "LOW", "MEDIUM", "HIGH"];

// A fixed price should sit at least this far under the max bid.
const MIN_ROOM = 0.15;

// Sellers below either of these are a concern.
const MIN_FEEDBACK_SCORE = 25;
const MIN_FEEDBACK_PERCENT = 98;

type RatingInput = Pick<
    Evaluation,
    "listing" | "underwriting" | "condition" | "gradingMode" | "gradedPricing" | "slabPricing"
>;

// The sold comps behind the winning path's prices. Grades priced from a
// lower grade's sales are left out: they add no sales of their own.
function compsBehind(evaluation: RatingInput, best: PricedPath): CompSummary[] {
    if (best.path === "GRADED_RESALE") {
        return evaluation.slabPricing?.summary ? [evaluation.slabPricing.summary] : [];
    }

    if (best.path === "GRADE" && best.grader) {
        const grades = (best.outlook ?? []).filter((o) => o.filledFrom === null).map((o) => o.grade);
        const byGrade = evaluation.gradedPricing?.[best.grader]?.byGrade ?? [];

        return byGrade.filter((summary) => grades.includes(Number(summary.grade)));
    }

    return [];
}

export function rateDeal(evaluation: RatingInput): Rating | null {
    const underwriting = evaluation.underwriting;

    if (!underwriting?.verdict.startsWith("BUY") || !underwriting.best) return null;

    const { best } = underwriting;
    const { listing } = evaluation;
    const strengths: string[] = [];
    const concerns: string[] = [];
    const notes: string[] = [];
    const auction = listing.buyingOption === "AUCTION";
    let room: number | null = null;

    if (auction) {
        // The current bid will rise, so room under the max bid means little.
        notes.push("It's an auction, so the price can still rise. The max bid is the most to pay.");
    } else if (listing.price !== null && best.maxBid > 0) {
        room = (best.maxBid - listing.price) / best.maxBid;

        if (room >= MIN_ROOM) {
            strengths.push(`The price is ${percent(room)} under the max bid.`);
        } else {
            concerns.push(`The price is only ${percent(room)} under the max bid.`);
        }
    }

    if (best.path !== "RAW") {
        const lowEnd = best.path === "GRADE" ? "at the low end of the grade range" : "at the lowest recent sale";

        if (best.downside >= 0) {
            strengths.push(`Still profitable ${lowEnd}.`);
        } else {
            concerns.push(`Loses ${dollars(-best.downside)} ${lowEnd}.`);
        }
    }

    const comps = compsBehind(evaluation, best);

    if (comps.length > 0) {
        const rank = (summary: CompSummary) => CONFIDENCE_ORDER.indexOf(summary.confidence);
        const weakest = comps.reduce((a, b) => (rank(b) < rank(a) ? b : a));

        if (weakest.confidence === "HIGH") {
            strengths.push("Every price behind it rests on 5 or more recent verified sales.");
        } else if (weakest.confidence !== "MEDIUM") {
            const sales = weakest.count === 1 ? "sale" : "sales";
            concerns.push(`Only ${weakest.count} verified ${weakest.grader} ${weakest.grade} ${sales} behind the price.`);
        }
    }

    // A raw card: how sure the photos are, and whether the seller oversold it.
    const condition = evaluation.condition;

    if (best.path !== "GRADED_RESALE" && condition) {
        if (condition.confidence === "HIGH") {
            strengths.push("The condition read from the photos is high confidence.");
        } else if (condition.confidence === "LOW") {
            concerns.push("The condition read from the photos is low confidence.");
        }

        if (evaluation.gradingMode === "LIMITED") {
            concerns.push("There are no close-up photos, so the condition read is limited.");
        }

        if (listing.cardCondition && isRawCondition(condition.rawCondition)) {
            const claimed = sellerCondition(listing.cardCondition);

            if (conditionGap(claimed, condition.rawCondition) >= 2) {
                concerns.push(
                    `The seller calls it ${CONDITION_NAMES[claimed]}, but the photos look ${CONDITION_NAMES[condition.rawCondition]}.`
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

    return {
        level: LEVELS[Math.min(concerns.length, LEVELS.length - 1)],
        room: room === null ? null : Math.round(room * 1000) / 1000,
        strengths,
        concerns,
        notes,
    };
}
