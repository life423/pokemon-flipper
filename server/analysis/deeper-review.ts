import { createHash } from "node:crypto";
import { ANALYSIS_VERSION } from "../ai/openai.ts";
import { reviewPhotosDeeper, type DeeperAnswer } from "../ai/deeper-photo-review.ts";
import { createSingleFlight } from "../lib/single-flight.ts";
import { loadSaved, saveRecord, photoFingerprint } from "./store.ts";
import { applyConditionRules, applyPhotoCheckRules, getGradingMode, hasCloseUps } from "./rules.ts";
import { planDeeperPhotos } from "../../shared/photo-review.ts";
import type { DeeperPhotoReview } from "../../shared/types.ts";
import type { SavedRecord } from "./types.ts";

const DEEP_VERSION = "focused-photos-1";
export class PhotoReviewError extends Error {
    constructor(message: string, readonly status = 409) { super(message); }
}
export function photoReviewKey(record: SavedRecord): string {
    return createHash("sha256").update(JSON.stringify([DEEP_VERSION, record.version, record.photoFingerprint, record.reviewContext?.title, record.photoCheck?.result, record.assessment?.result])).digest("hex");
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

export function createDeeperPhotoReviewer({ load = loadSaved, save = saveRecord, review = reviewPhotosDeeper, now = () => new Date().toISOString() } = {}) {
    const share = createSingleFlight();
    const retryAfter = new Map<string, number>();
    // If disk storage fails after a paid answer, retry the write without paying
    // again. Bound this temporary recovery cache; successful writes remove it.
    const unsaved = new Map<string, DeeperPhotoReview>();
    return (itemId: string, expectedKey: string): Promise<DeeperPhotoReview> => share(`${itemId}:${expectedKey}`, async () => {
        const record = await load(itemId);
        if (!record?.photoCheck || !record.reviewContext || record.version !== ANALYSIS_VERSION || photoFingerprint(record.reviewContext.photos) !== record.photoFingerprint || photoReviewKey(record) !== expectedKey) {
            throw new PhotoReviewError("The photos or saved assessment changed. Reopen the listing before requesting a deeper review.");
        }
        if (record.deeperPhotoReview?.inputKey === expectedKey) {
            unsaved.delete(expectedKey);
            return record.deeperPhotoReview;
        }
        const checked = applyPhotoCheckRules(record.photoCheck.result, record.reviewContext.photos.length);
        const plan = planDeeperPhotos(checked, record.reviewContext.photos);
        if (!plan.photos.length) throw new PhotoReviewError(plan.reason!, 422);
        const { mode } = getGradingMode(checked);
        const condition = mode !== "BLOCKED" && record.assessment
            ? applyConditionRules(record.assessment.result, mode, { closeUps: hasCloseUps(checked) }) : null;
        let deeperPhotoReview = unsaved.get(expectedKey);
        if (!deeperPhotoReview) {
            if ((retryAfter.get(expectedKey) ?? 0) > Date.now()) throw new PhotoReviewError("Wait 30 seconds before retrying this paid review. Your previous assessment is unchanged.", 429);
            try {
                const result = await review({ title: record.reviewContext.title, photos: plan.photos, photoCheck: checked, condition });
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
}
export const reviewListingPhotos = createDeeperPhotoReviewer();
