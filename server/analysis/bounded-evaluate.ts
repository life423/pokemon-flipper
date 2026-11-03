import { getListingDetails, listingCacheKey, type ListingDetails } from "../ebay/listings.ts";
import { ANALYSIS_VERSION, CONDITION_VERSION } from "./legacy-evidence.ts";
import { assessBoundedListing, type BoundedReading } from "../ai/bounded-assessment.ts";
import { BOUNDED_ASSESSMENT_VERSION, BOUNDED_CONDITION_VERSION, BOUNDED_SLAB_ASSESSMENT_VERSION, compatibleBoundedPlans, type BoundedAssessmentPlan } from "./bounded-plan.ts";
export { assessBoundedListing, BOUNDED_ASSESSMENT_SCHEMA, type BoundedReading } from "../ai/bounded-assessment.ts";
export { BOUNDED_VISION_MODEL, BOUNDED_ASSESSMENT_VERSION, BOUNDED_CONDITION_VERSION, BOUNDED_SLAB_ASSESSMENT_VERSION, BOUNDED_PHOTO_LIMIT, selectBoundedPhotos, boundedAssessmentKey, boundedAssessmentPlan } from "./bounded-plan.ts";
import { cachedCompChecks } from "../ai/comp-checker.ts";
import { acceptedSoldCondition, corroboratedSoldCondition, type SoldConditionReading } from "../ai/sold-condition.ts";
import { VISION_MODEL } from "../ai/policy.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { storageFailure } from "../lib/storage-failure.ts";
import { StorageUnavailableError } from "../storage/index.ts";
import { aiSpendingFailure } from "../ai/spending.ts";
import { identifyCard, readyForPricing } from "../identity/card-identity.ts";
import { checkSlab } from "../identity/slab-check.ts";
import { lookupCards, fetchComps, fetchRawComps } from "../pricing/pkmnprices.ts";
import { gradedPricesFor, compsForGrade } from "../pricing/graded-comps.ts";
import { rawPricesWithSales } from "../pricing/raw-comps.ts";
import { rawPricesFor } from "../pricing/raw-prices.ts";
import { loadSaved, reusableRecord, photoFingerprint } from "./store.ts";
import { applyPhotoCheckRules, applyConditionRules, getGradingMode, hasCloseUps } from "./rules.ts";
import { underwrite, GRADERS } from "../../shared/money/underwriting.ts";
import { rateDeal } from "../../shared/money/rating.ts";
import { cardLanguageStatus, EnglishOnlyError } from "../../shared/card-language.ts";
import { listingEvidenceKey } from "../../shared/listing-evidence.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { currentPriceEvidence, PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import { RAW_CONDITIONS, CONDITION_RULES_VERSION } from "../../shared/conditions.ts";
import { withinAutomaticAuctionWindow } from "../../shared/listing-filters.ts";
import type { Evaluation } from "../../shared/types.ts";
import type { Usage } from "./types.ts";
import type { Comp } from "../pricing/types.ts";
import { createPrivateEvaluationStore, evaluationContextKey } from "./private-evaluation.ts";
import { reconcileIdentityReadings } from "./resolve-evidence.ts";

const CACHE_HOURS = 24 * 365 * 10;
interface SavedBoundedReading extends BoundedReading { version: string; answeredAt: string; usage: Usage }
export interface BoundedOptions { automatic?: boolean; signal?: AbortSignal; current?: import("./types.ts").CurrentState | null }

