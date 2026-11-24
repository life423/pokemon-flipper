import { createHash } from "node:crypto";
import { readCache, writeCache } from "../lib/cache.ts";
import { getSqlRepositories, localOwner, storageBackend, StorageUnavailableError } from "../storage/index.ts";
import { normalizedPhoto } from "../../shared/listing-evidence.ts";
import { printingClaimFromAspects } from "../identity/card-identity.ts";
import { isSearchDiagnosticId } from "./search-diagnostic-store.ts";
import type { Evaluation } from "../../shared/types.ts";
import { loadSaved } from "./store.ts";

// This namespace is deliberately absent from the SQL public-cache allowlist:
// financial results belong to the owner, while photo facts remain shareable.
export const PRIVATE_EVALUATION_PREFIX = "private-evaluation:v1:";
export const EVALUATION_CLAIM_FIELDS = ["Card Name", "Character", "Set", "Card Number", "Language", "Finish", "Professional Grader", "Grade", "Certification Number", "Year Manufactured"];
export interface PrivateEvaluationSnapshot { version: 1; evidenceKey: string; contextKey: string; searchId?: string; evaluation: Evaluation }
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
        !listing || listing.id !== itemId || typeof listing.title !== "string" || !Array.isArray(listing.photos) || !listing.photos.every(photo => typeof photo === "string") ||
        !amount(listing.price) || !amount(listing.shipping) || typeof entry.evaluation.assessmentVersion !== "string" ||
        !Number.isSafeInteger(listing.photosInListing) || !Number.isSafeInteger(listing.photosAnalyzed) || listing.photosAnalyzed < 0 || listing.photosAnalyzed > listing.photosInListing) {
        throw new StorageUnavailableError("The saved private evaluation is invalid. It was kept; no replacement provider work was authorized.");
    }
    return entry;
}
export function createPrivateEvaluationStore({ cached = readCache, save = writeCache } = {}) {
    return {
        async load(itemId: string): Promise<PrivateEvaluationSnapshot | null> {
            const value = await cached<PrivateEvaluationSnapshot>(keyFor(itemId), 24 * 30);
            return value === null ? null : structuredClone(validate(value, itemId));
        },
        async save(evaluation: Evaluation, context: Pick<PrivateEvaluationSnapshot, "evidenceKey" | "contextKey" | "searchId">): Promise<void> {
            const entry: PrivateEvaluationSnapshot = { version: 1, ...context, evaluation: structuredClone(evaluation) };
            validate(entry, evaluation.listing.id);
            await save(keyFor(evaluation.listing.id), entry);
        },
    };
}
const privateEvaluationStore = createPrivateEvaluationStore();
export const loadPrivateEvaluation = privateEvaluationStore.load;

export async function recentHuntCardIndex() {
    if (storageBackend() !== "azure-sql") return [];
    const { getSqlExecutor } = await import("../storage/client.ts");
    // Project card identities before loading the larger private evaluations. This
    // also covers evaluated item links and purchases beyond the saved-search index.
    return (await getSqlExecutor()).query<{ listingId: string; card: string; cardSet: string; cardNumber: string }>(`
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
        const read = async (id: string) => (await loadPrivateEvaluation(id))?.evaluation ?? (await loadSaved(id))?.latestEvaluation?.evaluation;
        const values = await Promise.all(ids.map(read));
        return values.filter((value, i): value is Evaluation => value?.listing?.id === ids[i]);
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
    return ids.flatMap(id => values.has(id) ? [values.get(id)!] : []);
}
