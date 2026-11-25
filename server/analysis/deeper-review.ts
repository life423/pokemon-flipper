import { createHash } from "node:crypto";
import { ANALYSIS_VERSION } from "./legacy-evidence.ts";
import { reviewPhotosDeeper, type DeeperAnswer } from "../ai/deeper-photo-review.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { withAiUsageContext } from "../ai/usage-context.ts";
import { loadSaved, saveRecord, photoFingerprint, withAssessmentLock } from "./store.ts";
import { applyConditionRules, applyPhotoCheckRules, getGradingMode, hasCloseUps } from "./rules.ts";
import { planDeeperPhotos } from "../../shared/photo-review.ts";
import { normalizedPhoto } from "../../shared/listing-evidence.ts";
import { hasSlabEvidence } from "../../shared/photo-evidence.ts";
import type { DeeperPhotoReview, Evaluation } from "../../shared/types.ts";
import type { SavedRecord } from "./types.ts";
import { reconcileIdentityReadings } from "./resolve-evidence.ts";
import { cardLanguageStatus } from "../../shared/card-language.ts";
import { loadPrivateEvaluation } from "./private-evaluation.ts";
import { StorageUnavailableError } from "../storage/index.ts";

const DEEP_VERSION = "focused-photos-1";
export class PhotoReviewError extends Error {
    constructor(message: string, readonly status = 409) { super(message); }
}
export function photoReviewKey(record: SavedRecord): string {
    return createHash("sha256").update(JSON.stringify([DEEP_VERSION, record.version, record.photoFingerprint, record.reviewContext?.title, record.photoCheck?.result, record.assessment?.result, record.identityPasses?.map(pass => pass.result) ?? null])).digest("hex");
}

export function cleanDeeperAnswer(answer: DeeperAnswer, numbers: number[]): DeeperAnswer {
    const fail = () => { throw new PhotoReviewError("The AI returned an incomplete photo review. Your previous assessment is unchanged.", 502); };
    if (!answer || typeof answer.summary !== "string" || !answer.summary.trim() || !Array.isArray(answer.findings) || !answer.findings.length || answer.findings.length > 12 || !Array.isArray(answer.requestedPhotos) || answer.requestedPhotos.length > 6) return fail();
    const findings = answer.findings.map((finding) => {
        if (!finding || !["IDENTITY", "CENTERING", "CORNERS", "EDGES", "SURFACE", "PHOTO_QUALITY"].includes(finding.area) || !["NEW_CONCERN", "SUPPORTS_PRIOR", "UNRESOLVED"].includes(finding.impact) || typeof finding.observation !== "string" || !finding.observation.trim() || !Array.isArray(finding.photoNumbers) || !finding.photoNumbers.length || finding.photoNumbers.some((n) => !Number.isInteger(n) || n < 1 || n > numbers.length)) return fail();
        return { area: finding.area, impact: finding.impact, observation: finding.observation.trim().slice(0, 800), photoNumbers: [...new Set(finding.photoNumbers.map((n) => numbers[n - 1]))] };
    });
    if (answer.requestedPhotos.some((photo) => typeof photo !== "string" || !photo.trim())) return fail();
    return { summary: answer.summary.trim().slice(0, 1600), findings, requestedPhotos: [...new Set(answer.requestedPhotos.map((photo) => photo.trim().slice(0, 400)))] };
}

function boundedReviewPlan(evaluation: Evaluation) {
    const { listing, photoCheck, condition, assessmentVersion, answeredAt } = evaluation;
    if (!photoCheck || !assessmentVersion || !answeredAt || evaluation.frontPhotoStop || hasSlabEvidence(evaluation) || listing.availability === "UNAVAILABLE") return null;
    const { photos } = planDeeperPhotos(photoCheck, listing.photos ?? []);
    if (!photos.length) return null;
    const key = createHash("sha256").update(JSON.stringify([
        DEEP_VERSION, "bounded", listing.id, listing.title, assessmentVersion, answeredAt,
        photos.map(({ number, view, url }) => [number, view, normalizedPhoto(url)]), photoCheck, condition,
    ])).digest("hex");
    return { key, input: { title: listing.title, photos, photoCheck, condition } };
}