const hasStrings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 8 && value.every(note => typeof note === "string" && note.length <= 1200);
function invalidReading(): never { throw new StorageUnavailableError("The bounded photo assessment is incomplete or invalid. Saved evidence was kept; no automatic replacement assessment was authorized."); }
export function validateBoundedReading(value: unknown, photoCount: number, mode: BoundedAssessmentPlan["mode"] = "RAW"): BoundedReading {
    const reading = value as BoundedReading | null;
    const check = reading?.photoCheck;
    if (!reading || !check || !["ONE", "MULTIPLE", "UNKNOWN"].includes(check.cardCount) || !["HIGH", "MEDIUM", "LOW"].includes(check.confidence) ||
        !["SUFFICIENT", "PARTIAL", "INSUFFICIENT"].includes(check.photoSufficiency) || !["NONE", "SLEEVE", "TOPLOADER", "GRADED_SLAB", "OTHER", "UNKNOWN"].includes(check.holder) ||
        !Array.isArray(check.images) || check.images.length !== photoCount || !hasStrings(check.missingViews) || !hasStrings(check.problems)) return invalidReading();
    if (check.images.some(image => !image || !Number.isInteger(image.number) || image.number < 1 || image.number > photoCount || !["FRONT", "BACK", "FRONT_DETAIL", "BACK_DETAIL", "OTHER"].includes(image.view) ||
        typeof image.usable !== "boolean" || typeof image.isStockImage !== "boolean" || typeof image.obscuresCondition !== "boolean" || !hasStrings(image.issues)) || new Set(check.images.map(image => image.number)).size !== photoCount) return invalidReading();
    const card = check.cardIdentity;
    if (!card || !["HIGH", "MEDIUM", "LOW"].includes(card.confidence) || !["HOLO", "REVERSE_HOLO", "NON_HOLO", "UNKNOWN"].includes(card.finish) ||
        [card.name, card.set, card.cardNumber, card.language].some(value => value !== null && typeof value !== "string") || !hasStrings(card.evidence) || card.confidence === "HIGH" && !card.evidence.length || !check.printingMarks ||
        !["VISIBLE", "NOT_PRESENT", "CANT_TELL"].includes(check.printingMarks.firstEditionStamp) || !["PRESENT", "ABSENT", "CANT_TELL"].includes(check.printingMarks.artBoxShadow) || typeof check.printingMarks.reprintMark !== "string" || !hasStrings(check.printingMarks.evidence) ||
        !check.cardMatch || !["MATCH", "MISMATCH", "CANT_TELL"].includes(check.cardMatch.verdict) || !hasStrings(check.cardMatch.problems)) return invalidReading();
    if (check.slab && (typeof check.slab.present !== "boolean" || [check.slab.grader, check.slab.grade, check.slab.gradeQualifier, check.slab.certNumber, check.slab.labelText].some(value => value !== null && typeof value !== "string") ||
        !["INTACT", "SCRATCHED", "CRACKED", "NOT_VISIBLE"].includes(check.slab.caseCondition) || !["NONE_SEEN", "POSSIBLE", "LIKELY_FAKE"].includes(check.slab.authenticity) || !hasStrings(check.slab.concerns) || !hasStrings(check.slab.authenticityEvidence))) return invalidReading();
    if (check.holder === "GRADED_SLAB" && !check.slab?.present) return invalidReading();
    const condition = reading.condition;
    if (mode === "SLAB_LABEL" && condition !== null) return invalidReading();
    if (condition !== null) {
        if (!condition || typeof condition.summary !== "string" || !hasStrings(condition.limitations) || ![...RAW_CONDITIONS, "UNKNOWN"].includes(condition.rawCondition) ||
            !["LOW", "MEDIUM", "HIGH"].includes(condition.confidence) || !["NONE_SEEN", "SUSPECTED", "PRESENT"].includes(condition.creases)) return invalidReading();
        for (const area of [condition.centering, condition.corners, condition.edges, condition.surface]) if (!area || !["CLEAR", "PARTIAL", "NOT_VISIBLE"].includes(area.visibility) || !["NONE", "MINOR", "MODERATE", "SEVERE", "UNKNOWN"].includes(area.severity) || !hasStrings(area.observations)) return invalidReading();
        const range = condition.gradeRange;
        if (range !== null && (!range || !Number.isInteger(range.low) || !Number.isInteger(range.high) || range.low < 1 || range.high > 10 || range.high < range.low || range.high - range.low > 2 ||
            range.likely !== null && (!Number.isInteger(range.likely) || range.likely < range.low || range.likely > range.high))) return invalidReading();
        if (!condition.authenticity || !hasStrings(condition.authenticity.reasons) || !hasStrings(condition.authenticity.limitations) || !Array.isArray(condition.authenticity.observations) ||
            !applyConditionRules(condition, "FULL", { closeUps: true, photoCount })) return invalidReading();
    }
    return structuredClone(reading);
}
interface Dependencies {
    details: typeof getListingDetails; saved: typeof loadSaved; cached: typeof readCache; save: typeof writeCache;
    assess: typeof assessBoundedListing; identify: typeof identifyCard; lookup: typeof lookupCards; fetchComps: typeof fetchComps; fetchRawComps: typeof fetchRawComps;
    compChecks: typeof cachedCompChecks; now: () => number;
}
function stopFailure(error: unknown) { return aiSpendingFailure(error) ?? storageFailure(error); }
class CandidateOutsideWindow extends Error {}

