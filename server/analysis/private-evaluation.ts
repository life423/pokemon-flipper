import { createHash } from "node:crypto";
import { checkBaseSetRelease } from "./base-set-release.ts";
import { currentReleaseReading, withReleaseEvidence } from "../../shared/base-set-release.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { readCache, writeCache } from "../lib/cache.ts";
import { DATA_DIR } from "../lib/paths.ts";
import { getSqlRepositories, localOwner, storageBackend, StorageUnavailableError } from "../storage/index.ts";
import { readyForPricing } from "../../shared/identity.ts";
import { normalizedPhoto } from "../../shared/listing-evidence.ts";
import { observedCardKind } from "../../shared/photo-evidence.ts";
import { printingClaimFromAspects } from "../identity/card-identity.ts";
import { isSearchDiagnosticId } from "./search-diagnostic-store.ts";
import type { SavedRecord } from "./types.ts";
import type { Evaluation } from "../../shared/types.ts";
import { loadSaved } from "./store.ts";

// This namespace is deliberately absent from the SQL public-cache allowlist:
// financial results belong to the owner, while photo facts remain shareable.
export const PRIVATE_EVALUATION_PREFIX = "private-evaluation:v1:";
export const EVALUATION_CLAIM_FIELDS = ["Card Name", "Character", "Set", "Card Number", "Language", "Finish", "Professional Grader", "Grade", "Certification Number", "Year Manufactured"];
export interface PrivateEvaluationSnapshot { version: 1; evidenceKey: string; contextKey: string; searchId?: string; budgetOwner?: string; evaluation: Evaluation }
export function evaluationContextKey(listing: { title: string; images: readonly string[]; aspects: Record<string, string> }): string {
    const input = [listing.title.trim(), listing.images.map(normalizedPhoto),
        EVALUATION_CLAIM_FIELDS.map(field => [field, listing.aspects[field] ?? null])];
    // Edition/Features/Printing can change identity without changing the paid
    // photo inputs. Keep their semantic claim in financial context only.
    const printing = printingClaimFromAspects(listing.aspects);
    if (printing !== "NOT_STATED") input.push(printing);
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
const keyFor = (id: string) => PRIVATE_EVALUATION_PREFIX + createHash("sha256").update(id).digest("hex");
function validate(value: unknown, itemId: string): PrivateEvaluationSnapshot {
    const entry = value as PrivateEvaluationSnapshot | null;
    const listing = entry?.evaluation?.listing;
    const amount = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0;
    if (!entry || entry.version !== 1 || typeof entry.evidenceKey !== "string" || !/^[a-f0-9]{64}$/.test(entry.contextKey) ||
        entry.searchId !== undefined && !isSearchDiagnosticId(entry.searchId) ||
        entry.budgetOwner !== undefined && !isSearchDiagnosticId(entry.budgetOwner) ||
        !listing || listing.id !== itemId || typeof listing.title !== "string" || !Array.isArray(listing.photos) || !listing.photos.every(photo => typeof photo === "string") ||
        !amount(listing.price) || !amount(listing.shipping) || typeof entry.evaluation.assessmentVersion !== "string" ||
        !Number.isSafeInteger(listing.photosInListing) || !Number.isSafeInteger(listing.photosAnalyzed) || listing.photosAnalyzed < 0 || listing.photosAnalyzed > listing.photosInListing) {
        throw new StorageUnavailableError("The saved private evaluation is invalid. It was kept; no replacement provider work was authorized.", { scope: "listing" });
    }
    return entry;
}
export function createPrivateEvaluationStore({ cached = readCache, save = writeCache } = {}) {
    return {
        async load(itemId: string): Promise<PrivateEvaluationSnapshot | null> {
            const value = await cached<PrivateEvaluationSnapshot>(keyFor(itemId), 24 * 30);
            return value === null ? null : structuredClone(validate(value, itemId));
        },
        async save(evaluation: Evaluation, context: Pick<PrivateEvaluationSnapshot, "evidenceKey" | "contextKey" | "searchId" | "budgetOwner">): Promise<void> {
            const entry: PrivateEvaluationSnapshot = { version: 1, ...context, evaluation: structuredClone(evaluation) };
            validate(entry, evaluation.listing.id);
            await save(keyFor(evaluation.listing.id), entry);
        },
    };
}
const privateEvaluationStore = createPrivateEvaluationStore();
async function applySavedRelease(evaluation: Evaluation) {
    const checked = await checkBaseSetRelease(evaluation);
    return currentReleaseReading(checked) ? withReleaseEvidence(checked) : checked;
}

export async function loadPrivateEvaluation(id: string) {
    const snapshot = await privateEvaluationStore.load(id);
    if (snapshot) snapshot.evaluation = await applySavedRelease(snapshot.evaluation);
    return snapshot;
}

interface HuntCardRow { listingId: string; card: string; cardSet: string; cardNumber: string }
const HUNT_HISTORY_MS = 30 * 86_400_000;
const FILE_INDEX_TTL_MS = 60_000;
const HUNT_INDEX_LIMIT = 1200;

function indexCard(value: Evaluation | undefined, savedAt: string | null, now: number) {
    const stamp = savedAt ? Date.parse(savedAt) : NaN;
    const identity = value?.identity;
    if (!(stamp <= now && now - stamp < HUNT_HISTORY_MS) || !value?.listing.id || !identity?.name ||
        !identity.set || !identity.cardNumber || !readyForPricing(identity) || !observedCardKind(value)) return null;
    return { listingId: value.listing.id, card: identity.name, cardSet: identity.set, cardNumber: identity.cardNumber, stamp };
}

// File storage is one installation's private scope. Index metadata is only a
// way to find saved listing IDs. The normal snapshot reader and transaction
// checks still verify each selected candidate before using it in a hunt.
export function createFileHuntCardIndex({
    cacheDirectory = path.join(DATA_DIR, "price-cache"), assessmentDirectory = path.join(DATA_DIR, "evaluations"),
    now = Date.now,
} = {}) {
    let cached: { at: number; rows: HuntCardRow[] } | undefined;
    let pending: Promise<HuntCardRow[]> | undefined;
    async function scan(directory: string, privateCache: boolean, at: number) {
        const files = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw new StorageUnavailableError("Saved market history could not be listed.", { cause: error });
        });
        const names = files.filter(file => file.isFile() && (privateCache ? /^[a-f0-9]{40}\.json$/.test(file.name) : file.name.endsWith(".json")));
        const result: NonNullable<ReturnType<typeof indexCard>>[] = [];
        // Cache-file names are hashes. Check the short envelope before reading
        // a full payload, with a bounded number of files open at a time.
        for (let offset = 0; offset < names.length; offset += 32) {
            const rows = await Promise.all(names.slice(offset, offset + 32).map(async ({ name }) => {
                try {
                    const file = path.join(directory, name);
                    if (!privateCache) {
                        const record = JSON.parse(await fs.readFile(file, "utf8")) as SavedRecord;
                        const evaluation = record.latestEvaluation?.evaluation;
                        if (!evaluation || evaluation.listing.id !== record.itemId || typeof record.version !== "string" ||
                            typeof record.photoFingerprint !== "string" || name !== record.itemId.replace(/[^A-Za-z0-9]/g, "_") + ".json") return null;
                        return indexCard(evaluation, evaluation.answeredAt, at);
                    }
                    const handle = await fs.open(file, "r");
                    try {
                        const prefix = Buffer.alloc(256);
                        const { bytesRead } = await handle.read(prefix, 0, prefix.length, null);
                        const header = prefix.toString("utf8", 0, bytesRead);
                        if (!header.includes(PRIVATE_EVALUATION_PREFIX) && !/"data"\s*:\s*\{\s*"version"\s*:\s*1\s*,\s*"evidenceKey"\s*:/.test(header)) return null;
                        const contents = Buffer.concat([prefix.subarray(0, bytesRead), await handle.readFile()]).toString("utf8");
                        const saved = JSON.parse(contents) as { key?: string; savedAt: string; data: PrivateEvaluationSnapshot };
                        const listingId = saved.data?.evaluation?.listing.id;
                        if (typeof listingId !== "string") return null;
                        const key = keyFor(listingId);
                        if (saved.key !== undefined && saved.key !== key || createHash("sha1").update(key).digest("hex") + ".json" !== name) return null;
                        return indexCard(validate(saved.data, listingId).evaluation, saved.savedAt, at);
                    } finally { await handle.close(); }
                } catch {
                    // This optional index cannot authorize replacement work.
                    // Explicit reads still fail closed on invalid saved records.
                    return null;
                }
            }));
            for (const row of rows) if (row) result.push(row);
        }
        return result;
    }
    return async (): Promise<HuntCardRow[]> => {
        const at = now();
        if (cached && at >= cached.at && at - cached.at < FILE_INDEX_TTL_MS) return cached.rows;
        pending ??= Promise.all([scan(assessmentDirectory, false, at), scan(cacheDirectory, true, at)]).then(([legacy, privateRows]) => {
            const byId = new Map([...legacy, ...privateRows].map(row => [row.listingId, row]));
            const rows = [...byId.values()].sort((a, b) => b.stamp - a.stamp || a.listingId.localeCompare(b.listingId))
                .slice(0, HUNT_INDEX_LIMIT).map(({ stamp: _stamp, ...row }) => row);
            cached = { at: now(), rows };
            return rows;
        }).finally(() => { pending = undefined; });
        return pending;
    };
}
const recentFileHuntCards = createFileHuntCardIndex();