// Owner-scoped evidence is keyed independently of the latest valuation. An
// in-flight photo review must never overwrite newer market data or photos.
const cacheKey = (key: string) => `private-deeper-photo:v1:${key}`;
interface AcceptedReview {
    key: string;
    reviewedAt: string;
    answer: DeeperAnswer;
    usage: DeeperPhotoReview["usage"];
}

async function loadAcceptedReview(key: string, cached: typeof readCache): Promise<AcceptedReview | null> {
    const record = await cached<AcceptedReview>(cacheKey(key), Infinity);
    if (record === null) return null;
    const tokens = (count: unknown) => count === null || typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
    if (!record || record.key !== key || !Number.isFinite(Date.parse(record.reviewedAt)) ||
        !Object.hasOwn(record, "answer") || !record.usage || !tokens(record.usage.inputTokens) || !tokens(record.usage.outputTokens)) {
        throw new StorageUnavailableError("Saved deeper photo evidence is invalid.");
    }
    return record;
}

function completeReview(record: AcceptedReview, photos: { number: number }[]): DeeperPhotoReview {
    const photoNumbers = photos.map(photo => photo.number);
    return { ...cleanDeeperAnswer(record.answer, photoNumbers), inputKey: record.key, reviewedAt: record.reviewedAt, photoNumbers, usage: record.usage };
}

export async function restoreBoundedPhotoReview(evaluation: Evaluation, searchId: string | undefined, cached = readCache): Promise<Evaluation> {
    const plan = boundedReviewPlan(evaluation);
    if (!plan) return evaluation;
    const accepted = await loadAcceptedReview(plan.key, cached);
    let review = evaluation.deeperPhotoReview?.inputKey === evaluation.photoReviewKey ? evaluation.deeperPhotoReview : undefined;
    if (accepted) {
        try { review = completeReview(accepted, plan.input.photos); }
        catch (error) {
            // Keep an accepted but incomplete reply for deduplication. The
            // underlying assessment remains useful and keeps its own verdict.
            if (!(error instanceof PhotoReviewError)) throw error;
        }
    }
    const key = review?.inputKey ?? (searchId || accepted ? plan.key : undefined);
    return { ...evaluation, photoReviewKey: key, deeperPhotoReview: review };
}

