import { getListingDetails } from "../ebay/listings.ts";
import { fillFromTitle } from "../ai/title-reader.ts";
import {
    ANALYSIS_VERSION,
    checkListingPhotos,
    assessCardCondition,
} from "../ai/openai.ts";
import {
    photoFingerprint,
    loadSaved,
    saveRecord,
    reusableRecord,
    assessmentStillFits,
} from "./store.ts";
import {
    applyConditionRules,
    applyPhotoCheckRules,
    getGradingMode,
    hasCloseUps,
    isClearPhoto,
    moreCautious,
    summarizeAnswer,
} from "./rules.ts";
import type { SavedRecord } from "./types.ts";
import type { PricedCard } from "../pricing/types.ts";
import type { Evaluation, Grader, GradeRange, GradedPricing, Identity, Slab, SlabPricing } from "../../shared/types.ts";
import { identifyCard } from "../identity/card-identity.ts";
import { rawPricesFor } from "../pricing/raw-prices.ts";
import { lookupCards, fetchComps } from "../pricing/pkmnprices.ts";
import { gradedPricesFor, compsForGrade } from "../pricing/graded-comps.ts";
import { checkSlab } from "../identity/slab-check.ts";
import { GRADERS, underwrite } from "../../shared/money/underwriting.ts";
import { rateDeal } from "../../shared/money/rating.ts";

// Cost cap: only the first photos, in the seller's order.
const MAX_PHOTOS = 8;

// A first look grades twice and keeps the more cautious answer, so
// one optimistic run can't set the saved answer on its own.
const CONDITION_RUNS = 2;

// Verified sold comps from each grader, for an identified card.
async function gradedPricesByGrader(
    card: PricedCard,
    identity: Identity,
    gradeRange: GradeRange
): Promise<Partial<Record<Grader, GradedPricing>>> {
    const byGrader: Partial<Record<Grader, GradedPricing>> = {};

    for (const grader of GRADERS) {
        try {
            byGrader[grader] = await gradedPricesFor(card, identity, gradeRange, { fetchComps, grader });
        } catch (error) {
            byGrader[grader] = {
                status: "PRICE_UNAVAILABLE",
                reason: `The ${grader} comp lookup failed: ${(error as Error).message}`,
            };
        }
    }

    return byGrader;
}

// Verified sold comps for a slab's exact grader and grade.
async function slabPricesFor(card: PricedCard | null, identity: Identity, slab: Slab): Promise<SlabPricing> {
    const { grader, grade } = slab;

    if (!grader || !grade) {
        return { status: "PRICE_UNAVAILABLE", reason: "The slab's grader and grade couldn't be read." };
    }

    try {
        return await compsForGrade(card, identity, {
            grader,
            grade,
            fetchComps,
        });
    } catch (error) {
        return {
            status: "PRICE_UNAVAILABLE",
            reason: `The ${grader} comp lookup failed: ${(error as Error).message}`,
        };
    }
}

// Grades one listing and prices it. The model's answers are saved per
// listing and reused until the photos, model, or prompts change. The
// code rules, identity, prices, and money math always run fresh.
//   fresh: ignore saved answers and ask the model again.
//   remember: save new answers.
export async function evaluateListing(
    itemId: string,
    { fresh = false, remember = true }: { fresh?: boolean; remember?: boolean } = {}
): Promise<Evaluation> {
    const listing = await getListingDetails(itemId);

    // Set, number, and name read from the title when the seller left them
    // out, the same way the free check reads them.
    listing.aspects = (await fillFromTitle(listing)).aspects;
    const photoUrls = listing.images.slice(0, MAX_PHOTOS);

    const evaluation: Evaluation = {
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

    const record: SavedRecord = saved ?? {
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
            evaluation.setAside = (record.assessment?.setAside ?? []).map(summarizeAnswer);

            if (identifiedCard && evaluation.identity) {
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