export async function recentHuntCardIndex() {
    if (storageBackend() === "file") return recentFileHuntCards();
    const { getSqlExecutor } = await import("../storage/client.ts");
    // Project card identities before loading the larger private evaluations. This
    // also covers evaluated item links and purchases beyond the saved-search index.
    return (await getSqlExecutor()).query<HuntCardRow>(`
SELECT TOP (1200) JSON_VALUE(payload_json,'$.data.evaluation.listing.id') listingId,
    JSON_VALUE(payload_json,'$.data.evaluation.identity.name') card,JSON_VALUE(payload_json,'$.data.evaluation.identity.set') cardSet,
    JSON_VALUE(payload_json,'$.data.evaluation.identity.cardNumber') cardNumber
FROM dbo.ProviderCache WHERE owner_scope=@scope AND source='private-evaluation' AND cache_key LIKE 'private-evaluation:v1:%'
    AND saved_at >= DATEADD(day,-30,SYSUTCDATETIME()) AND JSON_VALUE(payload_json,'$.data.evaluation.identity.status')='IDENTIFIED'
ORDER BY saved_at DESC, cache_hash`, { scope: `owner:${localOwner()}` });
}

// Bounded reads of completed research for comparing markets. Legacy assessments
// keep financial data in the owner's latestEvaluation instead of the newer cache.
export async function readHuntEvaluations(ids: string[], now: number): Promise<Evaluation[]> {
    if (ids.length > 16) throw new RangeError("Market research reads at most 16 saved evaluations per batch.");
    if (storageBackend() === "file") {
        const read = async (id: string) => (await privateEvaluationStore.load(id))?.evaluation ?? (await loadSaved(id))?.latestEvaluation?.evaluation;
        const values = await Promise.all(ids.map(read));
        return Promise.all(values.filter((value, i): value is Evaluation => value?.listing?.id === ids[i]).map(applySavedRelease));
    }
    const repo = await getSqlRepositories();
    const keyed = new Map(ids.map(id => [keyFor(id), id]));
    const entries = await repo.readCacheEntries([...keyed.keys()]);
    const values = new Map<string, Evaluation>();
    for (const entry of entries) {
        const id = keyed.get(entry.key)!;
        const age = now - Date.parse(entry.savedAt);
        if (age >= 0 && age < 30 * 86400_000) values.set(id, validate(entry.data, id).evaluation);
    }
    const older = await repo.readAssessmentRecords(ids.filter(id => !values.has(id)));
    for (const row of older) {
        const value = row.record.latestEvaluation?.evaluation;
        if (value?.listing?.id === row.itemId) values.set(row.itemId, value);
    }
    return Promise.all(ids.flatMap(id => values.has(id) ? [applySavedRelease(values.get(id)!)] : []));
}
