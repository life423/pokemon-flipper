import { getListingDetails } from "../ebay/listings.ts";
import { fillFromTitle } from "../ai/title-reader.ts";
import {
    ANALYSIS_VERSION,
    CONDITION_VERSION,
    checkListingPhotos,
    assessCardCondition,
    readIdentityPhotos,
} from "../ai/openai.ts";
import {
    photoFingerprint,
    loadSaved,
    saveRecord,
    reusableRecord,
    assessmentStillFits,
    withAssessmentLock,
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
import { identifyCard, readyForPricing } from "../identity/card-identity.ts";
import { rawPricesWithSales } from "../pricing/raw-comps.ts";
import { crossCheckRawPrices } from "../pricing/cross-check.ts";
import { assessSoldCondition } from "../ai/sold-condition.ts";
import { findActiveComparables } from "../pricing/active-comps.ts";
import { lookupCards, fetchComps, fetchRawComps, fetchSalesVolume } from "../pricing/pkmnprices.ts";
import { activityFor } from "../pricing/activity.ts";
import { PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import { checkComps } from "../ai/comp-checker.ts";
import { gradedPricesFor, compsForGrade } from "../pricing/graded-comps.ts";
import { checkSlab } from "../identity/slab-check.ts";
import { GRADERS, underwrite } from "../../shared/money/underwriting.ts";
import { rateDeal } from "../../shared/money/rating.ts";
import { savedPhotoInspection } from "../ai/photo-find.ts";
import { confirmPhotoIdentity } from "../identity/photo-confirmation.ts";
import { verifyShadowless } from "../ai/shadowless-check.ts";
import { photoReviewKey } from "./deeper-review.ts";
import { reconcileIdentityReadings } from "./resolve-evidence.ts";
import { listingEvidenceKey } from "../../shared/listing-evidence.ts";
import { createSingleFlight } from "../lib/single-flight.ts";
import { completeConditionRuns } from "./condition-runs.ts";
import { ProviderError } from "../lib/http.ts";
import { withPricingRecovery } from "../pricing/recover.ts";

// eBay allows 24 photos; the ones past the first few are often the
// close-ups that matter most.
const MAX_PHOTOS = 24;

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
            byGrader[grader] = await withPricingRecovery(() => gradedPricesFor(card, identity, gradeRange, { fetchComps, checkComps, grader }));
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
        return await withPricingRecovery(() => compsForGrade(card, identity, {
            grader,
            grade,
            fetchComps,
            checkComps,
        }));
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
// What changes on a listing between searches, as the page last saw it.
export interface CurrentState {
    title?: string;
    images?: string[];
    price: number | null;
    shipping: number | null;
    bids: number;
    endTime: string | null;
}

interface EvaluationOptions { fresh?: boolean; remember?: boolean; current?: CurrentState | null }
const shareEvaluations = createSingleFlight();

// Identical requests share their entire evaluation. Different snapshots for the
// same item wait, then reuse the first request's saved AI work when it still fits.
export function evaluateListing(itemId: string, options: EvaluationOptions = {}): Promise<Evaluation> {
    const normalized = { fresh: options.fresh ?? false, remember: options.remember ?? true, current: options.fresh ? null : options.current ?? null };
    // The local consistency diagnostic intentionally asks for independent,
    // unsaved readings. HTTP callers cannot set remember=false.
    if (normalized.fresh && !normalized.remember) return evaluateOnce(itemId, normalized);
    return shareEvaluations(JSON.stringify([itemId, normalized]), () => withAssessmentLock(itemId, () => evaluateOnce(itemId, normalized)));
}

async function evaluateOnce(
    itemId: string,
    {
        fresh = false,
        remember = true,
        current = null,
    }: EvaluationOptions = {}
): Promise<Evaluation> {
    // From the page: the saved details plus the price it just searched,
    // so analyzing a listing usually costs no eBay request. Without that
    // (the evaluate script), the details are fetched fresh for the price.
    const details = await getListingDetails(itemId, {
        ...(!current || fresh ? { maxAgeHours: 0 } : {}),
        expectedPhotos: current?.images,
        expectedTitle: current?.title,
    });
    const listing = current
        ? {
              ...details,
              price: current.price ?? details.price,
              shipping: current.shipping ?? details.shipping,
              bids: current.bids,
              endTime: current.endTime ?? details.endTime,
          }
        : details;

    // Set, number, and name read from the title when the seller left them
    // out, the same way the free check reads them.
    listing.aspects = (await fillFromTitle(listing)).aspects;
    const photoUrls = listing.images.slice(0, MAX_PHOTOS);

    const evaluation: Evaluation = {
        conditionVersion: CONDITION_VERSION,
        assessmentVersion: ANALYSIS_VERSION,
        pricingVersion: PRICING_VERSION,
        pricesCheckedAt: new Date().toISOString(),
        listing: {
            id: listing.id,
            title: listing.title,
            url: listing.url,
            availability: listing.availability,
            ...(fresh && details.retrievedAt ? { termsCheckedAt: details.retrievedAt } : {}),
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
            photos: photoUrls,
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

    if (photoUrls.length === 0 || listing.availability === "UNAVAILABLE") {
        evaluation.modeReasons = [listing.availability === "UNAVAILABLE" ? "This listing is no longer available." : "The listing has no photos."];
        evaluation.underwriting = underwrite(evaluation);
        return evaluation;
    }

    const fingerprint = photoFingerprint(photoUrls);

    const saved = fresh
        ? null
        : reusableRecord(await loadSaved(listing.id), {
              version: ANALYSIS_VERSION,
              fingerprint,
              title: listing.title,
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
    record.reviewContext = { title: listing.title, photos: photoUrls };

    if (record.photoCheck) {
        evaluation.reusedSteps.push("photoCheck");
    } else {
        const photoCheck = await checkListingPhotos(listing, photoUrls);
        record.photoCheck = { result: photoCheck.result, usage: photoCheck.usage };
        evaluation.usage.push({ step: "photoCheck", ...photoCheck.usage });
        changed = true;
        record.answeredAt = new Date().toISOString();
        if (remember) await saveRecord(listing.id, record);
    }

    const originalPhotos = applyPhotoCheckRules(record.photoCheck.result, photoUrls.length);
    let checkedPhotos = originalPhotos;
    evaluation.photoCheck = checkedPhotos;

    const { mode, reasons } = getGradingMode(checkedPhotos);
    evaluation.gradingMode = mode;
    evaluation.modeReasons = reasons;

    // Identity and raw pricing don't depend on the grading mode, only
    // on the listing showing one card, raw or graded.
    let identifiedCard = null;

    if (checkedPhotos.cardCount === "ONE") {
        const scan = await savedPhotoInspection(photoUrls[0]);
        let photoIdentity = confirmPhotoIdentity(scan, checkedPhotos);
        let finishConflict = false;
        if (record.identityPasses?.length) {
            const resolved = reconcileIdentityReadings(originalPhotos, record.identityPasses.map(pass => pass.result));
            checkedPhotos = resolved.check;
            finishConflict = resolved.finishConflict;
            photoIdentity = resolved.confirmation ?? photoIdentity;
            evaluation.reusedSteps.push("identityResolution");
        }
        if (photoIdentity?.printing === "SHADOWLESS") {
            const fronts = checkedPhotos.images.filter((image) => image.usable && !image.isStockImage && (image.view === "FRONT" || image.view === "FRONT_DETAIL"));
            if (!await verifyShadowless(fronts.map((image) => photoUrls[image.number - 1]))) photoIdentity.printing = undefined;
        }
        const identify = async () => {
            const result = await identifyCard(listing, checkedPhotos, { lookupCards: query => withPricingRecovery(() => lookupCards(query)), photoIdentity });
            if (finishConflict) result.identity.finish = "CONFLICTING";
            return result;
        };
        let identified = await identify();
        const focusPhotos = checkedPhotos.images.filter(image => !image.isStockImage && image.usable && ["FRONT", "FRONT_DETAIL", ...(checkedPhotos.holder === "GRADED_SLAB" ? ["BACK"] : [])].includes(image.view))
            .slice(0, 4).map(image => photoUrls[image.number - 1]);
        while ((record.identityPasses?.length ?? 0) < 2 && focusPhotos.length && !identified.lookupFailed && !identified.identity.notThisCard) {
            const finishGap = !["HOLO", "REVERSE_HOLO", "NON_HOLO"].includes(identified.identity.finish) && (identified.card?.variants.length ?? 0) > 1;
            const labelGap = checkedPhotos.holder === "GRADED_SLAB" && (!checkedPhotos.slab?.grader || !checkedPhotos.slab.grade || !checkedPhotos.slab.labelText);
            if (readyForPricing(identified.identity) && !finishGap && !labelGap) break;
            try {
                const answer = await readIdentityPhotos(focusPhotos, record.identityPasses?.length ?? 0, {
                    unresolved: [...identified.identity.reasons, ...(finishGap ? ["Select the exact finish only if the photo or readable label supports it."] : []), ...(labelGap ? ["Read missing slab label fields from the actual label."] : [])],
                    possibleFinishes: [...new Set(identified.card?.variants.map(variant => variant.name) ?? [])],
                });
                (record.identityPasses ??= []).push(answer);
                evaluation.usage.push({ step: "identityResolution", ...answer.usage });
                changed = true;
                record.answeredAt = new Date().toISOString();
                if (remember) await saveRecord(listing.id, record);
                const resolved = reconcileIdentityReadings(originalPhotos, record.identityPasses.map(pass => pass.result));
                checkedPhotos = resolved.check;
                finishConflict = resolved.finishConflict;
                photoIdentity = resolved.confirmation;
                if (photoIdentity?.printing === "SHADOWLESS" && !await verifyShadowless(focusPhotos)) photoIdentity.printing = undefined;
                identified = await identify();
            } catch (error) {
                console.error(`Focused identity reading could not finish: ${(error as Error).message}`);
                break;
            }
        }
        evaluation.photoCheck = checkedPhotos;
        const { identity, card } = identified;

        identifiedCard = card;
        evaluation.identity = identity;

        if (checkedPhotos.holder === "GRADED_SLAB") {
            // A graded card is resold as is: read its slab, then price
            // that exact grader and grade.
            evaluation.slab = checkSlab(checkedPhotos, listing.aspects);

            if (evaluation.slab.status === "OK") {
                evaluation.slabPricing = await slabPricesFor(card, identity, evaluation.slab);
                if (evaluation.slabPricing.status !== "PRICED") {
                    const activeReference = await findActiveComparables(identity, evaluation.slab, listing.id);
                    if (activeReference) evaluation.slabPricing = { ...evaluation.slabPricing, status: "PRICED", source: "ebay-active",
                        printing: identity.printing, grader: evaluation.slab.grader!, grade: evaluation.slab.grade!, activeReference };
                }
            }
        }
    }

    if (mode !== "BLOCKED") {
        // Only the clear photos go to the (more expensive) condition step.
        const clearPhotos = checkedPhotos.images.filter(isClearPhoto);
        const photoNumbers = clearPhotos.map((photo) => photo.number);
        const closeUps = hasCloseUps(checkedPhotos);

        if (assessmentStillFits(record.assessment, mode, photoNumbers, CONDITION_VERSION)) {
            evaluation.reusedSteps.push("condition");
        } else {
            const photos = clearPhotos.map((photo) => ({
                url: photoUrls[photo.number - 1],
                label: photo.view,
            }));

            const previous = record.conditionRuns;
            const existing = previous?.version === CONDITION_VERSION && previous.mode === mode && previous.photoNumbers.join(",") === photoNumbers.join(",") ? previous.answers : [];
            const answers = await completeConditionRuns({ existing,
                run: async () => {
                    const answer = await assessCardCondition(listing, photos, mode);
                    evaluation.usage.push({ step: "condition", ...answer.usage });
                    if (!applyConditionRules(answer.result, mode, { closeUps })) throw new ProviderError("The AI condition range was incomplete; the missing assessment will be retried.");
                    return answer;
                },
                checkpoint: async answers => {
                    record.conditionRuns = { version: CONDITION_VERSION, mode, photoNumbers, answers };
                    record.answeredAt = new Date().toISOString();
                    if (remember) await saveRecord(listing.id, record);
                },
            });

            // Broken answers are dropped. Of the rest, the more cautious
            // one is kept and the others are set aside for reference.
            const results = answers.map((answer) => answer.result);
            const valid = results.filter(
                (result) => applyConditionRules(result, mode, { closeUps }) !== null
            );

            record.assessment =
                valid.length > 0
                    ? (() => {
                          const selected = valid.reduce((a, b) => moreCautious(a, b));
                          const kept = structuredClone(selected);
                          if (valid.length < CONDITION_RUNS) { kept.confidence = kept.confidence === "HIGH" ? "MEDIUM" : kept.confidence; kept.limitations.push("One condition assessment completed; the second is unavailable."); }
                          return {
                              version: CONDITION_VERSION,
                              completedRuns: valid.length,
                              mode,
                              photoNumbers,
                              result: kept,
                              setAside: results.filter((result) => result !== selected),
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

    const context = { title: listing.title, photos: photoUrls };
    if (identifiedCard && evaluation.identity && !evaluation.slab) evaluation.rawPricing = await rawPricesWithSales(identifiedCard, evaluation.identity, { fetchRawComps, checkComps, assessCondition: assessSoldCondition });
    if (evaluation.rawPricing && evaluation.identity && evaluation.condition) evaluation.rawPricing = await crossCheckRawPrices(evaluation.rawPricing, evaluation.identity);
    record.reviewContext = context;

    if (changed) {
        record.answeredAt = new Date().toISOString();
    }

    evaluation.answeredAt = record.answeredAt;
    if (remember) evaluation.photoReviewKey = photoReviewKey(record);
    if (record.deeperPhotoReview?.inputKey === evaluation.photoReviewKey) evaluation.deeperPhotoReview = record.deeperPhotoReview;
    if (identifiedCard && evaluation.identity) {
        evaluation.marketActivity = await activityFor(identifiedCard, evaluation.identity, Boolean(evaluation.slab), fetchSalesVolume);
    }
    evaluation.underwriting = underwrite(evaluation);
    evaluation.rating = rateDeal(evaluation);
    if (remember) {
        record.latestEvaluation = { evidenceKey: listingEvidenceKey({ title: current?.title ?? listing.title, images: current?.images ?? photoUrls }), evaluation };
        await saveRecord(listing.id, record);
    }

    return evaluation;
}
