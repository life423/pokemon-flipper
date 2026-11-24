import { invalidReading, validateBoundedReading } from "./bounded-reading.ts";
export { validateBoundedReading } from "./bounded-reading.ts";
import { getListingDetails } from "../ebay/listings.ts";
import { ANALYSIS_VERSION, CONDITION_VERSION } from "./legacy-evidence.ts";
import { assessBoundedListing, type BoundedReading, type BoundedPhotoStage } from "../ai/bounded-assessment.ts";
import { compatibleBoundedPlans, stagedPhotoPlan, type BoundedAssessmentPlan } from "./bounded-plan.ts";
export { assessBoundedListing, BOUNDED_ASSESSMENT_SCHEMA, type BoundedReading } from "../ai/bounded-assessment.ts";
export { BOUNDED_VISION_MODEL, BOUNDED_ASSESSMENT_VERSION, BOUNDED_CONDITION_VERSION, BOUNDED_SLAB_ASSESSMENT_VERSION, BOUNDED_PHOTO_LIMIT, selectBoundedPhotos, boundedAssessmentKey, boundedAssessmentPlan } from "./bounded-plan.ts";
import { cachedCompChecks } from "../ai/comp-checker.ts";
import { missingTextureReason } from "../../shared/grade-qualifier.ts";
import { createSoldConditionAcquirer } from "../ai/sold-condition.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { storageFailure } from "../lib/storage-failure.ts";
import { StorageUnavailableError } from "../storage/index.ts";
import { AiSearchAllowanceError, aiSpendingFailure } from "../ai/spending.ts";
import { corroboratedSlabName, frontShowsDifferentNumber, identifyCard, normalizeWords, photoReprintIssue, readyForPricing, printingClaimFromAspects, sameCardNumber, sameSetFamily, structuredPhotoIdentityConflict, type IdentityListing } from "../identity/card-identity.ts";
import { checkSlab, normalizeSlabReading } from "../identity/slab-check.ts";
import { readTitleByRules } from "../ai/title-reader.ts";
import { lookupCards, fetchComps, fetchRawComps } from "../pricing/pkmnprices.ts";
import { gradedPricesFor, compsForGrade } from "../pricing/graded-comps.ts";
import { rawPricesWithSales, compCondition } from "../pricing/raw-comps.ts";
import { matchesSoldTarget } from "../pricing/sold-comps.ts";
import type { Comp, PricedCard } from "../pricing/types.ts";
import { loadSaved, reusableRecord, photoFingerprint } from "./store.ts";
import { applyPhotoCheckRules, applyConditionRules, getGradingMode, hasCloseUps } from "./rules.ts";
import { underwrite, frontRawResaleLoss, frontSlabLoss, frontWearGradeLoses, materialFrontWear, FRONT_WEAR_GRADE_REFERENCE, GRADERS, netFromSale, pathNumbers } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { rateDeal } from "../../shared/money/rating.ts";
import { cardLanguageStatus, EnglishOnlyError } from "../../shared/card-language.ts";
import { listingEvidenceKey } from "../../shared/listing-evidence.ts";
import { BOUNDED_REVIEW_REVISION, currentPriceEvidence, PREVIOUS_BOUNDED_REVIEW_REVISION, PREVIOUS_PRICING_VERSION, PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import { unsupportedVariantReason, withoutUnsupportedRawPrices, withoutUnsupportedVariantPrices } from "../../shared/money/price-evidence.ts";
import { minimumOfferPrice } from "../../shared/money/cents.ts";
import { isRawCondition, RAW_CONDITIONS, sellerCreaseOverridesCondition } from "../../shared/conditions.ts";
import { withinAutomaticAuctionWindow, type ListingFilters } from "../../shared/listing-filters.ts";
import { obscuredDisclosedWear, withoutRawSlabAssessment } from "../../shared/photo-evidence.ts";
import type { Evaluation, Targets } from "../../shared/types.ts";
import type { Usage } from "./types.ts";
import { createPrivateEvaluationStore, evaluationContextKey } from "./private-evaluation.ts";
import { photoReviewKey, restoreBoundedPhotoReview } from "./deeper-review.ts";
import { isSearchDiagnosticId } from "./search-diagnostic-store.ts";
import { findStampDecision, hasFreshStampTerms, stampCandidate, STAMP_TERMS_MAX_AGE_MS } from "./stamp-decision.ts";
import { readStampCrop } from "./stamp-reading.ts";
import { printingMarkConflicts, reconcileIdentityReadings, visibleReprintReading } from "./resolve-evidence.ts";
import { assertPriceResearchAvailable, PriceResearchBudgetError, withPriceResearchSignal } from "../pricing/research-budget.ts";
import { getAiUsageContext, withAiUsageContext, type AiUsageContext } from "../ai/usage-context.ts";

const CACHE_HOURS = 24 * 365 * 10;
interface SavedBoundedReading extends BoundedReading { version: string; answeredAt: string; usage: Usage }
export interface BoundedOptions { automatic?: boolean; typeFilter?: ListingFilters["typeFilter"]; includeOffers?: boolean; targets?: Targets; signal?: AbortSignal; current?: import("./types.ts").CurrentState | null; priceOnly?: boolean }
export class PriceOnlyEvidenceError extends Error {}

interface Dependencies {
    details: typeof getListingDetails; saved: typeof loadSaved; cached: typeof readCache; save: typeof writeCache;
    assess: typeof assessBoundedListing; identify: typeof identifyCard; lookup: typeof lookupCards; fetchComps: typeof fetchComps; fetchRawComps: typeof fetchRawComps;
    compChecks: typeof cachedCompChecks; now: () => number; assertPriceAvailable: typeof assertPriceResearchAvailable;
    soldCondition: typeof createSoldConditionAcquirer;
    stamp: typeof readStampCrop;
}
function stopFailure(error: unknown) { return aiSpendingFailure(error) ?? storageFailure(error); }
class CandidateOutsideWindow extends Error {}

function readableFrontSlab(check: BoundedReading["photoCheck"]) {
    const [front] = check.images;
    if (check.holder !== "GRADED_SLAB" || check.cardCount !== "ONE" || front?.view !== "FRONT" || !front.usable || front.isStockImage) return null;
    const slab = normalizeSlabReading(check.slab);
    return slab?.present && slab.grader && slab.grade ? slab : null;
}

function combinePhotoReadings(front: BoundedReading, rest: BoundedReading): BoundedReading {
    const result = structuredClone(rest);
    const first = front.photoCheck, check = result.photoCheck;
    check.images = [...first.images, ...check.images.map(photo => ({ ...photo, number: photo.number + 1 }))];
    const primary = first.images[0];
    // A group shot may be categorized as OTHER. A later close-up still
    // cannot undo the evidence of multiple cards in that shot.
    if (first.cardCount === "MULTIPLE" && primary.usable && !primary.isStockImage) check.cardCount = "MULTIPLE";
    if (primary.view !== "FRONT" || !primary.usable || primary.isStockImage) {
        if (result.condition?.authenticity.observations) result.condition.authenticity.observations =
            result.condition.authenticity.observations.map(item => ({ ...item, photoNumber: item.photoNumber + 1 }));
        return result;
    }
    if (first.cardCount === "ONE" && check.cardCount === "UNKNOWN") check.cardCount = "ONE";
    const acceptedSlab = readableFrontSlab(first);
    if (acceptedSlab && check.holder !== "GRADED_SLAB") {
        if (["NONE", "SLEEVE", "TOPLOADER"].includes(check.holder) && rest.photoCheck.images.some(photo => photo.view === "FRONT" && photo.usable && !photo.isStockImage)) {
            acceptedSlab.holderConflict = true;
        }
        check.holder = "GRADED_SLAB";
        check.slab = acceptedSlab;
    }
    if (check.holder === "UNKNOWN") check.holder = first.holder;
    const priorSlab = normalizeSlabReading(first.slab);
    if (check.holder === "GRADED_SLAB" && priorSlab?.present) {
        const slab = normalizeSlabReading(check.slab);
        if (!slab) check.slab = priorSlab;
        else {
            for (const field of ["grader", "grade"] as const) {
                if (!slab[field]) slab[field] = priorSlab[field];
                else if (priorSlab[field] && slab[field] !== priorSlab[field]) {
                    slab[field] = null;
                    slab.concerns.push(`Photo readings disagree on slab ${field}.`);
                }
            }
            slab.labelText ??= priorSlab.labelText;
            slab.certNumber ??= priorSlab.certNumber;
            slab.gradeQualifier ??= priorSlab.gradeQualifier ?? null;
            if (priorSlab.caseCondition === "CRACKED" || slab.caseCondition === "NOT_VISIBLE" || priorSlab.caseCondition === "SCRATCHED" && slab.caseCondition === "INTACT") slab.caseCondition = priorSlab.caseCondition;
            slab.concerns = [...new Set([...priorSlab.concerns, ...slab.concerns])];
            if (priorSlab.authenticity !== "NONE_SEEN" && slab.authenticity !== "LIKELY_FAKE") {
                slab.authenticity = priorSlab.authenticity;
                slab.authenticityEvidence = [...(priorSlab.authenticityEvidence ?? []), ...(slab.authenticityEvidence ?? [])];
            }
            check.slab = slab;
        }
    }
    const marks = check.printingMarks, frontMarks = first.printingMarks;
    const markReadings = [frontMarks, marks];
    const markConflicts = printingMarkConflicts(markReadings);
    if (marks && markConflicts.includes("reprintMark")) {
        marks.conflicts = [...new Set([...(marks.conflicts ?? []), "reprintMark" as const])];
    }
    const reprint = visibleReprintReading(markReadings);
    if (marks && reprint) marks.reprintMark = reprint;
    const prior = first.cardIdentity, card = check.cardIdentity;
    if (prior?.confidence === "HIGH" && check.cardMatch?.verdict !== "MISMATCH") {
        if (!card) check.cardIdentity = prior;
        else {
            const conflict = (prior.name && card.name && normalizeWords(prior.name) !== normalizeWords(card.name)) ||
                (prior.set && card.set && !sameSetFamily(prior.set, card.set)) ||
                (prior.cardNumber && card.cardNumber && !sameCardNumber(prior.cardNumber, card.cardNumber)) ||
                (prior.finish !== "UNKNOWN" && card.finish !== "UNKNOWN" && prior.finish !== card.finish);
            if (conflict) {
                card.confidence = "LOW";
                check.problems.push("The front and remaining views disagree about the card identity or finish.");
            } else {
                card.name ??= prior.name; card.set ??= prior.set; card.cardNumber ??= prior.cardNumber; card.language ??= prior.language;
                if (card.finish === "UNKNOWN") card.finish = prior.finish;
                card.confidence = prior.confidence;
                card.evidence = [...new Set([...prior.evidence, ...card.evidence])];
            }
        }
        if (marks && frontMarks) {
            if (markConflicts.length) marks.conflicts = markConflicts;
            for (const field of ["firstEditionStamp", "artBoxShadow"] as const) {
                if (marks[field] === "CANT_TELL") marks[field] = frontMarks[field];
            }
            if (!reprint && frontMarks.reprintMark && !["NONE_SEEN", "CANT_TELL"].includes(frontMarks.reprintMark)) marks.reprintMark = frontMarks.reprintMark;
            marks.evidence = [...new Set([...(frontMarks.evidence ?? []), ...(marks.evidence ?? [])])];
        }
    }
    if (check.holder === "GRADED_SLAB") result.condition = null;
    if (result.condition?.authenticity.observations) {
        const authenticity = result.condition.authenticity;
        const firstAlerts = front.condition?.authenticity.observations?.filter(item => item.judgment === "SUSPICIOUS") ?? [];
        authenticity.observations = [...firstAlerts, ...authenticity.observations!.map(item => ({ ...item, photoNumber: item.photoNumber + 1 }))];
        if (firstAlerts.length && authenticity.concern === "NONE_SEEN") authenticity.concern = "POSSIBLE";
    }
    const priorCondition = front.condition;
    const wear = materialFrontWear(priorCondition);
    if (priorCondition && wear && !primary.obscuresCondition && check.holder !== "GRADED_SLAB") {
        result.condition ??= structuredClone(priorCondition);
        if (!isRawCondition(result.condition.rawCondition) || RAW_CONDITIONS.indexOf(result.condition.rawCondition) < RAW_CONDITIONS.indexOf(wear)) {
            result.condition.gradeRange = null;
            result.condition.rawCondition = wear;
        }
        if (priorCondition.creases === "PRESENT") result.condition.creases = "PRESENT";
        if (priorCondition.surface.severity === "SEVERE") result.condition.surface = structuredClone(priorCondition.surface);
    }
    return result;
}


function stampNote(stamp: NonNullable<Evaluation["focusedStamp"]>): string {
    return stamp.result === "CANT_TELL" ? `The focused check of photo ${stamp.photoNumber} could not read the First Edition stamp area.`
        : `Focused check of photo ${stamp.photoNumber}: First Edition stamp ${stamp.result === "VISIBLE" ? "visible" : "absent"}.`;
}

// Reapply deterministic label rules to paid evidence rather than purchasing
// the photos again when a seller-metadata policy changes.
function recheckSavedEvidence(evaluation: Evaluation, listing: IdentityListing): { evaluation: Evaluation; needsPricing: boolean } {
    const revised = withoutRawSlabAssessment(structuredClone(evaluation));
    const identity = revised.identity;
    const reprint = identity?.set ? photoReprintIssue(revised.photoCheck?.printingMarks, identity.set) : null;
    if (identity && reprint) {
        identity.status = "NEEDS_REVIEW";
        if (reprint.notThisCard) identity.notThisCard = reprint.notThisCard;
        if (!identity.reasons.includes(reprint.reason)) identity.reasons.push(reprint.reason);
        revised.rawPricing = null;
        revised.gradedPricing = null;
        revised.slabPricing = null;
        return { evaluation: revised, needsPricing: false };
    }
    if (revised.identity?.status === "IDENTIFIED" && structuredPhotoIdentityConflict(revised.photoCheck, revised.identity)) {
        return { evaluation: revised, needsPricing: true };
    }
    if (revised.photoCheck?.holder !== "GRADED_SLAB") return { evaluation: revised, needsPricing: false };
    const previousStatus = revised.slab?.status;
    revised.slab = checkSlab(revised.photoCheck, listing.aspects);
    const pricing = revised.slabPricing;
    const priced = pricing?.status === "PRICED" && pricing.grader === revised.slab.grader && pricing.grade === revised.slab.grade;
    const retryName = revised.identity?.status === "NEEDS_REVIEW" && corroboratedSlabName(listing, revised.photoCheck, readTitleByRules);
    return { evaluation: revised, needsPricing: revised.slab.status === "OK" && !priced && (previousStatus !== "OK" || Boolean(retryName)) };
}

export function createBoundedEvaluator(overrides: Partial<Dependencies> = {}) {
    const deps: Dependencies = { details: getListingDetails, saved: loadSaved, cached: readCache, save: writeCache, assess: assessBoundedListing, identify: identifyCard,
        lookup: lookupCards, fetchComps, fetchRawComps, compChecks: cachedCompChecks, now: Date.now, assertPriceAvailable: assertPriceResearchAvailable,
        soldCondition: createSoldConditionAcquirer, stamp: readStampCrop, ...overrides };
    const share = createSharedWork();
    const shareReading = createSharedWork();
    type ReadingConsumer = { needed: () => boolean; context: AiUsageContext };
    const neededReadings = new Map<string, Set<ReadingConsumer>>();
    const privateEvaluations = createPrivateEvaluationStore({ cached: deps.cached, save: deps.save });
    return (itemId: string, options: BoundedOptions = {}): Promise<Evaluation> => share(JSON.stringify([getAiUsageContext().searchId ?? null, itemId, options.current ?? null, options.automatic ?? false, options.typeFilter ?? "all", options.includeOffers !== false, options.targets ?? null, options.priceOnly === true]), signal => withPriceResearchSignal(signal, async () => {
        signal.throwIfAborted();
        const searchId = getAiUsageContext().searchId;
        const savedForRefresh = options.priceOnly ? await privateEvaluations.load(itemId) : null;
        if (options.priceOnly && (!savedForRefresh?.evaluation.photoCheck || !isSearchDiagnosticId(searchId) ||
            savedForRefresh.searchId && savedForRefresh.searchId !== searchId)) {
            throw new PriceOnlyEvidenceError("A saved photo assessment and its original search are required to refresh prices.");
        }
        const current = options.priceOnly ? null : options.current;
        const details = await deps.details(itemId, { ...(!current ? { maxAgeHours: 0 } : {}), expectedPhotos: current?.images, expectedTitle: current?.title, signal });
        signal.throwIfAborted();
        const currentTime = Date.parse(current?.termsCheckedAt ?? "");
        const detailTime = Date.parse(details.retrievedAt ?? "");
        const newerSnapshot = Number.isFinite(currentTime) && currentTime <= deps.now() &&
            (!Number.isFinite(detailTime) || currentTime > detailTime);
        const legacySnapshot = !Number.isFinite(currentTime) && !Number.isFinite(detailTime);
        const listing = current && (newerSnapshot || legacySnapshot) ? {
            ...details,
            retrievedAt: newerSnapshot ? current.termsCheckedAt : details.retrievedAt,
            price: newerSnapshot ? current.price : current.price ?? details.price,
            shipping: newerSnapshot ? current.shipping : current.shipping ?? details.shipping,
            bids: current.bids,
            endTime: newerSnapshot ? current.endTime : current.endTime ?? details.endTime,
            buyingOption: current.buyingOption ?? details.buyingOption,
            bestOffer: current.bestOffer ?? details.bestOffer,
        } : details;
        if (cardLanguageStatus(listing.title, [listing.aspects.Language]) === "OTHER") throw new EnglishOnlyError();
        const plans = compatibleBoundedPlans(listing), requestedPlan = plans[0];
        const ended = listing.availability === "UNAVAILABLE" || listing.endTime && Date.parse(listing.endTime) <= deps.now();
        if (savedForRefresh && !ended && (!listing.images.length ||
            listingEvidenceKey({ title: listing.title, images: listing.images }) !==
            listingEvidenceKey({ title: savedForRefresh.evaluation.listing.title, images: savedForRefresh.evaluation.listing.photos ?? [] }))) {
            throw new PriceOnlyEvidenceError("The listing title or photos changed. A new assessment is required before repricing.");
        }
        const evaluation: Evaluation = { assessmentVersion: requestedPlan.version, conditionVersion: requestedPlan.conditionVersion, pricingVersion: PRICING_VERSION,
            listing: { id: listing.id, title: listing.title, url: listing.url, listedAt: listing.listedAt, createdAt: listing.createdAt,
                availability: ended ? "UNAVAILABLE" : listing.availability, termsCheckedAt: listing.retrievedAt, bestOffer: listing.bestOffer,
                price: listing.price, shipping: listing.shipping, buyingOption: listing.buyingOption, bids: listing.bids, endTime: listing.endTime,
                photos: listing.images, photosInListing: listing.images.length, photosAnalyzed: 0, cardCondition: listing.cardCondition, conditionNotes: listing.conditionNotes,
                seller: listing.seller, sellerCondition: listing.condition, aspects: listing.aspects },
            photoCheck: null, condition: null, gradingMode: "BLOCKED", modeReasons: [], gradeStatus: "SKIPPED", setAside: [], identity: null,
            rawPricing: null, gradedPricing: null, slab: null, slabPricing: null, underwriting: null, rating: null, answeredAt: null, reusedSteps: [], usage: [] };
        const privateContext = { evidenceKey: listingEvidenceKey({ title: current?.title ?? listing.title, images: current?.images ?? listing.images }),
            contextKey: evaluationContextKey(listing), searchId: isSearchDiagnosticId(searchId) ? searchId : undefined };
        const printingClaim = printingClaimFromAspects(listing.aspects);
        // Legacy checkpoints and older private hashes did not include these
        // item specifics. Re-run identity with accepted photos when they change.
        const matchesPrintingClaim = (saved: Evaluation) => printingClaimFromAspects(saved.listing.aspects) === printingClaim;
        const money = { ...MONEY_CONFIG, targets: options.targets ?? MONEY_CONFIG.targets };
        const verifiedFixedPriceTerms = (shipping = listing.shipping) => details.price === listing.price && details.shipping === listing.shipping &&
            details.buyingOption === listing.buyingOption && details.endTime === listing.endTime &&
            hasFreshStampTerms({ ...evaluation.listing, shipping, termsCheckedAt: details.retrievedAt }, deps.now());
        const verifiedOfferPrice = () => options.includeOffers !== false && listing.bestOffer === true && details.bestOffer === true &&
            verifiedFixedPriceTerms(listing.shipping ?? 0) && listing.price !== null
            ? minimumOfferPrice(listing.price) : null;
        const canReuseRawResearch = (saved: Evaluation) => {
            const deferred = saved.rawPricing?.soldPhotoDeferred;
            return !deferred || ((verifiedOfferPrice() ?? listing.price ?? Infinity) >= deferred.price &&
                (listing.shipping ?? MONEY_CONFIG.buying.assumedShippingWhenUnknown) >= deferred.shipping &&
                money.targets.minProfit >= deferred.targets.minProfit && money.targets.minRoi >= deferred.targets.minRoi);
        };
        let legacyReview: Pick<Evaluation, "answeredAt" | "photoReviewKey" | "deeperPhotoReview"> | undefined;
        let priorSnapshot = savedForRefresh;
        const publish = async (draft: Evaluation) => {
            if (!draft.deeperPhotoReview && legacyReview && draft.assessmentVersion === ANALYSIS_VERSION && draft.answeredAt === legacyReview.answeredAt) {
                draft.photoReviewKey = legacyReview.photoReviewKey;
                draft.deeperPhotoReview = legacyReview.deeperPhotoReview;
            }
            const prior = priorSnapshot?.evaluation;
            const sameAssessment = priorSnapshot?.contextKey === privateContext.contextKey &&
                prior?.assessmentVersion === draft.assessmentVersion && prior?.answeredAt === draft.answeredAt;
            const scope = (options.priceOnly || sameAssessment) ? priorSnapshot?.searchId ?? privateContext.searchId : privateContext.searchId;
            const result = await restoreBoundedPhotoReview(draft, scope, deps.cached);
            result.underwriting = underwrite(result); result.rating = rateDeal(result);
            if (result.photoCheck) await privateEvaluations.save(result, { ...privateContext, searchId: scope });
            return result;
        };
        const finish = () => publish(withoutUnsupportedVariantPrices(withoutRawSlabAssessment(evaluation)));
        if (ended || !listing.images.length) { evaluation.modeReasons = [ended ? "This listing is no longer available." : "The listing has no photos."]; return finish(); }
        if (options.automatic && options.typeFilter && options.typeFilter !== "all" && listing.buyingOption !== options.typeFilter) {
            evaluation.modeReasons = [options.typeFilter === "FIXED_PRICE"
                ? "eBay reports an auction for this listing. This search is limited to Buy It Now."
                : "eBay reports a Buy It Now listing. This search is limited to auctions."];
            evaluation.gradeStatus = "SKIPPED_LISTING_FORMAT";
            return finish();
        }
        const textureError = missingTextureReason(listing.title);
        if (options.automatic && textureError) { evaluation.modeReasons = [textureError]; return finish(); }
        const eligibleNow = () => !signal.aborted && (!listing.endTime || Date.parse(listing.endTime) > deps.now()) &&
            (!options.automatic || withinAutomaticAuctionWindow(listing, deps.now()));
        const deferWindow = () => { evaluation.modeReasons = ["Automatic auction analysis is limited to live auctions ending within the next 12 hours."]; evaluation.gradeStatus = "DEFERRED_AUCTION_WINDOW"; return finish(); };
        if (!eligibleNow()) return deferWindow();
        const legacy = reusableRecord(await deps.saved(itemId), { version: ANALYSIS_VERSION, fingerprint: photoFingerprint(listing.images.slice(0, 24)), title: listing.title });
        if (legacy?.deeperPhotoReview && legacy.deeperPhotoReview.inputKey === photoReviewKey(legacy)) {
            legacyReview = { answeredAt: legacy.answeredAt, photoReviewKey: legacy.deeperPhotoReview.inputKey, deeperPhotoReview: legacy.deeperPhotoReview };
        }
        const legacyCondition = legacy?.assessment?.version === CONDITION_VERSION ? legacy.assessment.result : null;
        const canReuseLegacy = Boolean(legacy?.photoCheck && (legacy.photoCheck.result.holder === "GRADED_SLAB" || legacyCondition));
        const legacyPrintingConflicts = canReuseLegacy && legacy?.identityPasses?.length
            ? printingMarkConflicts([legacy.photoCheck?.result.printingMarks, ...legacy.identityPasses.map(pass => pass.result.printingMarks)]) : [];
        const hasSavedPrintingConflicts = (saved: Evaluation) => legacyPrintingConflicts.every(field => saved.photoCheck?.printingMarks?.conflicts?.includes(field));
        type SharedAnswer = { reading: BoundedReading; answeredAt: string; cached: boolean; plan: BoundedAssessmentPlan; usage?: Usage };
        let checkedShared: SharedAnswer | null | undefined;
        let correctedShared: SharedAnswer | null = null;
        const readShared = async (): Promise<SharedAnswer | null> => {
            if (checkedShared === undefined) {
                const answers: SharedAnswer[] = [];
                for (const plan of plans) {
                    const stored = await deps.cached<SavedBoundedReading>(plan.key, CACHE_HOURS);
                    if (stored === null) continue;
                    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return invalidReading();
                    const timestamp = Date.parse(stored.answeredAt);
                    if (stored.version !== plan.version || typeof stored.answeredAt !== "string" ||
                        !Number.isFinite(timestamp) || timestamp > deps.now()) return invalidReading();
                    const reading = validateBoundedReading(stored, plan.photos.length, plan.mode);
                    // A real certified slab needs no raw grading, even if the
                    // seller changes its category. A compact answer showing
                    // raw/unknown cannot substitute for a condition assessment.
                    if (requestedPlan.mode === "RAW" && plan.mode === "SLAB_LABEL" &&
                        (reading.photoCheck.holder !== "GRADED_SLAB" || !reading.photoCheck.slab?.present)) continue;
                    answers.push({ reading, answeredAt: stored.answeredAt, cached: true, plan });
                }
                // Corrections retain their source selector and version. With
                // equal timestamps prefer broader already-paid photo coverage.
                checkedShared = answers.sort((a, b) => Date.parse(b.answeredAt) - Date.parse(a.answeredAt) || b.plan.photos.length - a.plan.photos.length)[0] ?? null;
            }
            return checkedShared;
        };
        const hasNewerSharedReading = async (candidate: Evaluation): Promise<boolean> => {
            // Stronger legacy full assessments keep their existing preference.
            if (!plans.some(plan => plan.version === candidate.assessmentVersion)) return false;
            const shared = await readShared();
            if (!shared) return false;
            const previous = Date.parse(candidate.answeredAt ?? "");
            if (Number.isFinite(previous) && previous <= deps.now() && Date.parse(shared.answeredAt) <= previous) return false;
            // Pin the accepted correction: a second cache read or an in-flight
            // older assessment cannot turn this reuse into another paid call.
            correctedShared = shared;
            return true;
        };
        const retryableStamp = (saved: Evaluation) => !saved.focusedStamp && Boolean(stampCandidate(saved)) && verifiedFixedPriceTerms();
        const remembered = savedForRefresh ?? await privateEvaluations.load(itemId);
        priorSnapshot = remembered;
        const latest = legacy?.latestEvaluation?.evaluation;
        const revisedLatest = latest ? recheckSavedEvidence(latest, listing) : null;
        if (!options.priceOnly && latest && hasSavedPrintingConflicts(latest) && !latest.frontPhotoStop && !retryableStamp(latest) && matchesPrintingClaim(latest) && !latest.pricingDeferred && !revisedLatest!.needsPricing && canReuseRawResearch(revisedLatest!.evaluation) && legacy?.latestEvaluation?.evidenceKey === listingEvidenceKey({ title: listing.title, images: listing.images }) && currentPriceEvidence(revisedLatest!.evaluation, deps.now()) && !await hasNewerSharedReading(latest)) {
            if (cardLanguageStatus(listing.title, [latest.identity?.language, latest.photoCheck?.cardIdentity?.language]) === "OTHER") throw new EnglishOnlyError();
            const reused = withoutUnsupportedRawPrices(withoutUnsupportedVariantPrices(revisedLatest!.evaluation));
            reused.listing = { ...reused.listing, ...evaluation.listing, photosAnalyzed: latest.listing.photosAnalyzed };
            reused.usage = []; reused.reusedSteps = [...new Set([...reused.reusedSteps, "savedEvaluation"])];
            return publish(reused);
        }
        const revisedRemembered = remembered ? recheckSavedEvidence(remembered.evaluation, listing) : null;
        if (!options.priceOnly && remembered?.contextKey === privateContext.contextKey && hasSavedPrintingConflicts(remembered.evaluation) && !remembered.evaluation.frontPhotoStop && !retryableStamp(remembered.evaluation) &&
            matchesPrintingClaim(remembered.evaluation) && !remembered.evaluation.pricingDeferred && !revisedRemembered!.needsPricing && canReuseRawResearch(revisedRemembered!.evaluation) && (remembered.evaluation.assessmentVersion === ANALYSIS_VERSION || plans.some(plan => plan.version === remembered.evaluation.assessmentVersion)) && currentPriceEvidence(revisedRemembered!.evaluation, deps.now()) && !await hasNewerSharedReading(remembered.evaluation)) {
            const reused = withoutUnsupportedRawPrices(withoutUnsupportedVariantPrices(revisedRemembered!.evaluation));
            if (cardLanguageStatus(listing.title, [reused.identity?.language, reused.photoCheck?.cardIdentity?.language]) === "OTHER") throw new EnglishOnlyError();
            reused.listing = { ...reused.listing, ...evaluation.listing, photosAnalyzed: reused.listing.photosAnalyzed };
            reused.usage = []; reused.reusedSteps = [...new Set([...reused.reusedSteps, "savedEvaluation"])];
            return publish(reused);
        }
        let legacyResolution: ReturnType<typeof reconcileIdentityReadings> | null = null;
        let frontSlabPrices: { key: string; prices: NonNullable<Evaluation["slabPricing"]> } | undefined;
        const slabPriceKey = (identity: NonNullable<Evaluation["identity"]>, slab: NonNullable<Evaluation["slab"]>) =>
            JSON.stringify([identity.name, identity.set, identity.cardNumber, identity.printing, identity.finish, slab.grader, slab.grade]);
        let hardFailure: Error | null = null;
        let priceLimits = 0;
        const deferPrices = () => {
            evaluation.pricingDeferred ??= { provider: "PKMNPRICES", note: "This search's price-research allowance is exhausted. Accepted photos and completed prices are retained; unfinished resale routes are not priced." };
        };
        const guarded = async <T>(work: () => Promise<T>, markDeferred = true): Promise<T> => {
            signal.throwIfAborted();
            try { return await withPriceResearchSignal(signal, work); }
            catch (error) {
                if (options.priceOnly) hardFailure = error instanceof Error ? error : new Error("Price refresh failed.", { cause: error });
                else if (error instanceof PriceResearchBudgetError) {
                    if (error.reason === "LIMIT") {
                        if (markDeferred) { priceLimits++; deferPrices(); }
                    }
                    else hardFailure = error;
                } else { const stop = stopFailure(error); if (stop) hardFailure = stop; }
                throw error;
            }
        };
        // An optional front check can give up without marking later, possibly
        // cached pricing as deferred. Other provider and storage stops apply.
        const peek = <T>(work: () => Promise<T>): Promise<T> => guarded(work, false);
        const unavailable = (error: unknown) => {
            const stop = hardFailure ?? stopFailure(error);
            if (stop) throw stop;
            if (error instanceof PriceResearchBudgetError && error.reason !== "LIMIT") throw error;
            return { status: "PRICE_UNAVAILABLE" as const, reason: evaluation.pricingDeferred?.note ?? "Matching market evidence is currently unavailable. Saved photo evidence is retained." };
        };
        const rawPriceKey = (identity: NonNullable<Evaluation["identity"]>) =>
            JSON.stringify([identity.name, identity.set, identity.cardNumber, identity.printing, identity.finish, evaluation.condition?.rawCondition]);
        let frontRawPrices: { key: string; prices: NonNullable<Evaluation["rawPricing"]> } | undefined;
        const priceRaw = async (identity: NonNullable<Evaluation["identity"]>, card: PricedCard | null,
            { allowSoldPhoto, rawOnly = false }: { allowSoldPhoto: boolean; rawOnly?: boolean }) => {
            const condition = evaluation.condition;
            const prices: Pick<Evaluation, "rawPricing" | "gradedPricing"> = { rawPricing: null, gradedPricing: null };
            if (!condition) return prices;
            const creaseDisclosed = sellerCreaseOverridesCondition(condition.rawCondition, listing.conditionNotes);
            const inspect = rawOnly ? peek : guarded;
            if (frontRawPrices?.key === rawPriceKey(identity)) prices.rawPricing = frontRawPrices.prices;
            else if (condition.rawCondition !== "UNKNOWN") {
                const requestedCondition = creaseDisclosed ? "DAMAGED" : condition.rawCondition;
                const sold = deps.soldCondition({ condition: requestedCondition, loadDetails: (...args) => inspect(() => deps.details(...args)),
                    cached: deps.cached, save: deps.save, now: deps.now });
                const beforeRaw = priceLimits;
                let soldPhotoDeferred: NonNullable<Evaluation["rawPricing"]>["soldPhotoDeferred"];
                let soldPhotoAllowanceDenied = false;
                const raw = await rawPricesWithSales(card, identity, {
                    fetchRawComps: (...args) => inspect(() => deps.fetchRawComps(...args)), signal, now: deps.now(), requestedCondition,
                    assessCondition: (sale, target) => inspect(() => sold.read(sale, target, signal)),
                    conditionStatus: sold.status,
                    acquireCondition: allowSoldPhoto ? async sales => {
                        // Resolving another copy's resale price cannot settle
                        // this copy's suspected structural damage or authenticity.
                        if (condition.creases === "SUSPECTED" || condition.authenticity.concern !== "NONE_SEEN") return null;
                        const shipping = listing.shipping ?? MONEY_CONFIG.buying.assumedShippingWhenUnknown;
                        const pending = sales.filter(sale => sold.status(sale, identity) === "UNREVIEWED" &&
                            matchesSoldTarget(sale, { name: identity.name!, setName: identity.set, cardNumber: identity.cardNumber }));
                        const price = verifiedOfferPrice() ?? listing.price;
                        if (price === null) return null;
                        const meetsTargets = (sale: Comp) => {
                            if (!Number.isFinite(sale.price) || sale.price <= 0) return false;
                            const net = netFromSale(sale.price, "raw", MONEY_CONFIG.selling);
                            return pathNumbers({ expectedNet: net, fixedCosts: 0, shipping, price }, money).clears;
                        };
                        // Prefer an exact or unstated title condition, then a worse copy whose
                        // verified sale could establish a conservative floor at its actual price.
                        const lower = RAW_CONDITIONS.slice(RAW_CONDITIONS.indexOf(requestedCondition) + 1);
                        const cohorts = new Map([requestedCondition, null, ...lower].map(claim => [claim, [] as Comp[]] as const));
                        for (const sale of pending) cohorts.get(compCondition(sale.title))?.push(sale);
                        // Prices gate research on a whole cohort. Always inspect its newest sale,
                        // even when an older sale was the one that cleared the targets.
                        const candidates = [...cohorts.values()].find(group => group.some(meetsTargets));
                        const sale = candidates?.sort((a, b) => Date.parse(b.sold_at) - Date.parse(a.sold_at))[0];
                        if (!sale) {
                            if ([...cohorts.values()].some(group => group.length)) soldPhotoDeferred = { price, shipping, targets: money.targets };
                            return null;
                        }
                        const evidence = await guarded(async () => {
                            try { return await sold.acquire(sale, identity, signal); }
                            catch (error) {
                                if (!(error instanceof AiSearchAllowanceError)) throw error;
                                soldPhotoAllowanceDenied = true;
                                return null;
                            }
                        });
                        return evidence ? { sale, evidence } : null;
                    } : undefined,
                });
                evaluation.usage.push(...sold.usage.map(usage => ({ step: "soldConditionAssessment", ...usage })));
                if (soldPhotoDeferred) {
                    raw.soldPhotoDeferred = soldPhotoDeferred;
                    raw.evidenceNote = `${raw.evidenceNote} A new sold-photo check was skipped because none of the remaining relevant sale amounts could meet the profit and return targets at these purchase terms.`;
                }
                if (soldPhotoAllowanceDenied) {
                    const note = "A new sold-copy photo check did not fit this search's remaining AI allowance.";
                    raw.evidenceNote = `${raw.evidenceNote} ${note}`;
                    if (raw.status === "PRICE_UNAVAILABLE") raw.reason = note;
                }
                prices.rawPricing = priceLimits > beforeRaw ? { status: "PRICE_UNAVAILABLE", reason: evaluation.pricingDeferred!.note } : raw;
            }
            if (hardFailure) throw hardFailure;
            if (!rawOnly && !creaseDisclosed) {
                prices.gradedPricing = {};

                for (const grader of GRADERS) try {
                    prices.gradedPricing[grader] = await gradedPricesFor(card, identity, condition.gradeRange, { grader, now: deps.now(),
                        fetchComps: (...args) => guarded(() => deps.fetchComps(...args)), cachedChecks: (...args) => guarded(() => deps.compChecks(...args)) });
                } catch (error) { prices.gradedPricing[grader] = unavailable(error); }
            }
            return prices;
        };

        async function finishAfterFront(): Promise<boolean> {
            const check = evaluation.photoCheck!;
            const [view] = check.images;
            const card = check.cardIdentity;
            if (check.cardCount !== "ONE" || check.cardMatch?.verdict === "MISMATCH" ||
                view.view !== "FRONT" || !view.usable || view.isStockImage || view.obscuresCondition ||
                card?.confidence !== "HIGH" || !card.name || !card.set || !card.cardNumber || !card.evidence.length) return false;
            if (cardLanguageStatus("", [card.language]) === "OTHER") throw new EnglishOnlyError();
            if (cardLanguageStatus("", [card.language]) !== "ENGLISH") return false;
            const slab = check.holder === "GRADED_SLAB" ? checkSlab(check, listing.aspects) : null;
            const authenticity = evaluation.condition?.authenticity;
            const rawFake = authenticity?.concern === "LIKELY_FAKE" &&
                new Set(authenticity.observations?.filter(item => item.judgment === "SUSPICIOUS").map(item => item.feature)).size >= 2;
            const termsAllowLossCheck = () => typeof details.bestOffer === "boolean" && details.bestOffer === listing.bestOffer &&
                verifiedFixedPriceTerms(listing.shipping ?? 0);
            const priceSlab = slab?.status === "OK" && termsAllowLossCheck();
            const wear = !slab && ["NONE", "SLEEVE", "TOPLOADER"].includes(check.holder) && termsAllowLossCheck()
                ? materialFrontWear(evaluation.condition) : null;
            if (!rawFake && !priceSlab && !wear) return false;
            try {
                signal.throwIfAborted();
                const identified = await deps.identify(listing, check, { lookupCards: query => peek(() => deps.lookup(query)), readTitle: readTitleByRules });
                signal.throwIfAborted();
                if (hardFailure) throw hardFailure;
                if (!readyForPricing(identified.identity) || identified.identity.notThisCard) return false;
                const draft = { ...evaluation, identity: identified.identity, slab };
                if (priceSlab && slab && !unsupportedVariantReason(draft)) {
                    draft.slabPricing = await compsForGrade(identified.card, identified.identity, { grader: slab.grader!, grade: slab.grade!,
                        fetchComps: (...args) => peek(() => deps.fetchComps(...args)), cachedChecks: (...args) => peek(() => deps.compChecks(...args)), now: deps.now() });
                    signal.throwIfAborted();
                    frontSlabPrices = { key: slabPriceKey(identified.identity, slab), prices: draft.slabPricing };
                    if (!termsAllowLossCheck() || !frontSlabLoss(draft)) return false;
                    draft.frontPhotoStop = "SLAB_PRICE";
                    draft.pricesCheckedAt = new Date(deps.now()).toISOString();
                    draft.modeReasons.push("The front label and recent matched sales show a loss after purchase and resale costs.");
                    draft.gradeStatus = "CERTIFIED_SLAB";
                } else if (wear && draft.condition && !unsupportedVariantReason(draft)) {
                    draft.condition = evaluation.condition = { ...draft.condition, rawCondition: wear };
                    const { rawPricing } = await priceRaw(identified.identity, identified.card, { allowSoldPhoto: false, rawOnly: true });
                    draft.rawPricing = rawPricing;
                    if (rawPricing?.prices?.some(entry => entry.condition === evaluation.condition?.rawCondition)) {
                        frontRawPrices = { key: rawPriceKey(identified.identity), prices: rawPricing };
                    }
                    if (!termsAllowLossCheck() || !frontRawResaleLoss(draft)) return false;
                    const grade = FRONT_WEAR_GRADE_REFERENCE;
                    draft.gradedPricing = {};
                    for (const grader of GRADERS) {
                        signal.throwIfAborted();
                        draft.gradedPricing[grader] = await gradedPricesFor(identified.card, identified.identity, { low: grade, high: grade, likely: grade },
                            { grader, now: deps.now(), fetchComps: (...args) => peek(() => deps.fetchComps(...args)),
                                cachedChecks: (...args) => peek(() => deps.compChecks(...args)) });
                        if (!termsAllowLossCheck() || !frontWearGradeLoses(draft, grader)) return false;
                    }
                    draft.frontPhotoStop = "RAW_PRICE";
                    draft.pricesCheckedAt = new Date(deps.now()).toISOString();
                    draft.gradeStatus = "RAW_CONDITION_ONLY";
                } else if (!slab && rawFake && draft.condition && underwrite(draft).verdict === "PASS") {
                    draft.frontPhotoStop = "AUTHENTICITY";
                    draft.modeReasons.push("The first photo showed multiple specific signs of a counterfeit card.");
                    draft.gradeStatus = "UNKNOWN_PHOTO_EVIDENCE";
                } else return false;
                Object.assign(evaluation, draft);
                return true;
            } catch (error) {
                signal.throwIfAborted();
                const failure = hardFailure ?? stopFailure(error);
                if (failure) throw failure;
                if (error instanceof PriceResearchBudgetError && error.reason !== "LIMIT") throw error;
                return false;
            }
        }
        if (canReuseLegacy) {
            evaluation.photoCheck = applyPhotoCheckRules(legacy!.photoCheck!.result, listing.images.length);
            if (legacy?.identityPasses?.length) {
                // Retiring the old request writer must not discard corrections
                // already bought for an expired/missing financial checkpoint.
                legacyResolution = reconcileIdentityReadings(evaluation.photoCheck, legacy.identityPasses.map(pass => pass.result));
                evaluation.photoCheck = legacyResolution.check;
            }
            evaluation.condition = legacyCondition ? structuredClone(legacyCondition) : null;
            evaluation.answeredAt = legacy!.answeredAt;
            evaluation.assessmentVersion = legacy!.version; evaluation.conditionVersion = legacyCondition ? CONDITION_VERSION : undefined;
            evaluation.listing.photosAnalyzed = evaluation.photoCheck.images.length;
            evaluation.reusedSteps = ["photoCheck", ...(legacyCondition ? ["condition"] : []), ...(legacyResolution ? ["identityResolution"] : [])];
        } else {
            const readStage = async (plan: BoundedAssessmentPlan): Promise<SharedAnswer | null> => {
                const stored = await deps.cached<SavedBoundedReading>(plan.key, CACHE_HOURS);
                if (stored === null) return null;
                const timestamp = Date.parse(stored?.answeredAt ?? "");
                if (stored?.version !== plan.version || !Number.isFinite(timestamp) || timestamp > deps.now()) return invalidReading();
                return { reading: validateBoundedReading(stored, plan.photos.length, plan.mode), answeredAt: stored.answeredAt, cached: true, plan };
            };
            const assess = async (plan: BoundedAssessmentPlan, read: () => Promise<SharedAnswer | null>,
                step: string, stage?: BoundedPhotoStage): Promise<SharedAnswer> => {
                if (options.priceOnly) {
                    const cached = await read();
                    signal.throwIfAborted();
                    if (!cached) throw new PriceOnlyEvidenceError("The current listing needs a new photo assessment before it can be repriced.");
                    evaluation.reusedSteps.push(step);
                    return cached;
                }
                const { photos, key } = plan;
                const consumers = neededReadings.get(key) ?? new Set<ReadingConsumer>();
                const consumer: ReadingConsumer = { needed: eligibleNow, context: { ...getAiUsageContext(), listingId: itemId } };
                consumers.add(consumer); neededReadings.set(key, consumers);
                let startedHere = false;
                try {
                    const answer = await shareReading(key, async readingSignal => {
                        startedHere = true;
                        const cached = await read();
                        if (cached) return cached;
                        const rejectedKey = `${key}:rejected`;
                        if (await deps.cached(rejectedKey, CACHE_HOURS) !== null) return invalidReading();
                        // Only a live consumer sponsors the dispatch. A stopped
                        // owner can hand the shared work to another search.
                        const denied = new Map<ReadingConsumer, PriceResearchBudgetError>();
                        for (;;) {
                            readingSignal.throwIfAborted();
                            const live = [...(neededReadings.get(key) ?? [])].filter(value => value.needed());
                            if (!live.length) throw new CandidateOutsideWindow();
                            const sponsor = live.find(value => !denied.has(value));
                            if (!sponsor) throw denied.get(live[0])!;
                            try { await withAiUsageContext(sponsor.context, () => deps.assertPriceAvailable(readingSignal)); }
                            catch (error) {
                                if (error instanceof PriceResearchBudgetError && error.reason === "LIMIT") { denied.set(sponsor, error); continue; }
                                throw error;
                            }
                            readingSignal.throwIfAborted();
                            if (!sponsor.needed()) continue;
                            const accepted = await withAiUsageContext(sponsor.context, () => deps.assess(listing, photos, readingSignal, plan.mode, stage));
                            const answeredAt = new Date(deps.now()).toISOString();
                            let reading: BoundedReading;
                            try { reading = validateBoundedReading(accepted.result, photos.length, plan.mode); }
                            catch (error) {
                                if (!(error instanceof StorageUnavailableError)) throw error;
                                // Keep the rejected paid answer separate from valid
                                // evidence, including the accepted first stage.
                                await deps.save(rejectedKey, { ...accepted, version: plan.version, answeredAt,
                                    photoNumbers: photos.map(photo => photo.number), reason: error.message });
                                throw error;
                            }
                            if (reading.photoCheck.holder === "GRADED_SLAB") reading.condition = null;
                            else if (stage?.kind === "front" && reading.condition) reading.condition.gradeRange = null;
                            // Keep accepted evidence even if every browser stops.
                            await deps.save(key, { ...reading, version: plan.version, answeredAt, usage: accepted.usage });
                            return { reading, answeredAt, cached: false, usage: accepted.usage, plan };
                        }
                    }, signal);
                    signal.throwIfAborted();
                    if (!eligibleNow()) throw new CandidateOutsideWindow();
                    if (answer.cached || !startedHere) evaluation.reusedSteps.push(step);
                    else evaluation.usage.push({ step, ...answer.usage! });
                    return answer;
                } finally {
                    consumers.delete(consumer);
                    if (!consumers.size && neededReadings.get(key) === consumers) neededReadings.delete(key);
                }
            };
            const applyReading = ({ reading: savedReading, plan, answeredAt }: SharedAnswer) => {
                const reading = structuredClone(savedReading), photos = plan.photos;
                reading.photoCheck.images = reading.photoCheck.images.map(image => ({ ...image, number: photos[image.number - 1].number }));
                if (reading.condition?.authenticity.observations) {
                    reading.condition.authenticity.observations = reading.condition.authenticity.observations.map(item =>
                        ({ ...item, photoNumber: photos[item.photoNumber - 1].number }));
                }
                evaluation.photoCheck = applyPhotoCheckRules(reading.photoCheck, listing.images.length);
                evaluation.condition = reading.photoCheck.holder === "GRADED_SLAB" ? null : reading.condition;
                evaluation.assessmentVersion = plan.version;
                evaluation.conditionVersion = plan.conditionVersion;
                evaluation.answeredAt = answeredAt;
                evaluation.listing.photosAnalyzed = photos.length;
            };
            try {
                let answer = correctedShared ?? await readShared();
                if (answer) evaluation.reusedSteps.push("boundedPhotoAssessment");
                else if (listing.buyingOption === "FIXED_PRICE" && typeof details.bestOffer === "boolean" && requestedPlan.photos.length > 1) {
                    const frontPlan = stagedPhotoPlan(listing, requestedPlan, "front");
                    const first = await assess(frontPlan, () => readStage(frontPlan), "frontPhotoAssessment", { kind: "front" });
                    applyReading(first);
                    if (requestedPlan.mode === "RAW" && listing.images.length === 2 && frontShowsDifferentNumber(listing, first.reading.photoCheck)) {
                        evaluation.modeReasons.push("The first photo shows a different collector number from both the listing title and item specifics.");
                        answer = first;
                    } else {
                        if ((!options.priceOnly || remembered?.evaluation.frontPhotoStop) && await finishAfterFront()) return finish();
                        // Cache metadata is not part of the first photo's findings.
                        // Earlier keys could include it when that first stage was reused.
                        const originalFront = { photoCheck: first.reading.photoCheck, condition: first.reading.condition };
                        const slab = readableFrontSlab(originalFront.photoCheck);
                        const front = slab ? { ...originalFront, condition: null } : originalFront;
                        const nextPlan = slab && requestedPlan.mode === "RAW" ? plans.find(plan => plan.mode === "SLAB_LABEL")! : requestedPlan;
                        const remainder = stagedPhotoPlan(listing, nextPlan, "remainder", front);
                        const previous = requestedPlan.mode === "RAW"
                            ? plans.find(plan => plan.version === `${requestedPlan.model}/bounded-prompts-${PREVIOUS_BOUNDED_REVIEW_REVISION}`) : undefined;
                        const earlierPlan = previous ?? requestedPlan;
                        const rest = await assess(remainder, async () => {
                            const current = await readStage(remainder);
                            if (current) return current;
                            if (nextPlan !== requestedPlan) {
                                const saved = await readStage(stagedPhotoPlan(listing, requestedPlan, "remainder", originalFront));
                                if (saved) return saved;
                            }
                            if (previous) {
                                const saved = await readStage(stagedPhotoPlan(listing, previous, "remainder", originalFront));
                                if (saved) return saved;
                            }
                            return first.cached ? readStage(stagedPhotoPlan(listing, earlierPlan, "remainder", first.reading)) : null;
                        }, "remainingPhotoAssessment", { kind: "remainder", front });
                        const sourcePlan = rest.plan.version === remainder.version ? nextPlan :
                            rest.plan.version === `${requestedPlan.version}/remainder-1` ? requestedPlan : earlierPlan;
                        answer = { ...rest, plan: sourcePlan, reading: combinePhotoReadings(front, rest.reading) };
                        evaluation.modeReasons.push("Checked the first photo before requesting the remaining selected views.");
                    }
                } else answer = await assess(requestedPlan, readShared, "boundedPhotoAssessment");

                applyReading(answer);
                const sourcePhotos = answer.plan.photos;
                evaluation.modeReasons.push(`Checked listing photos ${sourcePhotos.map(photo => photo.number).join(", ")} of ${listing.images.length}. Unselected photos were not assessed.`);
                if (answer.plan.mode === "SLAB_LABEL" && answer.reading.photoCheck.holder !== "GRADED_SLAB") evaluation.modeReasons.push("The seller's graded-card claim was not confirmed. This label check did not start a separate raw-condition assessment.");
            } catch (error) {
                if (error instanceof CandidateOutsideWindow) return deferWindow();
                throw error;
            }
        }
        const check = evaluation.photoCheck!;
        if (options.priceOnly) {
            const previous = remembered?.evaluation;
            if (previous?.deeperPhotoReview && previous.photoReviewKey === previous.deeperPhotoReview.inputKey &&
                remembered?.contextKey === privateContext.contextKey && previous.assessmentVersion === evaluation.assessmentVersion && previous.answeredAt === evaluation.answeredAt) {
                evaluation.photoReviewKey = previous.photoReviewKey;
                evaluation.deeperPhotoReview = previous.deeperPhotoReview;
            }
        }
        // Reuse the focused observation when purchase terms or pricing age
        // require a fresh valuation of the same accepted photo assessment.
        const previousStamp = remembered?.evaluation.focusedStamp;
        if (previousStamp && remembered.contextKey === privateContext.contextKey &&
            remembered.evaluation.assessmentVersion === evaluation.assessmentVersion && remembered.evaluation.answeredAt === evaluation.answeredAt &&
            check.printingMarks?.firstEditionStamp === "CANT_TELL" && !check.printingMarks.conflicts?.includes("firstEditionStamp") &&
            ["VISIBLE", "NOT_PRESENT", "CANT_TELL"].includes(previousStamp.result) &&
            check.images.some(image => image.number === previousStamp.photoNumber && image.view === "FRONT" && image.usable && !image.isStockImage)) {
            evaluation.focusedStamp = previousStamp;
            check.printingMarks.firstEditionStamp = previousStamp.result;
            check.printingMarks.evidence = [...(check.printingMarks.evidence ?? []), stampNote(previousStamp)];
            evaluation.reusedSteps.push("focusedEditionStamp");
            evaluation.modeReasons.push(stampNote(previousStamp));
        }
        if (cardLanguageStatus(listing.title, [listing.aspects.Language, check.cardIdentity?.language]) === "OTHER") throw new EnglishOnlyError();
        const mode = getGradingMode(check);
        evaluation.gradingMode = mode.mode; evaluation.modeReasons.push(...mode.reasons);
        const hasUsableFront = check.images.some(image => image.view === "FRONT" && image.usable && !image.isStockImage);
        const isVisibleRawCopy = check.cardCount === "ONE" && check.holder !== "GRADED_SLAB" && hasUsableFront;
        if (evaluation.condition && isVisibleRawCopy) {
            // Insufficient detail for numeric grading need not erase obvious
            // raw wear, such as a crease. Structural/identity/slab checks stay
            // independent, and the original paid reading remains unchanged.
            const source = evaluation.condition;
            const condition = applyConditionRules(source, mode.mode, { closeUps: hasCloseUps(check), photoCount: listing.images.length });
            const hasRequiredGrade = evaluation.assessmentVersion?.endsWith(`/bounded-prompts-${BOUNDED_REVIEW_REVISION}`);
            if (condition && source.gradeRange && (mode.mode === "BLOCKED" || hasRequiredGrade && condition.confidence === "LOW")) {
                evaluation.provisionalGradeRange = source.gradeRange;
                condition.gradeRange = null;
            }
            evaluation.condition = mode.mode === "BLOCKED" && condition?.rawCondition === "UNKNOWN" ? null : condition;
            if (mode.mode === "BLOCKED" && evaluation.condition) evaluation.modeReasons.push("The photos support a raw-condition assessment; numeric grading remains unavailable.");
        } else evaluation.condition = null;
        evaluation.gradeStatus = evaluation.condition?.gradeRange ? "ESTIMATED" : evaluation.condition ? "RAW_CONDITION_ONLY" : check.holder === "GRADED_SLAB" ? "CERTIFIED_SLAB" : "UNKNOWN_PHOTO_EVIDENCE";
        signal.throwIfAborted();
        if (check.cardCount !== "ONE" || !hasUsableFront) return finish();
        if (check.holder === "GRADED_SLAB") evaluation.slab = checkSlab(check, listing.aspects);
        const card = check.cardIdentity;
        const aspects = { ...listing.aspects };
        if (card?.confidence === "HIGH") for (const [field, value] of [["Card Name", card.name], ["Set", card.set], ["Card Number", card.cardNumber], ["Language", card.language], ["Finish", card.finish === "UNKNOWN" ? null : card.finish]]) if (value && !aspects[field!]) aspects[field!] = value;
        if (obscuredDisclosedWear(evaluation)) return finish();
        const identify = (reading: typeof check) => deps.identify({ ...listing, aspects }, reading, { lookupCards: query => guarded(() => deps.lookup(query)), readTitle: readTitleByRules,
            ...(legacyResolution?.confirmation ? { photoIdentity: legacyResolution.confirmation } : {}) });
        const identified = await identify(check);
        if (hardFailure) throw hardFailure;
        evaluation.identity = identified.identity;
        if (priceLimits && identified.lookupFailed) evaluation.pricingDeferred!.identityLookupPending = true;
        if (legacyResolution?.finishConflict) {
            if (evaluation.pricingDeferred) delete evaluation.pricingDeferred.identityLookupPending;
            evaluation.identity.finish = "CONFLICTING"; evaluation.identity.status = "NEEDS_REVIEW";
            evaluation.identity.reasons.push("Saved independent photo readings disagree about this card's finish.");
        }
        if (cardLanguageStatus(listing.title, [identified.identity.language]) === "OTHER") throw new EnglishOnlyError();
        if (check.cardMatch?.verdict === "MISMATCH" && !evaluation.identity.notThisCard && !legacyResolution?.confirmation && !identified.sellerClaimsCorrected) {
            if (evaluation.pricingDeferred) delete evaluation.pricingDeferred.identityLookupPending;
            evaluation.identity.status = "NEEDS_REVIEW"; evaluation.identity.notThisCard = check.cardMatch.problems.join("; ") || "The photographed card differs from the listing.";
            evaluation.identity.reasons.push(evaluation.identity.notThisCard);
        }
        if (!canReuseLegacy && (!card?.name || !card.set || !card.cardNumber || !card.evidence.length || card.confidence === "LOW" || cardLanguageStatus("", [card.language]) !== "ENGLISH")) {
            if (evaluation.pricingDeferred) delete evaluation.pricingDeferred.identityLookupPending;
            evaluation.identity.status = "NEEDS_REVIEW";
            evaluation.identity.reasons.push("The bounded photos do not establish the exact English card identity. Seller wording alone cannot confirm it.");
        }
        // The optional crop can settle an unknown stamp only when two exact,
        // independently priced alternatives lead to opposite buying decisions.
        // Do not use unverified browser price/shipping overrides for this gate.
        if (!readyForPricing(evaluation.identity)) {
            if (options.priceOnly || evaluation.focusedStamp || !stampCandidate(evaluation) || !verifiedFixedPriceTerms()) return finish();
            try {
                const decision = await findStampDecision(evaluation, {
                    targets: money.targets, now: deps.now(), identify, signal,
                    price: (identity, card) => priceRaw(identity, card, { allowSoldPhoto: false }),
                });
                if (hardFailure) throw hardFailure;
                if (decision && !evaluation.pricingDeferred && verifiedFixedPriceTerms()) {
                    const deadline = Math.min(Date.parse(details.retrievedAt!) + STAMP_TERMS_MAX_AGE_MS,
                        evaluation.listing.endTime ? Date.parse(evaluation.listing.endTime) : Infinity);
                    const answer = await deps.stamp(evaluation.listing, check,
                        AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, deadline - deps.now()))]));
                    signal.throwIfAborted();
                    if (answer) {
                        if (answer.reused) evaluation.reusedSteps.push("focusedEditionStamp");
                        else evaluation.usage.push({ step: "focusedEditionStamp", ...answer.usage });
                        if (verifiedFixedPriceTerms()) {
                            evaluation.focusedStamp = { result: answer.result, ...answer.source };
                            const note = stampNote(evaluation.focusedStamp);
                            evaluation.modeReasons.push(note);
                            if (answer.result !== "CANT_TELL") {
                                const selected = decision[answer.result];
                                selected.check.printingMarks!.evidence = [...(selected.check.printingMarks!.evidence ?? []), note];
                                selected.identity.evidence!.photoNotes = [...(selected.identity.evidence!.photoNotes ?? []), note];
                                Object.assign(evaluation, { photoCheck: selected.check, identity: selected.identity,
                                    rawPricing: selected.rawPricing, gradedPricing: selected.gradedPricing, pricesCheckedAt: new Date(deps.now()).toISOString() });
                            }
                        }
                    }
                }
            } catch (error) {
                signal.throwIfAborted();
                const failure = hardFailure ?? storageFailure(error);
                if (failure) throw failure;
                if (error instanceof PriceResearchBudgetError && error.reason !== "LIMIT") throw error;
                // A denied reservation, failed crop or unavailable comparison
                // leaves the original unresolved assessment available.
            }
            return finish();
        }
        if (unsupportedVariantReason(evaluation)) return finish();
        const identity = evaluation.identity;
        if (check.holder === "GRADED_SLAB") {
            const slab = evaluation.slab;
            if (slab?.status === "OK") try {
                evaluation.slabPricing = frontSlabPrices?.key === slabPriceKey(identity, slab) ? frontSlabPrices.prices
                    : await compsForGrade(identified.card, identity, { grader: slab.grader!, grade: slab.grade!,
                        fetchComps: (...args) => guarded(() => deps.fetchComps(...args)), cachedChecks: (...args) => guarded(() => deps.compChecks(...args)), now: deps.now() });
            } catch (error) { evaluation.slabPricing = unavailable(error); }
        } else {
            if (!evaluation.condition || evaluation.condition.rawCondition === "UNKNOWN" && !evaluation.condition.gradeRange) return finish();
            Object.assign(evaluation, await priceRaw(identity, identified.card, { allowSoldPhoto: !options.priceOnly }));
            // A terms-only refresh cannot complete a legacy gap that still needs a sold photo.
            if (savedForRefresh?.evaluation.pricingVersion === PREVIOUS_PRICING_VERSION && evaluation.rawPricing?.status === "PRICE_UNAVAILABLE") {
                evaluation.pricingVersion = PREVIOUS_PRICING_VERSION;
            }
        }
        signal.throwIfAborted();
        evaluation.pricesCheckedAt = new Date(deps.now()).toISOString();
        return finish();
    }), options.signal);
}
export const evaluateBoundedListing = createBoundedEvaluator();
