import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { CONDITION_AREAS, isRawCondition } from "../../shared/conditions.ts";
import type { CameraGradeResult } from "../../shared/camera-grade.ts";
import { gradesFromWear, photoCoverage } from "../../shared/photo-evidence.ts";
import { buildBoundedAssessmentRequest, type BoundedReading } from "../ai/bounded-assessment.ts";
import { runStructured } from "../ai/openai.ts";
import { withAiUsageContext } from "../ai/usage-context.ts";
import { AiSpendingError, aiSpendingFailure } from "../ai/spending.ts";
import { isAiCreditFailure } from "../ai/errors.ts";
import { requireLiveProvider } from "../lib/saved-provider-evidence.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { withFileLease } from "../lib/file-lease.ts";
import { DATA_DIR } from "../lib/paths.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { checkSlab } from "../identity/slab-check.ts";
import { localOwner, StorageUnavailableError } from "../storage/config.ts";
import { BOUNDED_ASSESSMENT_VERSION, BOUNDED_CONDITION_VERSION, type BoundedPhoto } from "./bounded-plan.ts";
import { validateBoundedReading } from "./bounded-reading.ts";
import { applyConditionRules, applyPhotoCheckRules, getGradingMode, hasCloseUps } from "./rules.ts";

const MAX_BYTES = 3 * 1024 * 1024;
const decode = createLimiter(2);
const unique = (notes: string[]) => [...new Set(notes.map(note => note.trim()).filter(Boolean))];
export class CameraInputError extends Error {}

async function normalizePhoto(input: unknown, side: string): Promise<Buffer> {
    const invalid = () => new CameraInputError(`Choose a readable JPEG, PNG or WebP for the ${side} photo (up to 3 MB).`);
    if (typeof input !== "string" || input.length > 4 * Math.ceil(MAX_BYTES / 3) + 32) throw invalid();
    const header = /^data:image\/(jpeg|png|webp);base64,/.exec(input);
    if (!header) throw invalid();
    const encoded = input.slice(header[0].length);
    if (!encoded || encoded.length % 4 || /[^a-zA-Z0-9+/=]/.test(encoded)) throw invalid();
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > MAX_BYTES || bytes.toString("base64") !== encoded) throw invalid();
    // Check a raster signature before passing untrusted content to a decoder.
    const format = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? "jpeg"
        : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
        : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
    if (format !== header[1]) throw invalid();
    return decode(async () => {
        try {
            const image = sharp(bytes, { failOn: "warning", limitInputPixels: 20_000_000 });
            const info = await image.metadata();
            if (info.format !== format || (info.pages ?? 1) !== 1) throw invalid();
            if (Math.min(info.width, info.height) < 180 || Math.max(info.width, info.height) < 400)
                throw new CameraInputError(`Retake the ${side} photo closer and in focus so the card's edges are visible.`);
            // Honor phone orientation and strip EXIF (including location) before dispatch.
            return await image.rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
                .flatten({ background: "white" }).jpeg({ quality: 90 }).toBuffer();
        } catch (error) { if (error instanceof CameraInputError) throw error; throw invalid(); }
    });
}

function cameraResult(reading: BoundedReading, count: number): CameraGradeResult {
    const check = applyPhotoCheckRules(reading.photoCheck, count);
    const cardName = check.cardIdentity?.name?.trim() || check.printedName?.trim() || null;
    const retake = (guidance: string[]): CameraGradeResult => ({
        status: "retake", cardName, grade: null, condition: null, confidence: "LOW", observations: [], guidance: unique(guidance),
    });
    if (check.cardCount !== "ONE" || check.cardMatch?.verdict !== "MATCH" || !cardName)
        return retake(["Photograph one Pokémon card on its own. Include its name and all four corners.", ...(check.cardMatch?.problems ?? [])]);
    if (check.holder === "GRADED_SLAB" || check.slab?.present) {
        const slab = checkSlab(check);
        if (!slab.grade || !slab.grader || !slab.labelText?.trim() || !check.images.some(p => p.view === "FRONT" && p.usable && !p.isStockImage))
            return retake(["Retake the full front of the slab with its grading company and grade in focus."]);
        return { status: "slab", cardName, grade: Number(slab.grade), condition: null,
            confidence: slab.status === "OK" ? "HIGH" : "LOW",
            observations: [`Label reads ${slab.grader} ${slab.grade}${slab.gradeQualifier ? " " + slab.gradeQualifier : ""}.`],
            guidance: unique([...slab.reasons, ...slab.concerns]) };
    }
    const coverage = photoCoverage(check);
    const guidance: string[] = [];
    if (!coverage.clearFronts) guidance.push("Retake the whole front in even light with all four corners in focus.");
    if (!coverage.clearBacks) guidance.push("Retake the whole back in even light with the blue edges and all four corners in focus.");
    if (guidance.length) return retake([...guidance, ...check.images.flatMap(photo => photo.issues), ...check.missingViews]);

    const mode = getGradingMode(check);
    const condition = reading.condition && applyConditionRules(reading.condition, mode.mode, { closeUps: hasCloseUps(check), photoCount: count });
    if (mode.mode === "BLOCKED" || !condition)
        return retake([...check.missingViews, "Retake the card against a contrasting matte background with the edges and surface in focus."]);
    if (condition.authenticity.concern !== "NONE_SEEN" || !isRawCondition(condition.rawCondition))
        return retake([...condition.authenticity.reasons, ...condition.limitations, "Add a close, tilted surface photo showing texture and wear."]);
    const range = condition.gradeRange;
    const wear = isRawCondition(condition.rawCondition) ? gradesFromWear[condition.rawCondition] : null;
    // A confirmed crease or a condition-only reading uses the existing low-confidence wear reference.
    const point = range?.likely && range.high - range.low <= 2 && !(condition.creases === "PRESENT" && wear && range.likely > wear.high) ? range.likely : null;
    const grade = point ?? wear?.likely;
    if (!grade) return retake([...condition.limitations, "Add a close, tilted surface photo showing texture and wear."]);
    const observations = unique([...(condition.creases === "PRESENT" ? ["A crease is visible on the card."] : []),
        ...CONDITION_AREAS.flatMap(area => condition[area].observations)]);
    return { status: "graded", cardName, grade, condition: condition.rawCondition,
        confidence: !point ? "LOW" : condition.confidence === "HIGH" ? "HIGH" : condition.confidence === "MEDIUM" ? "MEDIUM" : "LOW",
        observations: observations.length ? observations : [condition.summary],
        guidance: unique([...(point ? [] : ["This grade is a rough estimate from the visible play condition."]), ...condition.limitations, ...check.missingViews]) };
}