export function createDeeperPhotoReviewer({ load = loadSaved, save = saveRecord, loadPrivate = loadPrivateEvaluation,
    cached = readCache, cache = writeCache, review = reviewPhotosDeeper, now = () => new Date().toISOString() } = {}) {
    const share = createSharedWork();
    const retryAfter = new Map<string, number>();
    // If disk storage fails after a paid answer, retry the write without paying
    // again. Bound this temporary recovery cache; successful writes remove it.
    const unsaved = new Map<string, DeeperPhotoReview>();
    const pending = new Map<string, AcceptedReview>();
    const changed = () => new PhotoReviewError("The photos or saved assessment changed. Reopen the listing before requesting a deeper review.");
    const runBounded = async (itemId: string, expectedKey: string, signal: AbortSignal) => {
        const snapshot = await loadPrivate(itemId);
        signal.throwIfAborted();
        if (!snapshot) return null;
        const plan = boundedReviewPlan(snapshot.evaluation);
        if (!plan || plan.key !== expectedKey || snapshot.evaluation.photoReviewKey !== expectedKey) {
            const previous = snapshot.evaluation.deeperPhotoReview;
            if (previous?.inputKey === expectedKey) return previous;
            throw changed();
        }
        let accepted = await loadAcceptedReview(expectedKey, cached);
        signal.throwIfAborted();
        if (!accepted) {
            accepted = pending.get(expectedKey) ?? null;
            if (!accepted) {
                if (!snapshot.searchId) throw new PhotoReviewError("This assessment needs its original search before a deeper review can run.");
                if ((retryAfter.get(expectedKey) ?? 0) > Date.now()) throw new PhotoReviewError("Wait 30 seconds before retrying this paid review. Your previous assessment is unchanged.", 429);
                const result = await withAiUsageContext({ searchId: snapshot.searchId, listingId: itemId }, () => review(plan.input, signal))
                    .catch(error => {
                        if (!signal.aborted) retryAfter.set(expectedKey, Date.now() + 30_000);
                        throw error;
                    });
                retryAfter.delete(expectedKey);
                accepted = { key: expectedKey, reviewedAt: now(), answer: result.result, usage: result.usage };
                if (pending.size >= 32) pending.delete(pending.keys().next().value!);
                pending.set(expectedKey, accepted);
            }
            // Let dispatched work save even when the caller has stopped waiting.
            await cache(cacheKey(expectedKey), accepted);
            pending.delete(expectedKey);
        }
        const latest = await loadPrivate(itemId);
        if (!latest || latest.evaluation.photoReviewKey !== expectedKey || boundedReviewPlan(latest.evaluation)?.key !== expectedKey) throw changed();
        return completeReview(accepted, plan.input.photos);
    };
    const runLegacy = (itemId: string, expectedKey: string, workSignal: AbortSignal) => withAssessmentLock(itemId, async () => {
        workSignal.throwIfAborted();
        const record = await load(itemId);
        workSignal.throwIfAborted();
        if (!record?.photoCheck || !record.reviewContext || record.version !== ANALYSIS_VERSION || photoFingerprint(record.reviewContext.photos) !== record.photoFingerprint || photoReviewKey(record) !== expectedKey) {
            throw changed();
        }
        if (record.deeperPhotoReview?.inputKey === expectedKey) {
            unsaved.delete(expectedKey);
            return record.deeperPhotoReview;
        }
        const original = applyPhotoCheckRules(record.photoCheck.result, record.reviewContext.photos.length);
        const checked = record.identityPasses?.length ? reconcileIdentityReadings(original, record.identityPasses.map(pass => pass.result)).check : original;
        if (cardLanguageStatus(record.reviewContext.title, [checked.cardIdentity?.language]) === "OTHER") throw new PhotoReviewError("Deeper review currently supports English cards only.", 422);
        const plan = planDeeperPhotos(checked, record.reviewContext.photos);
        if (!plan.photos.length) throw new PhotoReviewError(plan.reason!, 422);
        const { mode } = getGradingMode(checked);
        const condition = mode !== "BLOCKED" && record.assessment
            ? applyConditionRules(record.assessment.result, mode, { closeUps: hasCloseUps(checked), photoCount: record.assessment.photoNumbers.length }) : null;
        let deeperPhotoReview = unsaved.get(expectedKey);
        if (!deeperPhotoReview) {
            if ((retryAfter.get(expectedKey) ?? 0) > Date.now()) throw new PhotoReviewError("Wait 30 seconds before retrying this paid review. Your previous assessment is unchanged.", 429);
            try {
                const result = await review({ title: record.reviewContext.title, photos: plan.photos, photoCheck: checked, condition }, workSignal);
                const answer = cleanDeeperAnswer(result.result, plan.photos.map((photo) => photo.number));
                deeperPhotoReview = { ...answer, inputKey: expectedKey, reviewedAt: now(), photoNumbers: plan.photos.map((photo) => photo.number), usage: result.usage };
            } catch (error) {
                retryAfter.set(expectedKey, Date.now() + 30_000);
                throw error;
            }
            retryAfter.delete(expectedKey);
            if (unsaved.size >= 32) unsaved.delete(unsaved.keys().next().value!);
            unsaved.set(expectedKey, deeperPhotoReview);
        }
        // A concurrent full reanalysis must not be overwritten by a stale review.
        const latest = await load(itemId);
        if (!latest || photoReviewKey(latest) !== expectedKey) {
            unsaved.delete(expectedKey);
            throw new PhotoReviewError("The underlying assessment changed while the review ran. Your newer assessment was kept.");
        }
        await save(itemId, { ...latest, deeperPhotoReview });
        unsaved.delete(expectedKey);
        return deeperPhotoReview;
    });
    return (itemId: string, expectedKey: string, signal?: AbortSignal): Promise<DeeperPhotoReview> => share(`${itemId}:${expectedKey}`, async workSignal => {
        return await runBounded(itemId, expectedKey, workSignal) ?? runLegacy(itemId, expectedKey, workSignal);
    }, signal);
}
export const reviewListingPhotos = createDeeperPhotoReviewer();
