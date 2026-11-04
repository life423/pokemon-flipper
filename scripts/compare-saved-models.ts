// Explicit diagnostic only: no production routing, model defaults or budgets change.
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { buildBoundedAssessmentRequest } from "../server/ai/bounded-assessment.ts";
import { boundedAssessmentPlan } from "../server/analysis/bounded-plan.ts";
import { validateBoundedReading } from "../server/analysis/bounded-evaluate.ts";
import { buildStampExperiment, validateStampFinding } from "../server/ai/focused-printing-experiment.ts";
import { createModelExperimentRunner, type ExperimentRequest } from "../server/analysis/model-experiment.ts";
import { inlineEbayImage } from "../server/ai/image-fallback.ts";
import { runStructured } from "../server/ai/openai.ts";
import { withAiUsageContext } from "../server/ai/usage-context.ts";
import { aiSpending } from "../server/ai/spending.ts";
import { readCache } from "../server/lib/cache.ts";
import { assertSqlStorageReady, closeDatabase, storageBackend } from "../server/storage/index.ts";
import { createBenchmarkTransport } from "./review/benchmark-transport.ts";
import type { ListingDetails } from "../server/ebay/listings.ts";
import type { PhotoCheck } from "../shared/types.ts";
import { checkSlab, normalizeSlabReading } from "../server/identity/slab-check.ts";
import { psaBaseLabelPrinting } from "../server/identity/card-identity.ts";
import { writeJsonAtomic } from "../server/lib/atomic-json.ts";
import { DATA_DIR } from "../server/lib/paths.ts";

interface ImageFile { number: number; url: string; localFile?: string; sha256?: string }
export interface ComparisonCase {
    caseId: string; listingId: string; originalSearchId: string; listingDetails: ListingDetails; sourceImages: ImageFile[];
    baseline: { derivedAcceptedCacheKey: string; savedPhotoCheck: PhotoCheck; sourceFile: string; jsonPointer: string; model?: string;
        requestTelemetry: { searchId: string; listingId: string; status: number; at: string; model: string; inputHash: string }[] };
    manualLabels: Record<string, unknown> & { holder?: string; resolvableFields?: string[] };
    crops: { label: string; sourcePhotoNumber: number; sourceFile: string; sourceSha256: string; file: string; sha256: string; box: number[] }[];
    experimentAdmission: { searchId: string; useOriginalSearchOnly: boolean };
}
export interface PreparedCase { caseId: string; kind: "SLAB_LABEL" | "STAMP"; images: Required<ImageFile>[]; crop?: { label: string; box: number[]; sourceSha256: string } }
interface Prepared { version: 1; manifestSha256: string; cases: PreparedCase[] }
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fingerprint = (value: unknown) => hash(JSON.stringify(value));
export function validateComparisonManifest(value: unknown): asserts value is { version: 1; cases: ComparisonCase[] } {
    const manifest = value as { version?: number; cases?: ComparisonCase[] } | null;
    if (manifest?.version !== 1 || !Array.isArray(manifest.cases) || manifest.cases.length < 1 || manifest.cases.length > 12 || new Set(manifest.cases.map(item => item.caseId)).size !== manifest.cases.length) throw new Error("Expected 1–12 distinct manually inspected comparison cases.");
    for (const item of manifest.cases) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(item.caseId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.originalSearchId) ||
            item.listingDetails?.id !== item.listingId || !item.experimentAdmission?.useOriginalSearchOnly || item.experimentAdmission.searchId !== item.originalSearchId ||
            !item.baseline?.derivedAcceptedCacheKey || !item.baseline.savedPhotoCheck || !item.baseline.sourceFile || typeof item.baseline.jsonPointer !== "string" ||
            !Array.isArray(item.baseline.requestTelemetry) || !item.baseline.requestTelemetry.some(row => row.searchId === item.originalSearchId && row.listingId === item.listingId && row.status === 200 && typeof row.model === "string" && /^[a-f0-9]{64}$/.test(row.inputHash) && Number.isFinite(Date.parse(row.at)))) throw new Error("Each case needs its own original paid listing/search history and saved photo baseline; new or borrowed search IDs are not allowed.");
    }
}
export async function prepareComparisonInputs(file: string, cases: ComparisonCase[], manifestSha256: string, options: {
    replay: boolean; signal?: AbortSignal; prepare(item: ComparisonCase): Promise<PreparedCase>; validate(item: ComparisonCase, input: PreparedCase): Promise<void>;
}): Promise<Prepared> {
    let prepared: Prepared;
    try { prepared = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || options.replay) throw error; prepared = { version: 1, manifestSha256, cases: [] }; }
    if (prepared.version !== 1 || prepared.manifestSha256 !== manifestSha256 || !Array.isArray(prepared.cases) || new Set(prepared.cases.map(item => item.caseId)).size !== prepared.cases.length || prepared.cases.some(item => !cases.some(source => source.caseId === item.caseId))) throw new Error("Prepared inputs do not match this inspected manifest.");
    if (options.replay && prepared.cases.length !== cases.length) throw new Error("Replay requires complete prepared inputs; no photo download is authorized.");
    for (const item of cases) {
        options.signal?.throwIfAborted();
        const previous = prepared.cases.find(input => input.caseId === item.caseId);
        if (previous) { await options.validate(item, previous); continue; }
        const input = await options.prepare(item); await options.validate(item, input);
        prepared.cases.push(input); await writeJsonAtomic(file, prepared);
    }
    return prepared;
}
export function compareManualFields(item: ComparisonCase, result: unknown, kind: PreparedCase["kind"], normalized = false) {
    const value = result as { photoCheck?: PhotoCheck; stamp?: string }, check = value.photoCheck;
    const slab = normalized ? normalizeSlabReading(check?.slab) : check?.slab;
    const observed: Record<string, unknown> = check ? { ...check.cardIdentity, holder: check.holder, ...slab, ...check.printingMarks } : { firstEditionStamp: value.stamp };
    return (kind === "STAMP" ? ["firstEditionStamp"] : item.manualLabels.resolvableFields ?? []).map(field => {
        const expected = item.manualLabels[field], actual = observed[field], measured = field !== "gradeLabel" && actual !== undefined;
        const normal = (entry: unknown) => entry === null ? null : String(entry).normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
        const cardNumber = (entry: unknown) => normal(entry)?.replace(/\b0+(?=\d)/g, "");
        return { field, expected, actual: measured ? actual : null, measurement: measured ? "MEASURED" : "UNMEASURED", matches: !measured ? null : (field === "cardNumber" ? cardNumber(actual) === cardNumber(expected) : normal(actual) === normal(expected)) };
    });
}