async function assess(photos: BoundedPhoto[], signal: AbortSignal) {
    if (!process.env.OPENAI_API_KEY?.trim()) throw new AiSpendingError("AI_PAUSED", "Configure the OpenAI API key to grade a new capture.");
    const request = buildBoundedAssessmentRequest(null, photos);
    return (await runStructured<BoundedReading>({ ...request, dispatchSignal: signal })).result;
}

export function createCameraGrader({ read = readCache, save = writeCache, review = assess } = {}) {
    const share = createSharedWork();
    const unsaved = new Map<string, BoundedReading>();
    return async function grade(body: unknown, signal?: AbortSignal): Promise<CameraGradeResult> {
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new CameraInputError("Choose a front and a back photo.");
        const input = body as Record<string, unknown>;
        const sides = input.tilted === undefined ? ["front", "back"] : ["front", "back", "tilted"];
        const photos: BoundedPhoto[] = [];
        const hashes = new Set<string>();
        for (const side of sides) {
            signal?.throwIfAborted();
            const jpeg = await normalizePhoto(input[side], side);
            const hash = createHash("sha256").update(jpeg).digest("hex");
            if (hashes.has(hash)) throw new CameraInputError("Choose a different photo for each view of the card.");
            hashes.add(hash);
            photos.push({ number: photos.length + 1, url: "data:image/jpeg;base64," + jpeg.toString("base64") });
        }
        const digest = createHash("sha256").update(JSON.stringify([localOwner(), BOUNDED_ASSESSMENT_VERSION, BOUNDED_CONDITION_VERSION, ...hashes])).digest("hex");
        const key = "private-camera-grade:v1:" + digest;
        return share(key, async workSignal => {
            // Claim under the shared file lease, then release it BEFORE provider work.
            const lock = path.join(DATA_DIR, "camera-claims", digest);
            let reading = await withFileLease(lock, async () => {
                const recovered = unsaved.get(key);
                if (recovered) {
                    await save(key, { reading: recovered });
                    unsaved.delete(key);
                    return recovered;
                }
                const saved = await read<{ state: string } | { reading: BoundedReading }>(key, Infinity);
                if (saved && typeof saved === "object" && "reading" in saved && saved.reading) return saved.reading;
                if (saved !== null && !(saved && typeof saved === "object" && "state" in saved && saved.state === "retry"))
                    throw new StorageUnavailableError("This camera assessment is in progress or has an incomplete saved result. A duplicate paid review is blocked.");
                requireLiveProvider("OPENAI"); workSignal.throwIfAborted();
                await save(key, { state: "pending" });
                return null;
            }, { signal: workSignal, timeoutError: () => new StorageUnavailableError("The camera assessment is busy. Try these photos again.") });
            if (!reading) {
                // A retry of this capture always uses the same spending account.
                const searchId = [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32)].join("-");
                if (workSignal.aborted) {
                    await save(key, { state: "retry" });
                    workSignal.throwIfAborted();
                }
                try {
                    reading = await withAiUsageContext({ searchId, listingId: "camera-grade" }, () => review(photos, workSignal));
                } catch (error) {
                    // runStructured can surface cancellation AFTER transport. Only a definite refusal reopens a started claim.
                    const refusal = (failure: unknown) => [400, 401, 403, 429].includes((failure as { status?: number })?.status ?? 0);
                    if (aiSpendingFailure(error) || isAiCreditFailure(error) || refusal(error) || refusal((error as Error)?.cause))
                        await save(key, { state: "retry" });
                    throw error;
                }
                // Save the accepted answer before interpretation. A failed validation must not buy it again.
                unsaved.set(key, reading);
                await save(key, { reading });
                unsaved.delete(key);
            }
            return cameraResult(validateBoundedReading(reading, photos.length, "CAMERA"), photos.length);
        }, signal);
    };
}

export const gradeCameraCard = createCameraGrader();