// Reapply deterministic label rules to paid evidence rather than purchasing
// the photos again when a seller-metadata policy changes.
function recheckSavedSlab(evaluation: Evaluation, aspects: Record<string, string>): { evaluation: Evaluation; needsPricing: boolean } {
    const revised = structuredClone(evaluation);
    if (revised.photoCheck?.holder !== "GRADED_SLAB") return { evaluation: revised, needsPricing: false };
    const previousStatus = revised.slab?.status;
    revised.slab = checkSlab(revised.photoCheck, aspects);
    const pricing = revised.slabPricing;
    const priced = pricing?.status === "PRICED" && pricing.grader === revised.slab.grader && pricing.grade === revised.slab.grade;
    return { evaluation: revised, needsPricing: revised.slab.status === "OK" && !priced && previousStatus !== "OK" };
}

export function createBoundedEvaluator(overrides: Partial<Dependencies> = {}) {
    const deps: Dependencies = { details: getListingDetails, saved: loadSaved, cached: readCache, save: writeCache, assess: assessBoundedListing, identify: identifyCard,
        lookup: lookupCards, fetchComps, fetchRawComps, compChecks: cachedCompChecks, now: Date.now, ...overrides };
    const share = createSharedWork();
    const shareReading = createSharedWork();
    const neededReadings = new Map<string, Set<() => boolean>>();
    const privateEvaluations = createPrivateEvaluationStore({ cached: deps.cached, save: deps.save });
    return (itemId: string, options: BoundedOptions = {}): Promise<Evaluation> => share(JSON.stringify([itemId, options.current ?? null, options.automatic ?? false]), async signal => {
        signal.throwIfAborted();
        const details = await deps.details(itemId, { ...(!options.current ? { maxAgeHours: 0 } : {}), expectedPhotos: options.current?.images, expectedTitle: options.current?.title });
        const listing = options.current ? { ...details, price: options.current.price ?? details.price, shipping: options.current.shipping ?? details.shipping,
            bids: options.current.bids, endTime: options.current.endTime ?? details.endTime } : details;
        if (cardLanguageStatus(listing.title, [listing.aspects.Language]) === "OTHER") throw new EnglishOnlyError();
        const plans = compatibleBoundedPlans(listing), requestedPlan = plans[0];
        const ended = listing.availability === "UNAVAILABLE" || listing.endTime && Date.parse(listing.endTime) <= deps.now();
        const evaluation: Evaluation = { assessmentVersion: requestedPlan.version, conditionVersion: requestedPlan.mode === "RAW" ? BOUNDED_CONDITION_VERSION : undefined, pricingVersion: PRICING_VERSION,
            listing: { id: listing.id, title: listing.title, url: listing.url, listedAt: listing.listedAt, createdAt: listing.createdAt,
                availability: ended ? "UNAVAILABLE" : listing.availability, termsCheckedAt: listing.retrievedAt,
                price: listing.price, shipping: listing.shipping, buyingOption: listing.buyingOption, bids: listing.bids, endTime: listing.endTime,
                photos: listing.images, photosInListing: listing.images.length, photosAnalyzed: 0, cardCondition: listing.cardCondition, conditionNotes: listing.conditionNotes,
                seller: listing.seller, sellerCondition: listing.condition, aspects: listing.aspects },
            photoCheck: null, condition: null, gradingMode: "BLOCKED", modeReasons: [], gradeStatus: "SKIPPED", setAside: [], identity: null,
            rawPricing: null, gradedPricing: null, slab: null, slabPricing: null, underwriting: null, rating: null, answeredAt: null, reusedSteps: [], usage: [] };
        const privateContext = { evidenceKey: listingEvidenceKey({ title: options.current?.title ?? listing.title, images: options.current?.images ?? listing.images }), contextKey: evaluationContextKey(listing) };
        const finish = async () => {
            evaluation.underwriting = underwrite(evaluation); evaluation.rating = rateDeal(evaluation);
            if (evaluation.photoCheck) await privateEvaluations.save(evaluation, privateContext);
            return evaluation;
        };
        if (ended || !listing.images.length) { evaluation.modeReasons = [ended ? "This listing is no longer available." : "The listing has no photos."]; return finish(); }
        const eligibleNow = () => !signal.aborted && (!listing.endTime || Date.parse(listing.endTime) > deps.now()) &&
            (!options.automatic || withinAutomaticAuctionWindow(listing, deps.now()));
        const deferWindow = () => { evaluation.modeReasons = ["Automatic auction analysis is limited to live auctions ending within the next 12 hours."]; evaluation.gradeStatus = "DEFERRED_AUCTION_WINDOW"; return finish(); };
        if (!eligibleNow()) return deferWindow();
        const legacy = reusableRecord(await deps.saved(itemId), { version: ANALYSIS_VERSION, fingerprint: photoFingerprint(listing.images.slice(0, 24)), title: listing.title });
        type SharedAnswer = { reading: BoundedReading; answeredAt: string; cached: boolean; plan: BoundedAssessmentPlan; usage?: Usage };
        let checkedShared: SharedAnswer | null | undefined;
        let correctedShared: SharedAnswer | null = null;
        const readShared = async (): Promise<SharedAnswer | null> => {
            if (checkedShared === undefined) {
                const answers: SharedAnswer[] = [];
                for (const plan of plans) {
                    const stored = await deps.cached<SavedBoundedReading>(plan.key, CACHE_HOURS);
                    if (!stored) continue;
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
            if (![BOUNDED_ASSESSMENT_VERSION, BOUNDED_SLAB_ASSESSMENT_VERSION].includes(candidate.assessmentVersion ?? "")) return false;
            const shared = await readShared();
            if (!shared) return false;
            const previous = Date.parse(candidate.answeredAt ?? "");
            if (Number.isFinite(previous) && previous <= deps.now() && Date.parse(shared.answeredAt) <= previous) return false;
            // Pin the accepted correction: a second cache read or an in-flight
            // older assessment cannot turn this reuse into another paid call.
            correctedShared = shared;
            return true;
        };
        const latest = legacy?.latestEvaluation?.evaluation;
        const revisedLatest = latest ? recheckSavedSlab(latest, listing.aspects) : null;
        if (latest && !revisedLatest!.needsPricing && legacy?.latestEvaluation?.evidenceKey === listingEvidenceKey({ title: listing.title, images: listing.images }) && currentPriceEvidence(latest, deps.now()) && !await hasNewerSharedReading(latest)) {
            if (cardLanguageStatus(listing.title, [latest.identity?.language, latest.photoCheck?.cardIdentity?.language]) === "OTHER") throw new EnglishOnlyError();
            const reused = revisedLatest!.evaluation;
            reused.listing = { ...reused.listing, ...evaluation.listing, photosAnalyzed: latest.listing.photosAnalyzed };
            reused.usage = []; reused.reusedSteps = [...new Set([...reused.reusedSteps, "savedEvaluation"])];
            reused.underwriting = underwrite(reused); reused.rating = rateDeal(reused);
            await privateEvaluations.save(reused, privateContext); return reused;
        }
        const remembered = await privateEvaluations.load(itemId);
        const revisedRemembered = remembered ? recheckSavedSlab(remembered.evaluation, listing.aspects) : null;
        if (remembered?.contextKey === privateContext.contextKey &&
            !revisedRemembered!.needsPricing && [BOUNDED_ASSESSMENT_VERSION, BOUNDED_SLAB_ASSESSMENT_VERSION, ANALYSIS_VERSION].includes(remembered.evaluation.assessmentVersion ?? "") && currentPriceEvidence(remembered.evaluation, deps.now()) && !await hasNewerSharedReading(remembered.evaluation)) {
            const reused = revisedRemembered!.evaluation;
            if (cardLanguageStatus(listing.title, [reused.identity?.language, reused.photoCheck?.cardIdentity?.language]) === "OTHER") throw new EnglishOnlyError();
            reused.listing = { ...reused.listing, ...evaluation.listing, photosAnalyzed: reused.listing.photosAnalyzed };
            reused.usage = []; reused.reusedSteps = [...new Set([...reused.reusedSteps, "savedEvaluation"])];
            reused.underwriting = underwrite(reused); reused.rating = rateDeal(reused);
            await privateEvaluations.save(reused, privateContext); return reused;
        }
        const legacyCondition = legacy?.assessment?.version === CONDITION_VERSION ? legacy.assessment.result : null;
        const canReuseLegacy = Boolean(legacy?.photoCheck && (legacy.photoCheck.result.holder === "GRADED_SLAB" || legacyCondition));
        let legacyResolution: ReturnType<typeof reconcileIdentityReadings> | null = null;
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
            const { photos, key } = requestedPlan;
            const consumers = neededReadings.get(key) ?? new Set<() => boolean>();
            consumers.add(eligibleNow); neededReadings.set(key, consumers);
            let startedHere = false;
            let answer: SharedAnswer;
            try {
                answer = correctedShared ?? await shareReading(key, async readingSignal => {
                    startedHere = true;
                    const cached = await readShared();
                    if (cached) return cached;
                    readingSignal.throwIfAborted();
                    // Recheck all live consumers immediately before paid work;
                    // one stopped/expired listing must not cancel another copy.
                    if (![...(neededReadings.get(key) ?? [])].some(needed => needed())) throw new CandidateOutsideWindow();
                    const accepted = await deps.assess(listing, photos, readingSignal, requestedPlan.mode);
                    const reading = validateBoundedReading(accepted.result, photos.length, requestedPlan.mode), answeredAt = new Date(deps.now()).toISOString();
                    // Save accepted evidence even if every browser has stopped.
                    await deps.save(key, { ...reading, version: requestedPlan.version, answeredAt, usage: accepted.usage });
                    return { reading, answeredAt, cached: false, usage: accepted.usage, plan: requestedPlan };
                }, signal);
            } catch (error) {
                if (error instanceof CandidateOutsideWindow) return deferWindow();
                throw error;
            } finally {
                consumers.delete(eligibleNow);
                if (!consumers.size && neededReadings.get(key) === consumers) neededReadings.delete(key);
            }
            signal.throwIfAborted();
            if (!eligibleNow()) return deferWindow();
            const reading = structuredClone(answer.reading), answeredAt = answer.answeredAt;
            const sourcePhotos = answer.plan.photos;
            if (answer.cached || !startedHere) evaluation.reusedSteps.push("boundedPhotoAssessment");
            else evaluation.usage.push({ step: "boundedPhotoAssessment", ...answer.usage! });
            reading.photoCheck.images = reading.photoCheck.images.map(image => ({ ...image, number: sourcePhotos[image.number - 1].number }));
            if (reading.condition?.authenticity.observations) reading.condition.authenticity.observations = reading.condition.authenticity.observations.map(observation => ({ ...observation, photoNumber: sourcePhotos[observation.photoNumber - 1].number }));
            evaluation.photoCheck = applyPhotoCheckRules(reading.photoCheck, listing.images.length);
            evaluation.condition = reading.condition;
            evaluation.assessmentVersion = answer.plan.version;
            evaluation.conditionVersion = answer.plan.mode === "RAW" ? BOUNDED_CONDITION_VERSION : undefined;
            evaluation.answeredAt = answeredAt; evaluation.listing.photosAnalyzed = sourcePhotos.length;
            evaluation.modeReasons.push(`One bounded ${answer.plan.mode === "SLAB_LABEL" ? "slab identity and label check" : "raw identity and condition assessment"} checked listing photos ${sourcePhotos.map(photo => photo.number).join(", ")} of ${listing.images.length}. Unselected photos were not assessed; no second opinion was purchased.`);
            if (answer.plan.mode === "SLAB_LABEL" && reading.photoCheck.holder !== "GRADED_SLAB") evaluation.modeReasons.push("The seller's graded-card claim was not confirmed. Raw condition was not assessed by this label-only check; no second paid assessment was started automatically.");
        }
        const check = evaluation.photoCheck!;
        if (cardLanguageStatus(listing.title, [listing.aspects.Language, check.cardIdentity?.language]) === "OTHER") throw new EnglishOnlyError();
        const mode = getGradingMode(check);
        evaluation.gradingMode = mode.mode; evaluation.modeReasons.push(...mode.reasons);
        const hasUsableFront = check.images.some(image => image.view === "FRONT" && image.usable && !image.isStockImage);
        const isVisibleRawCopy = check.cardCount === "ONE" && check.holder !== "GRADED_SLAB" && hasUsableFront;
        if (evaluation.condition && isVisibleRawCopy) {
            // Insufficient detail for numeric grading need not erase obvious
            // raw wear, such as a crease. Structural/identity/slab checks stay
            // independent, and the original paid reading remains unchanged.
            const source = mode.mode === "BLOCKED" ? { ...evaluation.condition, gradeRange: null } : evaluation.condition;
            const condition = applyConditionRules(source, mode.mode, { closeUps: hasCloseUps(check), photoCount: listing.images.length });
            evaluation.condition = mode.mode === "BLOCKED" && condition?.rawCondition === "UNKNOWN" ? null : condition;
            if (mode.mode === "BLOCKED" && evaluation.condition) evaluation.modeReasons.push("The photos support a raw-condition assessment; numeric grading remains unavailable.");
        } else evaluation.condition = null;
        evaluation.gradeStatus = evaluation.condition?.gradeRange ? "ESTIMATED" : evaluation.condition ? "RAW_CONDITION_ONLY" : check.holder === "GRADED_SLAB" ? "CERTIFIED_SLAB" : "UNKNOWN_PHOTO_EVIDENCE";
        signal.throwIfAborted();
        if (check.cardCount !== "ONE" || !hasUsableFront) return finish();
        const card = check.cardIdentity;
        const aspects = { ...listing.aspects };
        if (card?.confidence === "HIGH") for (const [field, value] of [["Card Name", card.name], ["Set", card.set], ["Card Number", card.cardNumber], ["Language", card.language], ["Finish", card.finish === "UNKNOWN" ? null : card.finish]]) if (value && !aspects[field!]) aspects[field!] = value;
        let hardFailure: Error | null = null;
        const guarded = async <T>(work: () => Promise<T>): Promise<T> => { signal.throwIfAborted(); try { return await work(); } catch (error) { const stop = stopFailure(error); if (stop) hardFailure = stop; throw error; } };
        const identified = await deps.identify({ ...listing, aspects }, check, { lookupCards: query => guarded(() => deps.lookup(query)),
            ...(legacyResolution?.confirmation ? { photoIdentity: legacyResolution.confirmation } : {}) });
        if (hardFailure) throw hardFailure;
        evaluation.identity = identified.identity;
        if (legacyResolution?.finishConflict) {
            evaluation.identity.finish = "CONFLICTING"; evaluation.identity.status = "NEEDS_REVIEW";
            evaluation.identity.reasons.push("Saved independent photo readings disagree about this card's finish.");
        }
        if (cardLanguageStatus(listing.title, [identified.identity.language]) === "OTHER") throw new EnglishOnlyError();
        if (check.cardMatch?.verdict === "MISMATCH" && !evaluation.identity.notThisCard && !legacyResolution?.confirmation) {
            evaluation.identity.status = "NEEDS_REVIEW"; evaluation.identity.notThisCard = check.cardMatch.problems.join("; ") || "The photographed card differs from the listing.";
            evaluation.identity.reasons.push(evaluation.identity.notThisCard);
        }
        if (!canReuseLegacy && (!card?.name || !card.set || !card.cardNumber || !card.evidence.length || card.confidence === "LOW" || cardLanguageStatus("", [card.language]) !== "ENGLISH")) {
            evaluation.identity.status = "NEEDS_REVIEW";
            evaluation.identity.reasons.push("The bounded photos do not establish the exact English card identity. Seller wording alone cannot confirm it.");
        }
        if (check.cardCount !== "ONE" || !readyForPricing(evaluation.identity)) return finish();
        const identity = evaluation.identity;
        const unavailable = (error: unknown) => { const stop = stopFailure(error); if (stop) throw stop; return { status: "PRICE_UNAVAILABLE" as const, reason: "Matching market evidence is currently unavailable. Saved photo evidence is retained." }; };
        if (check.holder === "GRADED_SLAB") {
            evaluation.slab = checkSlab(check, listing.aspects);
            if (evaluation.slab.status === "OK") try {
                evaluation.slabPricing = await compsForGrade(identified.card, identity, { grader: evaluation.slab.grader!, grade: evaluation.slab.grade!,
                    fetchComps: (...args) => guarded(() => deps.fetchComps(...args)), checkComps: (...args) => guarded(() => deps.compChecks(...args)) });
            } catch (error) { evaluation.slabPricing = unavailable(error); }
        } else {
            const condition = evaluation.condition;
            if (!condition || condition.rawCondition === "UNKNOWN" && !condition.gradeRange) return finish();
            const cachedSoldCondition = async (sale: Comp) => {
                const parsed = parseListingLink(sale.listing_url); if (!parsed) return null;
                const oldDetails = await guarded(() => deps.cached<ListingDetails>(listingCacheKey(parsed.itemId), 24 * 30));
                if (!oldDetails?.images.length) return null;
                const target = JSON.stringify([identity.name, identity.set, identity.cardNumber, identity.printing, identity.finish]);
                const photos = [...new Set(oldDetails.images)].filter(Boolean).slice(0, 24);
                const key = `sold-condition:v${CONDITION_RULES_VERSION}:${VISION_MODEL}:${target}:${JSON.stringify(photos)}`;
                const saved = await guarded(() => deps.cached<{ primary: SoldConditionReading; corroboration?: SoldConditionReading } | SoldConditionReading>(key, 24 * 365));
                const first = saved && ("primary" in saved ? saved.primary : saved);
                return first ? acceptedSoldCondition(first, identity, photos.length) ?? (saved && "corroboration" in saved && saved.corroboration ? corroboratedSoldCondition(first, saved.corroboration, identity, photos.length) : null) : null;
            };
            if (condition.rawCondition !== "UNKNOWN") evaluation.rawPricing = await rawPricesWithSales(identified.card, identity, { fetchRawComps: (...args) => guarded(() => deps.fetchRawComps(...args)), assessCondition: cachedSoldCondition, signal, now: deps.now() });
            if (hardFailure) throw hardFailure;
            if (evaluation.rawPricing?.conditionEvidence === "AI_PHOTOS") evaluation.rawPricing.evidenceNote = `${evaluation.rawPricing.reviewedSoldCopies ?? 0} sold copies reused accepted saved photo-condition evidence. No historical listing photos or new sold-copy AI reviews were requested. Conditions without three matched sales use a labeled market fallback.`;
            if (evaluation.condition) {
                evaluation.gradedPricing = {};
                for (const grader of GRADERS) try {
                    evaluation.gradedPricing[grader] = await gradedPricesFor(identified.card, identity, evaluation.condition.gradeRange, { grader, now: deps.now(),
                        fetchComps: (...args) => guarded(() => deps.fetchComps(...args)), checkComps: (...args) => guarded(() => deps.compChecks(...args)) });
                } catch (error) { evaluation.gradedPricing[grader] = unavailable(error); }
            }
            if (!evaluation.rawPricing && condition.rawCondition !== "UNKNOWN") evaluation.rawPricing = rawPricesFor(identified.card, identity);
        }
        signal.throwIfAborted();
        evaluation.pricesCheckedAt = new Date(deps.now()).toISOString();
        return finish();
    }, options.signal);
}
export const evaluateBoundedListing = createBoundedEvaluator();