export async function compareSavedModels(args = process.argv.slice(2)) {
    const live = args.includes("--live"), replay = args.includes("--replay");
    if (args.includes("--help")) {
        process.stdout.write("Use exactly one of --live or --replay; optional --manifest <manual-photo-manifest.json>. Original search budgets are retained. Replay requires prepared local inputs and saved experiment answers.\n");
        return;
    }
    if (live === replay || args.some((arg, index) => !["--live", "--replay", "--manifest"].includes(arg) && args[index - 1] !== "--manifest")) throw new Error("Choose exactly one of --live or --replay, with optional --manifest <file>.");
    const manifestArg = args.indexOf("--manifest");
    if (manifestArg >= 0 && (!args[manifestArg + 1] || args[manifestArg + 1].startsWith("--"))) throw new Error("--manifest requires a file path.");
    const manifestFile = path.resolve(manifestArg < 0 ? "data/model-comparison/2026-11-03/manual-photo-manifest.json" : args[manifestArg + 1]);
    if (!manifestFile.startsWith(path.resolve("data/model-comparison") + path.sep)) throw new Error("Comparison manifests and reports must stay inside ignored data/model-comparison/.");
    const manifestBytes = await fs.readFile(manifestFile), manifest: unknown = JSON.parse(manifestBytes.toString());
    validateComparisonManifest(manifest);
    const preparedFile = path.join(path.dirname(manifestFile), `${path.basename(manifestFile, ".json")}.prepared-inputs.json`);
    const directory = path.join(path.dirname(manifestFile), "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${live ? "live" : "replay"}`);
    await fs.mkdir(directory, { recursive: true });
    const stopped = new AbortController();
    const stop = () => stopped.abort(new Error("Comparison stopped; no additional cases or paid dispatches will start."));
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    const context = new AsyncLocalStorage<{ searchId: string; listingId: string; phase: string }>();
    const originalFetch = globalThis.fetch;
    const observer = createBenchmarkTransport({ live, fetch: originalFetch, context: () => context.getStore() ?? {}, allowAzureAuth: true,
        limits: { ebayBrowse: 0, prices: 0, aiGeneration: manifest.cases.length, aiPreflight: manifest.cases.length } });
    globalThis.fetch = observer.fetch;
    const runModelExperiment = createModelExperimentRunner({ run: request => {
        if (!live) throw new Error("Replay cache miss: no generation, preflight or spending reservation is authorized.");
        return runStructured({ ...request, dispatchSignal: AbortSignal.any([request.dispatchSignal, stopped.signal]) });
    } });
    const report: { [key: string]: unknown; cases: Record<string, unknown>[] } = { startedAt: new Date().toISOString(), mode: live ? "live" : "replay",
        manifestFile, manifestSha256: hash(manifestBytes), preparedFile, productionAnswersChanged: false,
        limitation: "Historical inline image bytes were not retained. Saved URL/claim baselines and current verified original bytes are distinguished; identical historical image bytes are not proven.", cases: [] };
    const acceptedBefore = new Map<string, string>();
    const acceptedPresence = new Map<string, boolean>();
    const searchIds = [...new Set(manifest.cases.map(item => item.originalSearchId))];
    const snapshot = async () => Object.fromEntries(await Promise.all(searchIds.map(async id => [id, await aiSpending.summary(id)])));
    async function checkpoint() {
        report.transport = observer.snapshot();
        await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
        await fs.writeFile(path.join(directory, "transports.json"), JSON.stringify(observer.records, null, 2) + "\n");
    }
    async function verified(file: string, expected: string): Promise<Buffer> {
        if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("A prepared image needs its recorded SHA-256.");
        const bytes = await fs.readFile(file);
        if (bytes.length > 8 * 1024 * 1024 || hash(bytes) !== expected) throw new Error(`Image content changed: ${file}`);
        return bytes;
    }
    function dataUrl(bytes: Buffer): string {
        const mime = bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg" : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
            : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : null;
        if (!mime) throw new Error("Prepared photos must contain JPEG, PNG or WebP bytes.");
        return `data:${mime};base64,${bytes.toString("base64")}`;
    }
    async function prepareCase(item: ComparisonCase): Promise<PreparedCase> {
        const slab = item.manualLabels.holder === "GRADED_SLAB";
        if (!slab) {
            const crop = item.crops.find(value => value.label === "stamp-region");
            if (!crop) throw new Error(`Missing inspected stamp crop: ${item.caseId}`);
            await verified(crop.sourceFile, crop.sourceSha256); await verified(crop.file, crop.sha256);
            return { caseId: item.caseId, kind: "STAMP", crop: { label: crop.label, box: crop.box, sourceSha256: crop.sourceSha256 },
                images: [{ number: crop.sourcePhotoNumber, url: item.listingDetails.images[crop.sourcePhotoNumber - 1], localFile: crop.file, sha256: crop.sha256 }] };
        }
        const plan = boundedAssessmentPlan(item.listingDetails);
        if (plan.mode !== "SLAB_LABEL") throw new Error(`Saved slab does not select the existing label route: ${item.caseId}`);
        const images: Required<ImageFile>[] = [];
        for (const photo of plan.photos) {
            const source = item.sourceImages.find(value => value.number === photo.number && value.url === photo.url);
            if (!source) throw new Error("The selected listing photo is absent from the source manifest.");
            if (source.localFile && source.sha256) { await verified(source.localFile, source.sha256); images.push(source as Required<ImageFile>); continue; }
            if (!live || photo.number !== 2) throw new Error("Only a missing selected slab photo 2 may be downloaded in live mode.");
            const localFile = path.join(path.dirname(manifestFile), "source-photos", `${item.caseId}-photo${photo.number}.bin`), receipt = `${localFile}.json`;
            let retained: Required<ImageFile> | null = null;
            try { retained = JSON.parse(await fs.readFile(receipt, "utf8")); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                try { await fs.access(localFile); throw new Error("An existing photo without a retained hash must be supplied explicitly in the manifest; it will not be downloaded again."); }
                catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing; }
            }
            if (retained) {
                if (retained.number !== photo.number || retained.url !== photo.url || retained.localFile !== localFile) throw new Error("Retained photo provenance changed.");
                try { await verified(localFile, retained.sha256); images.push(retained); continue; }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            }
            const encoded = await inlineEbayImage(photo.url, stopped.signal);
            const bytes = Buffer.from(encoded.slice(encoded.indexOf(",") + 1), "base64");
            if (retained && retained.sha256 !== hash(bytes)) throw new Error("The original photo changed while resuming its interrupted preparation.");
            const entry = retained ?? { number: photo.number, url: photo.url, localFile, sha256: hash(bytes) };
            await fs.mkdir(path.dirname(localFile), { recursive: true }); await writeJsonAtomic(receipt, entry);
            await fs.writeFile(localFile, bytes, { flag: "wx" }); images.push(entry);
        }
        return { caseId: item.caseId, kind: "SLAB_LABEL", images };
    }
    async function validatePrepared(item: ComparisonCase, input: PreparedCase) {
        const slab = item.manualLabels.holder === "GRADED_SLAB", plan = boundedAssessmentPlan(item.listingDetails);
        if (input.kind !== (slab ? "SLAB_LABEL" : "STAMP")) throw new Error("Prepared route differs from the inspected manifest.");
        const crop = !slab ? item.crops.find(value => value.label === "stamp-region") : undefined;
        const expected = slab ? plan.photos : [{ number: crop!.sourcePhotoNumber, url: item.listingDetails.images[crop!.sourcePhotoNumber - 1] }];
        if (slab && plan.mode !== "SLAB_LABEL" || input.images.length !== expected.length || input.images.some((image, index) => image.number !== expected[index].number || image.url !== expected[index].url)) throw new Error("Prepared photo order or source URLs changed.");
        for (const image of input.images) {
            const source = item.sourceImages.find(value => value.number === image.number && value.url === image.url);
            if (!source) throw new Error("Prepared photo has no matching source record.");
            if (source.localFile && source.sha256) await verified(source.localFile, source.sha256);
            if (slab && source.sha256 && image.sha256 !== source.sha256) throw new Error("Prepared original photo hash changed.");
        }
        if (crop) {
            await verified(crop.sourceFile, crop.sourceSha256); await verified(crop.file, crop.sha256);
            if (input.images[0].sha256 !== crop.sha256 || fingerprint(input.crop) !== fingerprint({ label: crop.label, box: crop.box, sourceSha256: crop.sourceSha256 })) throw new Error("Prepared crop provenance changed.");
        }
    }
    try {
        if (live && storageBackend() !== "azure-sql") throw new Error("Live comparisons require Azure SQL dispatch claims; file storage is not supported.");
        if (live) await assertSqlStorageReady();
        const budgets = await snapshot(); report.budgetsBefore = budgets;
        const histories = new Map<string, Record<string, unknown>[]>(), historyChecks: Record<string, unknown>[] = [];
        for (const item of manifest.cases) {
            if (budgets[item.originalSearchId].attempts < 1) throw new Error("The original paid search account is missing; a comparison cannot create a replacement allowance.");
            const rows = item.baseline.requestTelemetry.filter(row => row.searchId === item.originalSearchId && row.listingId === item.listingId && row.status === 200);
            let paid = false;
            for (const row of rows) {
                const day = new Date(row.at).toISOString().slice(0, 10);
                if (!histories.has(day)) histories.set(day, (await fs.readFile(path.join(DATA_DIR, "ai-usage", `${day}.ndjson`), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line)));
                if (histories.get(day)!.some(event => event.searchId === row.searchId && event.listingId === row.listingId && event.inputHash === row.inputHash && event.model === row.model && event.status === 200)) paid = true;
            }
            let baseline: any = JSON.parse(await fs.readFile(item.baseline.sourceFile, "utf8"));
            for (const segment of item.baseline.jsonPointer.split("/").slice(1)) baseline = baseline?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
            if (!paid || fingerprint(baseline?.photoCheck ?? baseline) !== fingerprint(item.baseline.savedPhotoCheck)) throw new Error("The saved photo baseline or its original paid request history could not be verified.");
            historyChecks.push({ caseId: item.caseId, paidHistoryVerified: true, savedPhotoBaselineVerified: true, originalAccountAttempts: budgets[item.originalSearchId].attempts });
            const saved = await readCache(item.baseline.derivedAcceptedCacheKey, Infinity);
            acceptedBefore.set(item.baseline.derivedAcceptedCacheKey, fingerprint(saved));
            acceptedPresence.set(item.baseline.derivedAcceptedCacheKey, saved !== null);
        }
        report.baselineHistoryChecks = historyChecks;
        report.acceptedFingerprintsBefore = Object.fromEntries(acceptedBefore);
        const prepared = await prepareComparisonInputs(preparedFile, manifest.cases, hash(manifestBytes), { replay, signal: stopped.signal, validate: validatePrepared,
            prepare: item => context.run({ searchId: item.originalSearchId, listingId: item.listingId, phase: "prepare" }, () => prepareCase(item)) });
        report.preparedInputsSha256 = hash(await fs.readFile(preparedFile));
        for (const item of manifest.cases) {
            if (stopped.signal.aborted) break;
            const record: Record<string, unknown> = { caseId: item.caseId, listingId: item.listingId, originalSearchId: item.originalSearchId, baselineTelemetry: item.baseline.requestTelemetry };
            report.cases.push(record); const start = performance.now();
            try {
                const input = prepared.cases.find(value => value.caseId === item.caseId);
                if (!input) throw new Error("Prepared case is missing.");
                await validatePrepared(item, input);
                const photos = await Promise.all(input.images.map(async photo => ({ url: dataUrl(await verified(photo.localFile, photo.sha256)), label: `Listing photo ${photo.number}${input.crop ? `; ${input.crop.label} native-pixel crop ${JSON.stringify(input.crop.box)}` : ""}` })));
                const plan = boundedAssessmentPlan(item.listingDetails);
                const request: ExperimentRequest = input.kind === "SLAB_LABEL" ? { ...buildBoundedAssessmentRequest(item.listingDetails, plan.photos, "SLAB_LABEL"), photos }
                    : buildStampExperiment(photos, { firstEditionStamp: item.baseline.savedPhotoCheck.printingMarks?.firstEditionStamp });
                const model = input.kind === "SLAB_LABEL" ? "gpt-6-luna" : "gpt-5.6-terra";
                const sourceKey = `${item.baseline.derivedAcceptedCacheKey}:baseline-photo-check:${fingerprint(item.baseline.savedPhotoCheck)}`;
                const before = await aiSpending.summary(item.originalSearchId);
                record.model = model; record.kind = input.kind; record.images = input.images; record.crop = input.crop; record.sourceKey = sourceKey; record.requestHash = fingerprint(request); record.budgetBefore = before;
                const answer = await context.run({ searchId: item.originalSearchId, listingId: item.listingId, phase: "experiment" }, () => withAiUsageContext({ searchId: item.originalSearchId, listingId: item.listingId }, () => runModelExperiment({
                    sourceKey, model, request,
                    validate: value => input.kind === "SLAB_LABEL" ? validateBoundedReading(value, photos.length, "SLAB_LABEL") : validateStampFinding(value, photos.length),
                })));
                Object.assign(record, answer, { comparisons: compareManualFields(item, answer.result, input.kind),
                    normalizedComparisons: compareManualFields(item, answer.result, input.kind, true), status: "COMPLETE" });
                if ("photoCheck" in answer.result) {
                    const check = answer.result.photoCheck;
                    // Preserve the raw transcription above. Assess its practical
                    // consequence through existing pure rules, without price calls.
                    record.slabInterpretation = { ...checkSlab(check, item.listingDetails.aspects),
                        labelPrinting: check.cardIdentity ? psaBaseLabelPrinting(check.slab, check.cardIdentity) : null };
                }
            } catch (error) { record.status = "BLOCKED_OR_FAILED"; record.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
            finally {
                const after = await aiSpending.summary(item.originalSearchId), before = record.budgetBefore as typeof after | undefined;
                record.budgetAfter = after; record.elapsedMs = Math.round(performance.now() - start);
                if (before) record.costDelta = { settledUsd: Number((after.settledUsd - before.settledUsd).toFixed(9)), heldUsd: Number((after.heldUsd - before.heldUsd).toFixed(9)), attempts: after.attempts - before.attempts };
                await checkpoint();
            }
        }
    } catch (error) { report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
    finally {
        // The runner receives dispatch cancellation, not an abortable consumer. An
        // accepted response finishes saving before this sequential loop closes SQL.
        try {
            report.budgetsAfter = await snapshot();
            const sources = await Promise.all([...acceptedBefore.keys()].map(async key => [key, await readCache(key, Infinity)] as const));
            const after = Object.fromEntries(sources.map(([key, saved]) => [key, fingerprint(saved)]));
            report.acceptedFingerprintsAfter = after;
            report.sourceCacheChecks = sources.map(([key, saved]) => ({ key, presentBefore: acceptedPresence.get(key), presentAfter: saved !== null, unchanged: after[key] === acceptedBefore.get(key) }));
            if ([...acceptedBefore].some(([key, expected]) => after[key] !== expected)) { report.productionAnswersChanged = true; throw new Error("Accepted production photo evidence changed during this comparison."); }
            observer.assertNoBlock();
        } catch (error) { report.verificationError = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
        report.completedAt = new Date().toISOString(); report.stopped = stopped.signal.aborted;
        if (stopped.signal.aborted) process.exitCode = 1;
        try { await checkpoint(); }
        finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); globalThis.fetch = originalFetch; await closeDatabase(); }
    }
    process.stdout.write(JSON.stringify({ report: path.join(directory, "report.json"), preparedInputs: preparedFile, cases: report.cases.map(item => ({ caseId: item.caseId, status: item.status, costDelta: item.costDelta })) }, null, 2) + "\n");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await compareSavedModels();
